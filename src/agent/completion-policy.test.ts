import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FinalAnswerGuard, verifyWorkspaceGrounding, detectAnalysisOrInvestigationIntent, hasUnfulfilledDeferredPromise } from './final-answer-guard.js';
import { AcceptancePolicy } from '../control-plane/critic/acceptance-policy.js';
import { CompletionEvidenceGate } from './completion-evidence.js';
import { collectCompletionObservations, getTurnCompletionState } from './completion-observations.js';
import { buildCompletionRecoveryPrompt, selectFinalAnswer } from './completion-response.js';
import { createReportFindingsTool } from '../tools/report-findings.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { CriticGate } from './critic-gate.js';
import { AgentLoop } from './agent-loop.js';
import { ClassificationEngine } from '../control/classification-engine.js';
import { ToolRegistry } from '../tools/registry.js';

const diagnostics = { errors: [], syntaxErrors: [], unresolvedImports: [], warnings: [], timestamp: 0 };

function record(session: Session, turn: number, toolName: string, args: Record<string, any>, result: Record<string, any>): void {
  const toolCallId = `call-${session.getEvents().length}`;
  session.append('tool/call', { turn, step: 1, toolCallId, toolName, args });
  session.append('tool/result', { turn, step: 1, toolCallId, toolName, result });
}

test('read-only answers follow requested detail without word, heading, or language quotas', () => {
  const guard = new FinalAnswerGuard();
  for (const [userRequest, answer] of [
    ['Explain the architecture of this repo in one sentence.', 'AgentLoop coordinates tools and checks completion.'],
    ['Tại sao guard từ chối câu trả lời rỗng?', 'Vì evaluate() chặn chuỗi rỗng trước các bước khác.'],
    ['Giải thích ngắn gọn bằng tiếng Việt hàm này.', 'Hàm trả về true khi chuỗi rỗng.'],
    ['Investigate the root cause.', 'The inspected branch permits an empty token. The caller has not been inspected, so the root cause remains uncertain.'],
  ]) assert.equal(guard.evaluate(answer, { userRequest }).allow, true);
  assert.equal(detectAnalysisOrInvestigationIntent('Giải thích ngắn gọn bằng tiếng Việt hàm này.').isAnalysisQuery, false);
});

test('both guards agree on quotations, examples, proposals, and real deferred work', () => {
  const guard = new FinalAnswerGuard();
  const examples: Array<[string, boolean]> = [
    ['The rule rejects this example:\n> I will inspect the code.\nThat is a quoted status message.', true],
    ['Ví dụ: “Tôi sẽ chạy kiểm thử.” là câu trạng thái.', true],
    ['```ts\n// I will inspect the code\n```\nThe code contains a comment.', true],
    ['A proposed flow: the agent will inspect missing evidence, then produce an answer.', true],
    ['Đề xuất: agent sẽ kiểm tra phần dẫn chứng còn thiếu.', true],
    ['I will inspect the repository tomorrow.', false],
    ['Tôi sẽ kiểm tra mã rồi báo cáo.', false],
    ['Here is the result:\nI will inspect the repository tomorrow.', false],
    ['Tôi sẽ kiểm tra 3 commit. Dưới đây là kết quả:\n- abc123 Update guard\n- def456 Add tests', true],
    ['Fixed.', false],
    ['Đã cung cấp câu trả lời chi tiết về nguyên nhân.', false],
  ];
  for (const [answer, expected] of examples) {
    assert.equal(guard.evaluate(answer).allow, expected, answer);
    assert.equal(AcceptancePolicy.checkHardInvariants({ diagnostics, changedFiles: [], finalAnswerText: answer }).passed, expected, answer);
  }
  assert.equal(hasUnfulfilledDeferredPromise('Findings are ready. If you want, I will benchmark it.'), false);
});

