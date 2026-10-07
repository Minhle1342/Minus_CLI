import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextCompactor } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import { selectReplacedObservationIds } from './observation-retention-policy.js';
import { resolveRequestBudget } from './request-budget.js';
import { assertHistoryToolPairing } from '../session/session-invariants.js';
import { TurnMemoryRetriever } from '../context/turn-memory-retriever.js';

function fixture() {
  const history: any[] = [{ role: 'user', parts: [{ text: 'Keep active task constraints' }] }];
  for (let i = 0; i < 8; i++) {
    history.push({ role: 'model', parts: [{ functionCall: { id: `r-${i}`, name: 'read_file', args: { path: 'active.ts' } } }] });
    history.push({ role: 'user', parts: [{ functionResponse: { id: `r-${i}`, name: 'read_file',
      response: { path: 'active.ts', content: 'const importantInvariant = true;\n'.repeat(1500) } } }] });
  }
  return history;
}

test('request budget consistently subtracts output reserve from hard and proactive ceilings', () => {
  assert.deepEqual(resolveRequestBudget({ maxInputTokens: 10000, targetInputTokens: 8000, outputReserveTokens: 2000 }),
    { usableInputTokens: 8000, targetUsableInputTokens: 6000 });
  assert.deepEqual(resolveRequestBudget({ maxInputTokens: 10000, outputReserveTokens: 2000 }),
    { usableInputTokens: 8000, targetUsableInputTokens: 8000 });
});

test('same failed candidate is not regenerated, but history, budgets and protection changes invalidate it', async () => {
  const compactor = new ContextCompactor();
  const compact = compactor.compact.bind(compactor);
  let attempts = 0;
  compactor.compact = (...args) => { attempts++; return compact(...args); };
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce' });
  const envelope = { provider: 'test', model: 'test', systemPrompt: '', tools: [],
    history: [{ role: 'user', parts: [{ text: 'irreducible request '.repeat(1000) }] }],
    maxInputTokens: 1000, outputReserveTokens: 0 };
  const options = { protectActiveTurn: true };
  const first = await manager.prepareRequest(envelope, options);
  assert.equal(attempts, 1, 'do not repeat an identical protected pass as emergency');
  const second = await manager.prepareRequest(envelope, options);
  assert.equal(attempts, 1);
  assert.equal(second.failureReason, first.failureReason);
  assert.strictEqual(second.history, envelope.history);
  await manager.prepareRequest({ ...envelope, maxInputTokens: 900 }, options);
  assert.equal(attempts, 2);
  await manager.prepareRequest(envelope, { ...options, protectedPaths: ['a.ts'] });
  assert.equal(attempts, 3);
  await manager.prepareRequest({ ...envelope, history: [...envelope.history,
    { role: 'model', parts: [{ text: 'new evidence' }] }] }, options);
  assert.equal(attempts, 4);
});

test('selective active-turn compaction preserves latest snapshot, instructions, pairing and archived originals', () => {
  const history = fixture();
  const replacements = selectReplacedObservationIds(history);
  assert.deepEqual(replacements, ['r-0', 'r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6']);
  const result = new ContextCompactor().compact(history, { force: true, protectActiveTurn: true,
    protectedMessages: history, protectedPaths: ['active.ts'], replacedObservationIds: replacements,
    enableObservationMasking: true, enforceBudget: true, maxInputTokens: 1000 });
  assert.ok(result.stats.tokensSaved > 0);
  assert.deepEqual(result.messages[0], history[0]);
  assert.deepEqual(result.messages.at(-1), history.at(-1));
  assertHistoryToolPairing(result.messages);
  assert.ok(result.stats.maskedObservations?.length);
  for (const record of result.stats.maskedObservations || []) {
    assert.match(record.originalPayload.content, /importantInvariant/);
    assert.ok(JSON.stringify(result.messages).includes(record.id), 'stub must have a recall ID');
  }
});

test('different read windows, changed snapshots, failed commands and unknown outputs remain pinned', () => {
  const history = fixture().slice(0, 5);
  history[3].parts[0].functionCall.args.startLine = 20;
  assert.deepEqual(selectReplacedObservationIds(history), []);
  history[3].parts[0].functionCall.args = { path: 'active.ts' };
  history[4].parts[0].functionResponse.response.content = 'new snapshot';
  assert.deepEqual(selectReplacedObservationIds(history), []);
  const commands: any[] = [];
  for (let i = 0; i < 3; i++) {
    commands.push({ role: 'model', parts: [{ functionCall: { id: `c-${i}`, name: 'run_command', args: { command: 'npm test' } } }] });
    commands.push({ role: 'user', parts: [{ functionResponse: { id: `c-${i}`, name: 'run_command',
      response: { exitCode: i === 0 ? 1 : 0, stdout: 'test output' } } }] });
  }
  assert.deepEqual(selectReplacedObservationIds(commands), ['c-1']);
});

test('selectively masked snapshots can be recalled by archive ID after restarting the archive store', async () => {
  const tempParent = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, 'compaction-recall-'));
  try {
    const history = fixture();
    const result = new ContextCompactor().compact(history, { force: true, protectActiveTurn: true,
      protectedMessages: history, replacedObservationIds: selectReplacedObservationIds(history) });
    const originals = result.stats.maskedObservations || [];
    assert.ok(originals.length > 0);
    await new TurnMemoryRetriever(root).archiveMaskedObservations(originals);
    const restored = new TurnMemoryRetriever(root);
    await restored.init();
    for (const original of originals) {
      assert.deepEqual(restored.retrieveMaskedObservation(original.id)?.originalPayload, original.originalPayload);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
