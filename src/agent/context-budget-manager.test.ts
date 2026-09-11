import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCompactor } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import { ContextGuardian } from '../context/context-guardian.js';
import { Session } from '../session/session.js';

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