test('citations support anchors and Markdown, reject mixed invalid claims, and allow proposed files', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-citations-'));
  try {
    await fs.mkdir(path.join(rootDir, 'src'));
    await fs.writeFile(path.join(rootDir, 'src/main.ts'), 'export const main = 1;');
    await fs.writeFile(path.join(rootDir, 'src/file with spaces.ts'), 'export {};');
    for (const citation of [
      'src/main.ts:1', '[entry](src/main.ts:1:3)', '[entry](src/main.ts#L1)',
      `[entry](${path.join(rootDir, 'src/main.ts').replace(/\\/g, '/')}:1)`,
      '[entry](<src/file with spaces.ts:1>)',
    ]) assert.equal(verifyWorkspaceGrounding(citation, { rootDir }).isGrounded, true, citation);
    const mixed = verifyWorkspaceGrounding('src/main.ts and src/missing.ts', { rootDir });
    assert.equal(mixed.isGrounded, false);
    assert.deepEqual(mixed.invalidFiles, ['src/missing.ts']);
    const context = { userRequest: 'Explain the architecture of this repo.', workspace: { rootDir } };
    assert.equal(new FinalAnswerGuard().evaluate('src/main.ts calls src/missing.ts.', context).allow, false);
    assert.equal(new FinalAnswerGuard().evaluate('Đề xuất: tạo src/new-policy.ts để tách trách nhiệm.', context).allow, true);
    assert.equal(new FinalAnswerGuard().evaluate('## Proposed design\nAdd src/new-policy.ts.\n## Current implementation\nsrc/main.ts exports main.', context).allow, true);
    assert.equal(new FinalAnswerGuard().evaluate('The entry symbol exports a constant.', context).allow, true);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('mutation evidence is turn scoped, outcome based, and includes patches and moves', () => {
  const session = new Session();
  record(session, 1, 'write_file', { path: 'old.ts' }, { success: true });
  record(session, 2, 'write_file', { path: 'failed.ts' }, { success: false, error: 'Denied' });
  record(session, 2, 'replace_text', { path: 'unchanged.ts' }, { success: true, changed: false });
  session.append('tool/call', { turn: 2, toolName: 'write_file', args: { path: 'attempt.ts' } });
  assert.deepEqual(getTurnCompletionState(session, 2).filesModified, []);
  assert.equal(getTurnCompletionState(session, 2).hasMutations, false);
  record(session, 2, 'apply_patch', {}, { success: true, filesModified: ['one.ts', 'two.ts'], filesDeleted: ['gone.ts'] });
  record(session, 2, 'move_file', { sourcePath: 'before.ts', targetPath: 'after.ts' }, { success: true, moved: true });
  assert.deepEqual(getTurnCompletionState(session, 2).filesModified.sort(), ['after.ts', 'before.ts', 'gone.ts', 'one.ts', 'two.ts']);
  assert.equal(getTurnCompletionState(session, 1).hasMutations, true);
  record(session, 3, 'git_diff', {}, { changedFiles: ['old.ts'] });
  record(session, 3, 'submit_solution', {}, { success: true, filesModified: ['old.ts'] });
  assert.equal(getTurnCompletionState(session, 3).hasMutations, false, 'describing a diff or submitting does not mutate code');
});

test('observations cannot pair a result with a call from another turn or reuse a call', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('tool/call', { toolCallId: 'old', toolName: 'write_file', args: { path: 'old.ts' } });
  session.append('turn/start', { turn: 2 });
  session.append('tool/result', { toolCallId: 'old', toolName: 'write_file', result: { success: true } });
  assert.equal(getTurnCompletionState(session, 2).hasMutations, false);
  record(session, 2, 'read_file', { path: 'main.ts' }, { content: 'export {}' });
  const last = session.getEvents().at(-1)!;
  session.append('tool/result', last.data);
  assert.equal(collectCompletionObservations(session, 2).length, 1);
});

test('read-only explanation passes evidence gate; execution claims still require matching observations', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();
  record(session, 1, 'read_file', { path: 'main.ts' }, { content: 'export {}' });
  assert.equal(gate.evaluate('The file exports no symbols.', session, { turn: 1 }).allow, true);
  for (const answer of ['I ran tests and they passed.', 'I committed the change.', 'I pushed the change.', 'I modified the code.']) {
    const decision = gate.evaluate(answer, session, { turn: 1 });
    assert.equal(decision.allow, false, answer);
    assert.equal(decision.recovery, 'revise-answer', answer);
  }
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['main.ts'] });
  assert.equal(gate.evaluate('Updated the export.', session, { turn: 1 }).recovery, 'verify-changes');
  record(session, 1, 'run_command', { command: 'npm test' }, { exitCode: 0 });
  assert.equal(gate.evaluate('I ran tests and they passed.', session, { turn: 1 }).allow, true);
  record(session, 1, 'write_file', { path: 'next.ts' }, { success: true });
  assert.equal(gate.evaluate('Updated next.ts.', session, { turn: 1 }).allow, false);
});

