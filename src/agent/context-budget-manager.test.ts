import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCompactor } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import { ContextGuardian } from '../context/context-guardian.js';
import { Session } from '../session/session.js';
import { isNativeAvailable, nativeCompactHistory } from '../native/index.js';
import { TurnMemoryRetriever } from '../context/turn-memory-retriever.js';
import { assertHistoryToolPairing } from '../session/session-invariants.js';

test('enforce mode compacts a recent oversized observation to the whole-request budget', async () => {
  const compactor = new ContextCompactor({
    maxTotalHistoryTokens: 1_200,
    preserveLastNToolResults: 3,
    enableRollingTurnCompaction: true,
  });
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce', triggerRatio: 0.5 });
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Inspect the generated output and report the result.' }] },
    { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'run_command', args: { command: 'npm test' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'run_command', response: { command: 'npm test', exitCode: 0, stdout: 'x'.repeat(20_000) } } }] },
  ];

  const result = await manager.prepareRequest({
    provider: 'test',
    model: 'gemini-test',
    systemPrompt: 'You are a coding agent.',
    tools: [],
    history,
    dynamicContext: '',
    maxInputTokens: 1_200,
    outputReserveTokens: 100,
  });

  assert.equal(result.failureReason, undefined);
  assert.equal(result.withinBudget, true);
  assert.equal(result.changed, true);
  assert(result.after.upperBoundTokens <= 1_100);
  assert(result.compactionStats?.strategiesApplied.includes('hard-budget-observation-stubs'));
  assert.deepEqual(result.state?.verification.map((item) => ({ command: item.command, status: item.status })), [
    { command: 'npm test', status: 'passed' },
  ]);
});

test('rolling synopsis is not recursively summarized', () => {
  const compactor = new ContextCompactor({
    maxTotalHistoryTokens: 8_000,
    preserveLastNTurns: 2,
    enableRollingTurnCompaction: true,
    enableObservationMasking: false,
  });
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Primary objective' }] },
    { role: 'model', parts: [{ text: 'Objective acknowledged' }] },
  ];
  for (let index = 1; index <= 6; index++) {
    history.push({ role: 'user', parts: [{ text: `Turn ${index} request` }] });
    history.push({ role: 'model', parts: [{ text: index === 1 ? 'Decision alpha and variable beta retained' : `Turn ${index} completed` }] });
  }

  const first = compactor.compact(history, { force: true, preserveLastNTurns: 2, enableRollingTurns: true });
  const second = compactor.compact(first.messages, { force: true, preserveLastNTurns: 2, enableRollingTurns: true });
  const firstText = JSON.stringify(first.messages);
  const secondText = JSON.stringify(second.messages);

  assert.match(firstText, /alpha and variable beta/);
  assert.match(secondText, /alpha and variable beta/);
  assert.equal((secondText.match(/ROLLING DIALOGUE SYNOPSIS/g) || []).length, 1);
});

