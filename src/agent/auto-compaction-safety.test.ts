import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextCompactor } from './context-compactor.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import { TurnMemoryRetriever } from '../context/turn-memory-retriever.js';

function history(): any[] {
  const messages: any[] = [{ role: 'user', parts: [{ text: 'Active task constraints' }] }];
  for (let index = 0; index < 6; index++) {
    messages.push({ role: 'model', parts: [{ functionCall: { id: `read-${index}`, name: 'read_file', args: { path: 'active.ts' } } }] });
    messages.push({ role: 'user', parts: [{ functionResponse: { id: `read-${index}`, name: 'read_file', response: { path: 'active.ts', content: 'important source evidence '.repeat(2000) } } }] });
  }
  return messages;
}

test('active turn remains verbatim through native, phase masking and emergency compaction', async () => {
  const original = history();
  const compactor = new ContextCompactor({ nativePrecompactionThresholdChars: 1, preserveLastNToolResults: 1 });
  const manager = new ContextBudgetManager(compactor, { mode: 'enforce' });
  const result = await manager.prepareRequest({ provider: 'test', model: 'gemini-test', systemPrompt: '', tools: [],
    history: original, maxInputTokens: 1000, outputReserveTokens: 100 },
  { protectActiveTurn: true, cognitivePhase: 'implement', enableObservationMasking: true });
  assert.deepEqual(result.history, original);
  assert.equal(result.changed, false);
  assert.equal(result.failureReason, 'CONTEXT_BUDGET_UNSATISFIABLE');
});

test('task paths and command evidence remain intact even outside the observation window', () => {
  const original = history();
  original.push({ role: 'user', parts: [{ text: 'Continue using active.ts' }] });
  const compactor = new ContextCompactor({ preserveLastNToolResults: 1 });
  const result = compactor.compact(original, { force: true, protectActiveTurn: true, protectedPaths: ['active.ts'],
    enableRollingTurns: true, preserveLastNTurns: 1, cognitivePhase: 'explore', enableObservationMasking: true });
  assert.deepEqual(result.messages, original);
});

test('candidate with fewer characters but no token savings is never applied', async () => {
  const original = history();
  const manager = new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce', counter: {
    async count() { return { inputTokens: 2000, upperBoundTokens: 2000, historyTokens: 2000,
      nonHistoryTokens: 0, source: 'tokenizer', hardBound: false, errorMarginRatio: 0 }; },
  } });
  const result = await manager.prepareRequest({ provider: 'test', model: 'test', systemPrompt: '', tools: [],
    history: original, maxInputTokens: 1000, outputReserveTokens: 0 });
  assert.equal(result.changed, false);
  assert.strictEqual(result.history, original);
  assert.equal(result.after.upperBoundTokens, result.before.upperBoundTokens);
});

test('identical turn archive retries disk persistence after an earlier write failure', async () => {
  const retriever = Object.create(TurnMemoryRetriever.prototype) as any;
  retriever.init = async () => {};
  retriever.turnsMap = new Map();
  retriever.miniSearch = { addAll() {} };
  retriever.enforceMemoryCaps = () => ({ evictedTurns: 0 });
  retriever.bumpMemoryVersion = () => {};
  let writes = 0;
  retriever.persist = async () => { if (++writes === 1) throw new Error('disk unavailable'); };
  const doc = { id: 'turn-1', turnNumber: 1, userPrompt: 'task', assistantSummary: 'result',
    toolsUsed: [], filesTouched: [], keyDecisions: [], timestamp: 'now', vector: [1] };
  await assert.rejects(retriever.archiveTurns([doc]), /disk unavailable/);
  await retriever.archiveTurns([doc]);
  assert.equal(writes, 2);
});

test('identical masked archive retries persistence rather than acknowledging RAM-only data', async () => {
  const retriever = Object.create(TurnMemoryRetriever.prototype) as any;
  retriever.init = async () => {};
  retriever.maskedObservationsMap = new Map();
  retriever.bumpMemoryVersion = () => {};
  let writes = 0;
  retriever.persistMaskedObservations = async () => { if (++writes === 1) throw new Error('disk unavailable'); };
  const record = { id: 'observation-1', toolName: 'read_file', payloadHash: 'stable',
    originalPayload: { content: 'original evidence' }, timestamp: 'now', summary: 'read' };
  await assert.rejects(retriever.archiveMaskedObservations([record]), /disk unavailable/);
  await retriever.archiveMaskedObservations([record]);
  assert.equal(writes, 2);
});

test('marginal savings under the hard limit do not rewrite the cache prefix', async () => {
  const original = history();
  let counts = 0;
  const manager = new ContextBudgetManager(new ContextCompactor(), { mode: 'enforce', triggerRatio: 0.5, counter: {
    async count() { const tokens = ++counts === 1 ? 2000 : 1999;
      return { inputTokens: tokens, upperBoundTokens: tokens, historyTokens: tokens,
        nonHistoryTokens: 0, source: 'tokenizer', hardBound: false, errorMarginRatio: 0 }; },
  } });
  const result = await manager.prepareRequest({ provider: 'test', model: 'test', systemPrompt: '', tools: [],
    history: original, maxInputTokens: 3000, outputReserveTokens: 0 });
  assert.equal(result.changed, false);
  assert.strictEqual(result.history, original);
  assert.equal(result.withinBudget, true);
});