test('reports accept concise findings and uncertainty without inventing root causes or verification', async () => {
  const tool = createReportFindingsTool();
  assert.deepEqual((tool.parameters as any).required, ['userFacingReport']);
  const report = await tool.execute({ userFacingReport: 'The entry point is main().', uncertainties: ['Caller not inspected.'] }, new Workspace(process.cwd()));
  assert.equal(report.success, true);
  assert.equal(report.rootCause, undefined);
  assert.equal((await tool.execute({ userFacingReport: 'Done.' }, new Workspace(process.cwd()))).success, false);
  const session = new Session();
  record(session, 1, 'write_file', { path: 'main.ts' }, { success: true });
  record(session, 1, tool.name, {}, report);
  assert.equal(new CompletionEvidenceGate().evaluate('Updated main.ts.', session, { turn: 1 }).allow, false);
});

test('latest substantive answer wins; recovery instructions depend on what is missing', () => {
  const report = 'The earlier detailed report. '.repeat(20);
  assert.equal(selectFinalAnswer('Corrected: the caller is main().', report), 'Corrected: the caller is main().');
  assert.equal(selectFinalAnswer('', report), report.trim());
  assert.equal(selectFinalAnswer('Done.', report), report.trim());
  assert.match(buildCompletionRecoveryPrompt({ recovery: 'revise-answer' }), /No tool call is required/);
  assert.match(buildCompletionRecoveryPrompt({ recovery: 'inspect-evidence' }), /no code edit or test is required/);
  assert.match(buildCompletionRecoveryPrompt({ recovery: 'verify-changes' }), /verification appropriate to the actual changes/);
});