test('native precompaction masks only large non-verification history', { skip: !isNativeAvailable() }, () => {
  const compactor = new ContextCompactor({
    nativePrecompactionThresholdChars: 1,
    preserveLastNToolResults: 1,
    enableObservationMasking: false,
  });
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Inspect the first large file.' }] },
    { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'read_file', args: { path: 'first.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'read-1', name: 'read_file', response: { content: 'a'.repeat(20_000) } } }] },
    { role: 'model', parts: [{ functionCall: { id: 'read-2', name: 'read_file', args: { path: 'second.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'read-2', name: 'read_file', response: { content: 'current result' } } }] },
  ];

  const result = compactor.compact(history, { force: true, enableRollingTurns: false });
  assert.ok(result.stats.strategiesApplied.includes('native-large-history-prepass'));
  assert.ok(JSON.stringify(result.messages).length < JSON.stringify(history).length);
  assert.equal(result.stats.maskedObservations?.length, 1);
  assert.equal(result.stats.maskedObservations?.[0].originalPayload.content.length, 20_000);
});

test('within-turn checkpoints archive old observations without rewriting the KV-cache prefix', async () => {
  const compactor = new ContextCompactor({
    checkpointEveryNToolResults: 4,
    preserveLastNToolResults: 2,
    preservePrefixCache: true,
  });
  const manager = new ContextBudgetManager(compactor, { mode: 'legacy', triggerRatio: 0.95 });
  const history: any[] = [{ role: 'user', parts: [{ text: 'Investigate the issue.' }] }];
  for (let index = 0; index < 4; index++) {
    history.push({ role: 'model', parts: [{ functionCall: { id: `read-${index}`, name: 'read_file', args: { path: `${index}.ts` } } }] });
    history.push({ role: 'user', parts: [{ functionResponse: { id: `read-${index}`, name: 'read_file', response: { path: `${index}.ts`, content: `evidence-${index}` } } }] });
  }

  const result = await manager.prepareRequest({
    provider: 'test', model: 'gemini-test', systemPrompt: 'system', tools: [], history,
    maxInputTokens: 20_000, outputReserveTokens: 100,
  });

  assert.equal(result.changed, false);
  assert.equal(result.history, history);
  assert.equal(result.checkpointObservations?.length, 2);
  assert.deepEqual(result.checkpointObservations?.map((record) => record.id), ['read-0', 'read-1']);
});

test('hard-budget stubs retain a recoverable copy of recent verification output', () => {
  const compactor = new ContextCompactor({ maxTotalHistoryTokens: 300 });
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Verify the build.' }] },
    { role: 'model', parts: [{ functionCall: { id: 'build', name: 'run_command', args: { command: 'npm run build' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'build', name: 'run_command', response: { command: 'npm run build', exitCode: 0, stdout: 'verified-output-'.repeat(2_000) } } }] },
  ];

  const result = compactor.compact(history, { force: true, enforceBudget: true, maxInputTokens: 300 });

  assert.ok(result.stats.strategiesApplied.includes('hard-budget-observation-stubs'));
  assert.equal(result.stats.maskedObservations?.[0].id, 'build');
  assert.match(result.stats.maskedObservations?.[0].originalPayload.stdout, /verified-output/);
});

test('enforce mode refuses an irreducible oversized pinned request', async () => {
  const compactor = new ContextCompactor({ maxTotalHistoryTokens: 500 });
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce', triggerRatio: 0.5 });
  const result = await manager.prepareRequest({
    provider: 'test',
    model: 'claude-test',
    systemPrompt: 'system',
    tools: [],
    history: [{ role: 'user', parts: [{ text: `Pinned request: ${'đ'.repeat(20_000)}` }] }],
    maxInputTokens: 500,
    outputReserveTokens: 50,
  });

  assert.equal(result.withinBudget, false);
  assert.equal(result.failureReason, 'CONTEXT_BUDGET_UNSATISFIABLE');
});

test('a missed proactive target does not become a false provider-budget failure', async () => {
  const compactor = new ContextCompactor({ maxTotalHistoryTokens: 10_000 });
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce', triggerRatio: 0.5 });
  const result = await manager.prepareRequest({
    provider: 'test',
    model: 'gpt-test',
    systemPrompt: 'system',
    tools: [],
    history: [{ role: 'user', parts: [{ text: `Pinned request: ${'x'.repeat(8_000)}` }] }],
    maxInputTokens: 10_000,
    targetInputTokens: 500,
    outputReserveTokens: 50,
  });

  assert.equal(result.compactionStats?.withinBudget, false);
  assert.equal(result.withinBudget, true);
  assert.equal(result.failureReason, undefined);
});

test('guardian never invents successful verification evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-guardian-evidence-'));
  try {
    const session = new Session('guardian-no-evidence');
    session.addUserMessage('Inspect the project without running tests.');
    const guardian = new ContextGuardian(root);
    const result = await guardian.protectPreCompaction(session);
    const activeContext = await fs.readFile(path.join(root, '.codingagent', 'ACTIVE_CONTEXT.md'), 'utf8');

    assert.equal(result.integrity.passed, false);
    assert(result.integrity.score < 100);
    assert.match(activeContext, /Unknown — no successful verification evidence recorded/);
    assert.doesNotMatch(activeContext, /All tests passing|100% green/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Bug 1 (Critical): native compact history preserves JSON Object response format for functionResponse', { skip: !isNativeAvailable() }, () => {
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Check big file' }] },
    { role: 'model', parts: [{ functionCall: { id: 'call-big', name: 'read_file', args: { path: 'big.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-big', name: 'read_file', response: { path: 'big.ts', content: 'z'.repeat(5_000) } } }] },
    { role: 'model', parts: [{ functionCall: { id: 'call-recent', name: 'read_file', args: { path: 'recent.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-recent', name: 'read_file', response: { path: 'recent.ts', content: 'recent' } } }] },
  ];

  const nativeResult = nativeCompactHistory(JSON.stringify(history), 10_000, 1, 100);
  assert.ok(nativeResult);
  assert.equal(nativeResult.maskedCount, 1);
  const messages = JSON.parse(nativeResult.compactedMessagesJson);
  const maskedResp = messages[2].parts[0].functionResponse.response;
  assert.equal(typeof maskedResp, 'object');
  assert.notEqual(maskedResp, null);
  assert.equal(Array.isArray(maskedResp), false);
  assert.equal(maskedResp.status, 'masked');
  assert.equal(maskedResp.path, 'big.ts');
  assert.match(maskedResp.observationMask, /minus_core Native Compactor/);
});

test('Bug 2 (High): native compact history turn pruning strictly preserves tool pairing invariants', { skip: !isNativeAvailable() }, () => {
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Turn 0: Task initialization' }] },
    { role: 'model', parts: [{ functionCall: { id: 't0', name: 'read_file', args: { path: 't0.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 't0', name: 'read_file', response: { content: 'ok0' } } }] },
    { role: 'user', parts: [{ text: 'Turn 1: Intermediate analysis' }] },
    { role: 'model', parts: [{ functionCall: { id: 't1', name: 'read_file', args: { path: 't1.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 't1', name: 'read_file', response: { content: 'ok1' } } }] },
    { role: 'user', parts: [{ text: 'Turn 2: Final response' }] },
    { role: 'model', parts: [{ functionCall: { id: 't2', name: 'read_file', args: { path: 't2.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 't2', name: 'read_file', response: { content: 'ok2' } } }] },
  ];

  // Set extreme maxTokens = 1 to force middle turn pruning
  const nativeResult = nativeCompactHistory(JSON.stringify(history), 1, 1, 1000);
  assert.ok(nativeResult);
  assert.ok(nativeResult.prunedCount > 0);
  const messages = JSON.parse(nativeResult.compactedMessagesJson);
  assert.doesNotThrow(() => {
    assertHistoryToolPairing(messages);
  });
});

test('Bug 3 (Medium-High): routine run_command with exitCode 0 is masked outside preserved window while keeping exitCode', () => {
  const compactor = new ContextCompactor({
    preserveLastNToolResults: 1,
    enableObservationMasking: true,
    maskOldObservationsBeyondN: 1,
  });

  const history: any[] = [
    { role: 'user', parts: [{ text: 'Start task' }] },
    { role: 'model', parts: [{ functionCall: { id: 'cmd-1', name: 'run_command', args: { command: 'echo hello' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'cmd-1', name: 'run_command', response: { command: 'echo hello', exitCode: 0, stdout: 'log '.repeat(500) } } }] },
    { role: 'model', parts: [{ functionCall: { id: 'cmd-2', name: 'run_command', args: { command: 'echo recent' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'cmd-2', name: 'run_command', response: { command: 'echo recent', exitCode: 0, stdout: 'recent output' } } }] },
  ];

  const result = compactor.compact(history, { force: true });
  const oldResp = (result.messages[2].parts[0] as any).functionResponse.response;
  assert.equal(oldResp.status, 'masked');
  assert.equal(oldResp.exitCode, 0);
  assert.match(oldResp.observationMask, /Lệnh thực thi thành công/);
});

test('Bug 4 (Medium): superseded state deduplication matches relative vs absolute and slash variants', () => {
  const compactor = new ContextCompactor({
    preserveLastNToolResults: 1,
    enableObservationMasking: true,
  });

  const relPath = 'src/components/button.tsx';
  const absPath = path.resolve(relPath);
  const winRelPath = relPath.replace(/\//g, '\\');

  const history: any[] = [
    { role: 'user', parts: [{ text: 'Read button component' }] },
    { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'view_file', args: { AbsolutePath: winRelPath } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'read-1', name: 'view_file', response: { path: winRelPath, content: 'export const Button = () => null;' } } }] },
    { role: 'model', parts: [{ functionCall: { id: 'read-2', name: 'view_file', args: { AbsolutePath: 'src/components/card.tsx' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'read-2', name: 'view_file', response: { path: 'src/components/card.tsx', content: 'export const Card = () => null;' } } }] },
  ];

  const result = compactor.compact(history, {
    force: true,
    mutatedFiles: [absPath], // mutatedFiles provides absolute path with system slashes
  });

  const resp = (result.messages[2].parts[0] as any).functionResponse.response;
  assert.equal(resp.status, 'superseded');
  assert.match(resp.observationMask, /SUPERSEDED BY RECENT MUTATION/);
});

test('Bug 5 (Low): rolling synopsis displays accurate turn range singular vs plural', () => {
  const compactor = new ContextCompactor({
    preserveLastNTurns: 1,
    enableRollingTurnCompaction: true,
  });

  // 3 user turns: Turn 0 + Turn 1 (pruned) + Turn 2 (preserved) -> totalArchivedTurns = 1
  const history3Turns: any[] = [
    { role: 'user', parts: [{ text: 'Turn 0 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 0 model' }] },
    { role: 'user', parts: [{ text: 'Turn 1 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 1 model' }] },
    { role: 'user', parts: [{ text: 'Turn 2 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 2 model' }] },
  ];

  const result1 = compactor.compact(history3Turns, { force: true, preserveLastNTurns: 1, enableRollingTurns: true });
  const synopsis1 = (result1.messages[2].parts[0] as any).text;
  assert.match(synopsis1, /\[ROLLING DIALOGUE SYNOPSIS - TURN 1 ARCHIVED\]/);

  // 4 user turns: Turn 0 + Turn 1,2 (pruned) + Turn 3 (preserved) -> totalArchivedTurns = 2
  const history4Turns: any[] = [
    { role: 'user', parts: [{ text: 'Turn 0 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 0 model' }] },
    { role: 'user', parts: [{ text: 'Turn 1 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 1 model' }] },
    { role: 'user', parts: [{ text: 'Turn 2 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 2 model' }] },
    { role: 'user', parts: [{ text: 'Turn 3 prompt' }] },
    { role: 'model', parts: [{ text: 'Turn 3 model' }] },
  ];

  const result2 = compactor.compact(history4Turns, { force: true, preserveLastNTurns: 1, enableRollingTurns: true });
  const synopsis2 = (result2.messages[2].parts[0] as any).text;
  assert.match(synopsis2, /\[ROLLING DIALOGUE SYNOPSIS - TURNS 1 to 2 ARCHIVED\]/);
});

test('Bug 6 (Low): TurnMemoryRetriever retrieves masked observation across path variants, IDs, and commands', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-retriever-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    await retriever.init();

    await retriever.archiveMaskedObservations([
      {
        id: 'obs-file-1',
        toolName: 'view_file',
        targetPath: 'src/utils/helpers.ts',
        timestamp: new Date().toISOString(),
        originalPayload: { content: 'export function help() {}' },
        summary: 'Helper utils file',
      },
      {
        id: 'obs-cmd-1',
        toolName: 'run_command',
        command: 'npm run test:unit',
        exitCode: 0,
        timestamp: new Date().toISOString(),
        originalPayload: { stdout: 'All unit tests passed' },
        summary: 'Unit test run',
      },
    ]);

    // 1. Match by ID
    assert.equal(retriever.retrieveMaskedObservation('obs-file-1')?.id, 'obs-file-1');

    // 2. Match by relative path with forward slashes
    assert.equal(retriever.retrieveMaskedObservation('src/utils/helpers.ts')?.id, 'obs-file-1');

    // 3. Match by relative path with backslashes
    assert.equal(retriever.retrieveMaskedObservation('src\\utils\\helpers.ts')?.id, 'obs-file-1');

    // 4. Match by resolved absolute path
    const abs = path.resolve('src/utils/helpers.ts');
    assert.equal(retriever.retrieveMaskedObservation(abs)?.id, 'obs-file-1');

    // 5. Match by exact command
    assert.equal(retriever.retrieveMaskedObservation('npm run test:unit')?.id, 'obs-cmd-1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
