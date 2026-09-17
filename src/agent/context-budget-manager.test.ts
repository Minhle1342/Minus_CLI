import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCompactor } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import { ContextGuardian } from '../context/context-guardian.js';
import { Session } from '../session/session.js';
import { isNativeAvailable } from '../native/index.js';

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