test('critic ignores old mutations and failed edit attempts on a read-only turn', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-critic-'));
  try {
    const workspace = new Workspace(rootDir);
    await fs.writeFile(path.join(rootDir, 'broken.ts'), 'const broken: number = "bad";');
    const session = new Session();
    record(session, 1, 'write_file', { path: 'broken.ts' }, { success: true });
    record(session, 2, 'write_file', { path: 'broken.ts' }, { success: false, error: 'Denied' });
    record(session, 2, 'read_file', { path: 'broken.ts' }, { content: 'const broken: number = "bad";' });
    const critic = new CriticGate();
    const params = { session, workspace, turn: 2, finalAnswer: 'The assigned string conflicts with the number annotation.' };
    assert.equal(critic.evaluate(params).approved, true);
    assert.equal((await critic.evaluateAsync(params)).approved, true);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

/** Does not contain "Mock": these integration tests exercise the production completion gates. */
class ScriptedCompletionLLM {
  calls = 0;
  prompts: string[] = [];
  constructor(private readonly replies: any[]) {}
  async generate(session: Session): Promise<any> {
    this.prompts.push(JSON.stringify(session.getHistory()));
    const reply = this.replies[this.calls++];
    assert.ok(reply, 'Unexpected extra model call');
    return reply;
  }
}

test('AgentLoop returns a concise answer directly without reporting or verification tools', async () => {
  assert.notEqual(process.env.NODE_ENV, 'test', 'This test must exercise real completion gates');
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-loop-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM([{ text: 'AgentLoop coordinates tools and completion.', toolCalls: [] }]);
    const session = new Session();
    session.addUserMessage('Explain the architecture in one sentence.');
    const loop = new AgentLoop(llm, new ToolRegistry(), { maxSteps: 3, workspace });
    assert.equal(await loop.run(session), 'AgentLoop coordinates tools and completion.');
    assert.equal(llm.calls, 1);
    assert.equal(session.getEvents().some((event) => event.type === 'tool/call'), false);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('AgentLoop repairs unsupported execution claims by rewriting without forcing a tool', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-recovery-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM([
      { text: 'I ran tests and they passed.', toolCalls: [] },
      { text: 'The explanation is based on source inspection; tests have not been run.', toolCalls: [] },
    ]);
    const session = new Session();
    session.addUserMessage('Explain the architecture briefly.');
    const loop = new AgentLoop(llm, new ToolRegistry(), { maxSteps: 4, workspace });
    assert.match(await loop.run(session), /tests have not been run/);
    assert.equal(llm.calls, 2);
    assert.match(llm.prompts[1], /No tool call is required/);
    assert.doesNotMatch(llm.prompts[1], /MANDATORY TOOL CALL REQUIRED/);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});


test('classification distinguishes proposed edits from authorized edits', () => {
  const classifier = new ClassificationEngine();
  for (const request of ['Suggest how to refactor the agent.', 'Explain why update() fails.', 'Đề xuất cách sửa guard.', 'Compare options to deploy the agent.', 'Review the code; do not edit files.']) {
    const decision = classifier.classify({ request });
    assert.equal(decision.taskClass, 'exploration', request);
    assert.equal(decision.requiredCapabilities.includes('edit'), false, request);
  }
  for (const request of ['Explain the bug and then fix it.', 'Analyze the guard and implement the change.', 'Phân tích rồi sửa guard.']) {
    assert.notEqual(classifier.classify({ request }).taskClass, 'exploration', request);
  }
  const mutated = classifier.classify({ request: 'Explain the code.', hasUnverifiedChanges: true });
  assert.equal(mutated.phase, 'verify');
});

test('a recorded report is a fallback, not a replacement for a newer answer', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-report-loop-'));
  try {
    const workspace = new Workspace(rootDir);
    const report = 'The entry point is main(). The remaining callers have not been inspected. '.repeat(5);
    for (const latest of ['The entry point is main().', '']) {
      const llm = new ScriptedCompletionLLM([
        { toolCalls: [{ name: 'report_investigation_findings', args: { userFacingReport: report } }] },
        { text: latest, toolCalls: [] },
      ]);
      const session = new Session();
      session.addUserMessage('Explain the entry point briefly.');
      const loop = new AgentLoop(llm, new ToolRegistry(), { maxSteps: 4, workspace });
      assert.equal(await loop.run(session), latest || report.trim());
      assert.equal(llm.calls, 2);
      assert.equal(session.getEvents().filter((event) => event.type === 'tool/call').length, 1);
    }
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('a recorded report cannot bypass evidence checks on an empty model response', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-report-evidence-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM([
      { toolCalls: [{ name: 'report_investigation_findings', args: { userFacingReport: 'I ran tests and they passed.' } }] },
      { text: '', toolCalls: [] },
      { text: 'Tests have not been run. The report contained an unsupported verification claim.', toolCalls: [] },
    ]);
    const session = new Session();
    session.addUserMessage('Explain the entry point briefly.');
    const loop = new AgentLoop(llm, new ToolRegistry(), { maxSteps: 5, workspace });
    assert.match(await loop.run(session), /^Tests have not been run/);
    assert.equal(llm.calls, 3);
    assert.match(llm.prompts[2], /No tool call is required/);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('a new read-only turn is independent of past mutations and verification skills', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-turn-loop-'));
  try {
    const workspace = new Workspace(rootDir);
    await fs.writeFile(path.join(rootDir, 'broken.ts'), 'const value: number = "bad";');
    const session = new Session();
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    record(session, 1, 'write_file', { path: 'broken.ts' }, { success: true });
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1 });
    session.recordSkillDecision({ skillId: 'verification-before-completion', version: '1.0.0', reason: 'Previous editing turn', timestamp: new Date().toISOString(), decision: 'activated' });
    session.addUserMessage('Explain why a string cannot be assigned to a number; read only.');
    const llm = new ScriptedCompletionLLM([{ text: 'The string conflicts with the declared number type.', toolCalls: [] }]);
    const loop = new AgentLoop(llm, new ToolRegistry(), { maxSteps: 3, workspace });
    assert.equal(await loop.run(session), 'The string conflicts with the declared number type.');
    assert.equal(llm.calls, 1);
    assert.equal(getTurnCompletionState(session, 2).hasMutations, false);
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('unresolved reasoning never becomes an unchecked final answer', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completion-reasoning-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM(Array.from({ length: 4 }, () => ({ reasoningContent: 'Internal analysis that has no final answer.', text: '', toolCalls: [] })));
    const session = new Session();
    session.addUserMessage('Explain the mechanism.');
    const loop = new AgentLoop(llm, new ToolRegistry(), { maxSteps: 6, workspace });
    const result = await loop.run(session);
    assert.match(result, /did not produce a user-facing answer/);
    assert.doesNotMatch(result, /Internal analysis/);
    assert.ok(session.getEvents().some((event) => event.type === 'turn/end' && event.data.reason === 'missing-final-answer'));
  } finally { await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
