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

test('phase handoff compacts early only when old observations yield material savings', async () => {
  const manager = new ContextBudgetManager(new ContextCompactor({ preserveLastNToolResults: 2 }), {
    mode: 'enforce', triggerRatio: 0.95,
  });
  const history: any[] = [{ role: 'user', parts: [{ text: 'Implement the inspected change.' }] }];
  for (let i = 0; i < 6; i++) {
    history.push({ role: 'model', parts: [{ functionCall: { id: `read-${i}`, name: 'read_file', args: { path: `src/${i}.ts` } } }] });
    history.push({ role: 'user', parts: [{ functionResponse: { id: `read-${i}`, name: 'read_file', response: {
      path: `src/${i}.ts`, content: 'old inspection context '.repeat(160),
    } } }] });
  }
  const envelope = { provider: 'gemini', model: 'gemini-test', systemPrompt: 'system', tools: [], history,
    maxInputTokens: 20_000, outputReserveTokens: 100 };
  const normal = await manager.prepareRequest(envelope);
  assert.equal(normal.changed, false);
  const phase = await manager.prepareRequest(envelope, { cognitivePhase: 'implement', phaseTransition: { minHistoryTokens: 100 } });
  assert.equal(phase.changed, true);
  assert.equal(phase.phaseTransitionCompacted, true);
  assert.ok(phase.after.historyTokens < normal.before.historyTokens);
  const cachePreferred = await manager.prepareRequest(envelope, { cognitivePhase: 'implement',
    phaseTransition: { minHistoryTokens: 100, minSavingsTokens: 100_000 } });
  assert.equal(cachePreferred.changed, false);
  assert.equal(cachePreferred.history, history);
  const shadow = new ContextBudgetManager(new ContextCompactor({ preserveLastNToolResults: 2 }), {
    mode: 'shadow', triggerRatio: 0.95,
  });
  const shadowResult = await shadow.prepareRequest(envelope, { cognitivePhase: 'implement',
    phaseTransition: { minHistoryTokens: 100 } });
  assert.equal(shadowResult.changed, false);
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
  const oldResp = (result.messages![2].parts![0] as any).functionResponse.response;
  assert.equal(oldResp.status, 'masked');
  assert.equal(oldResp.exitCode, 0);
  assert.match(oldResp.observationMask, /Command executed successfully/);
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

  const resp = (result.messages![2].parts![0] as any).functionResponse.response;
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
  const synopsis1 = (result1.messages![2].parts![0] as any).text;
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
  const synopsis2 = (result2.messages![2].parts![0] as any).text;
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

test('Auto-compact regression: emergency pass unions first-pass archives', async () => {
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Primary objective' }] },
    { role: 'model', parts: [{ text: 'Acknowledged' }] },
  ];
  for (let i = 1; i <= 11; i++) {
    history.push({ role: 'user', parts: [{ text: `Turn ${i}: ${'user detail '.repeat(60)}` }] });
    history.push({ role: 'model', parts: [{ text: `Decided implementation for turn ${i}. ${'assistant detail '.repeat(80)}` }] });
  }
  const manager = new ContextBudgetManager(new ContextCompactor({ preserveLastNTurns: 8 }), { mode: 'enforce' });
  const result = await manager.prepareRequest({
    provider: 'gemini', model: 'gemini-test', systemPrompt: 'system', tools: [], history,
    maxInputTokens: 1600, outputReserveTokens: 100,
  });
  const archived = (result.compactionStats?.archivedTurns || []).map((t) => t.turnNumber);
  assert.ok(archived.includes(1), 'first-pass turn 1 must survive emergency union');
  assert.ok(archived.includes(9), 'emergency turn 9 must be present');
  assert.equal(new Set(archived).size, archived.length, 'no duplicate archived turns');
  assert.equal(result.state?.archivedTurnIds.length, archived.length);
});

test('Auto-compact regression: repeated masking preserves verification exitCode', () => {
  const compactor = new ContextCompactor({ preserveLastNToolResults: 1, maskOldObservationsBeyondN: 1 });
  const pair = (id: string, response: any) => [
    { role: 'model', parts: [{ functionCall: { id, name: 'run_command', args: { command: 'npm test' } } }] },
    { role: 'user', parts: [{ functionResponse: { id, name: 'run_command', response } }] },
  ];
  const history: any[] = [{ role: 'user', parts: [{ text: 'Verify' }] }, ...pair('old', { exitCode: 0, stdout: 'verified '.repeat(100) }), ...pair('new', { exitCode: 0, stdout: 'ok' })];
  const first = compactor.compact(history, { force: true });
  const second = compactor.compact(first.messages, { force: true });
  const secondResp = (second.messages[2]?.parts?.[0] as any)?.functionResponse?.response;
  assert.equal(secondResp?.exitCode, 0);
  assert.equal(secondResp?.status, 'masked');
});

test('Auto-compact regression: rolling summary retains cumulative decisions', () => {
  const compactor = new ContextCompactor({ preserveLastNTurns: 1, enableObservationMasking: false });
  const history: any[] = [
    { role: 'user', parts: [{ text: 'Goal' }] },
    { role: 'model', parts: [{ text: 'ok' }] },
    { role: 'user', parts: [{ text: 'Inspect' }] },
    { role: 'model', parts: [{ text: `Decided: ${'long prefix '.repeat(15)}KEEP_STRICT_VALIDATION_UNIQUE` }] },
    { role: 'user', parts: [{ text: 'Continue' }] },
    { role: 'model', parts: [{ text: 'ok' }] },
  ];
  const first = compactor.compact(history, { force: true, preserveLastNTurns: 1, enableRollingTurns: true });
  assert.match(JSON.stringify(first.messages), /KEEP_STRICT_VALIDATION_UNIQUE/);
  const extended = [...first.messages, { role: 'user', parts: [{ text: 'Next' }] }, { role: 'model', parts: [{ text: 'ok' }] }];
  const second = compactor.compact(extended as any, { force: true, preserveLastNTurns: 1, enableRollingTurns: true });
  assert.match(JSON.stringify(second.messages), /KEEP_STRICT_VALIDATION_UNIQUE/);
});

test('Auto-compact regression: calibration accounts for observed undercount', async () => {
  const { CalibratedRequestTokenCounter } = await import('./context-budget-manager.js');
  const counter = new CalibratedRequestTokenCounter();
  const envelope: any = {
    provider: 'gemini', model: 'gemini-cal-test', systemPrompt: 'system', tools: [],
    history: [{ role: 'user', parts: [{ text: 'hello '.repeat(100) }] }],
    maxInputTokens: 10000, outputReserveTokens: 100,
  };
  const initial = await counter.count(envelope);
  counter.observe(envelope.model, initial.inputTokens, initial.inputTokens * 1.8);
  const calibrated = await counter.count(envelope);
  assert.ok(calibrated.upperBoundTokens >= initial.inputTokens * 1.8, `upper bound ${calibrated.upperBoundTokens} must cover observed 1.8x undercount`);
  assert.equal(calibrated.source, 'calibrated');
});

test('Archive integrity: masked ids bind tool name + content hash, never message indices', () => {
  const compactor = new ContextCompactor({ preserveLastNToolResults: 1, maskOldObservationsBeyondN: 1 });
  const pairNoId = (stdout: string) => [
    { role: 'model', parts: [{ functionCall: { name: 'run_command', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'run_command', response: { exitCode: 0, stdout } } }] },
  ];
  const histA: any[] = [{ role: 'user', parts: [{ text: 't' }] }, ...pairNoId('FIRST'.repeat(300)), ...pairNoId('new-ok')];
  const histB: any[] = [{ role: 'user', parts: [{ text: 't' }] }, ...pairNoId('SECOND'.repeat(300)), ...pairNoId('new-ok')];
  const rA = compactor.compact(histA, { force: true });
  const rB = compactor.compact(histB, { force: true });
  const recA = (rA.stats.maskedObservations as any[])[0];
  const recB = (rB.stats.maskedObservations as any[])[0];
  assert.ok(recA && recB, 'both compactions must archive the old observation');
  assert.notEqual(recA.id, recB.id, 'distinct payloads must not share an archive id');
  assert.equal(recA.payloadHash?.length, 16);
  const rAgain = compactor.compact(histA, { force: true });
  assert.equal((rAgain.stats.maskedObservations as any[])[0]?.id, recA.id, 'same payload must map to the same id');
});

test('Archive integrity: same-id upsert keeps the fuller payload with version+1', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-archive-upsert-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    const small: any = { id: 'tool-A', toolName: 'view_file', timestamp: new Date().toISOString(), originalPayload: { path: 'a', content: 'x'.repeat(5000) }, summary: 's', payloadHash: 'h-small', version: 1 };
    const r1 = await retriever.archiveMaskedObservations([small]);
    assert.deepEqual([r1.inserted, r1.updated, r1.skipped], [1, 0, 0]);
    const rSame = await retriever.archiveMaskedObservations([{ ...small }]);
    assert.equal(rSame.skipped, 1, 'identical re-archive must be an idempotent skip');
    const fuller: any = { ...small, originalPayload: { path: 'a', content: 'FULL'.repeat(5000) }, payloadHash: 'h-full' };
    const r2 = await retriever.archiveMaskedObservations([fuller]);
    assert.equal(r2.updated, 1, 'same id + different content must upsert, not silently drop');
    const kept = retriever.retrieveMaskedObservation('tool-A');
    assert.ok(JSON.stringify(kept?.originalPayload).includes('FULL'), 'fuller payload must win');
    assert.equal(kept?.version, 2);
    assert.equal(kept?.supersedes, 'h-small');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Archive integrity: records without a stable id are rejected loudly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-archive-reject-'));
  try {
    const retriever = new TurnMemoryRetriever(root);
    await assert.rejects(retriever.archiveMaskedObservations([{ toolName: 'x' } as any]), /stable id/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Archive integrity: request headers form a verifiable digest chain', async () => {
  const { assertSessionRuntimeInvariants, computeRequestDigest } = await import('../session/session-invariants.js');
  const session = new Session(`chain-${Date.now()}`);
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const h1 = session.recordRequestHeader({ turn: 1, step: 1, systemPrompt: 'p', tools: [], history: [] } as any, { compactHistory: true });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 2 });
  const h2 = session.recordRequestHeader({ turn: 1, step: 2, systemPrompt: 'p', tools: [], history: [] } as any, { compactHistory: true });
  assert.equal((h2.data.requestHeader as any).previousDigest, (h1.data.requestHeader as any).digest);
  session.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
  const forged = session.getEvents().map((e) => JSON.parse(JSON.stringify(e)));
  const lastHeader = (forged[forged.length - 1].data.requestHeader as any);
  lastHeader.previousDigest = 'deadbeef';
  const { digest: _dropped, ...rest } = lastHeader;
  lastHeader.digest = computeRequestDigest(rest);
  assert.throws(() => assertSessionRuntimeInvariants(forged as any, { allowOpenLifecycle: true }), /digest chain broken/);
});
