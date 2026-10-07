import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompletedTurnCompactionPolicy, hasCompletedTurnPressure, hasMaterialCompletedTurnSavings } from './completed-turn-compaction-policy.js';
import { AgentLoop } from './agent-loop.js';
import { ContextCompactor } from './context-compactor.js';
import { Session } from '../session/session.js';

const defaults = resolveCompletedTurnCompactionPolicy({});

test('default gates require both token pressure and material savings', () => {
  assert.equal(hasCompletedTurnPressure(5999, 10000, defaults), false);
  assert.equal(hasCompletedTurnPressure(6000, 10000, defaults), true);
  assert.equal(hasMaterialCompletedTurnSavings(10000, 9490, defaults), false);
  assert.equal(hasMaterialCompletedTurnSavings(10000, 9488, defaults), false);
  assert.equal(hasMaterialCompletedTurnSavings(10000, 9000, defaults), true);
  assert.equal(hasMaterialCompletedTurnSavings(1000, 1100, defaults), false);
  assert.equal(hasCompletedTurnPressure(NaN, 10000, defaults), false);
  assert.equal(hasCompletedTurnPressure(6000, 0, defaults), false);
  assert.equal(hasMaterialCompletedTurnSavings(10000, NaN, defaults), false);
});

test('environment thresholds are configurable and invalid values use defaults', () => {
  assert.deepEqual(resolveCompletedTurnCompactionPolicy({
    MINUS_COMPLETED_TURN_COMPACTION_RATIO: '0.75',
    MINUS_COMPLETED_TURN_MIN_TOKENS_SAVED: '1024',
    MINUS_COMPLETED_TURN_MIN_SAVINGS_RATIO: '0.2',
  }), { triggerRatio: 0.75, minTokensSaved: 1024, minSavingsRatio: 0.2 });
  for (const value of ['', ' ', '-1', 'NaN', 'Infinity']) {
    assert.deepEqual(resolveCompletedTurnCompactionPolicy({
      MINUS_COMPLETED_TURN_COMPACTION_RATIO: value,
      MINUS_COMPLETED_TURN_MIN_TOKENS_SAVED: value,
      MINUS_COMPLETED_TURN_MIN_SAVINGS_RATIO: value,
    }), defaults);
  }
});

function closedSession(count: number, largeOldTurn = false): Session {
  const session = new Session(`pressure-${count}-${largeOldTurn}`);
  for (let turn = 1; turn <= count; turn++) {
    session.addUserMessage(turn === 1 && largeOldTurn ? 'source evidence '.repeat(10000) : `request ${turn}`);
    session.append('turn/start', { turn });
    session.addModelMessage({ text: `result ${turn}` });
    session.append('turn/end', { turn, reason: 'completed' });
  }
  return session;
}

/** Exercise the real boundary method without constructing unrelated agent services. */
function boundaryHarness(maxInputTokens?: number, compactor = new ContextCompactor()) {
  const calls = { candidates: 0, archives: 0, persisted: 0 };
  const loop = Object.create(AgentLoop.prototype) as any;
  const compact = compactor.compactCompletedTurnWindow.bind(compactor);
  compactor.compactCompletedTurnWindow = (...args) => { calls.candidates++; return compact(...args); };
  loop.contextCompactor = compactor;
  loop.getTokenConfig = () => ({ maxInputTokens });
  loop.planManager = { getTaskGraph: () => ({ nodes: [], readyTaskIds: [], blocked: [] }) };
  loop.turnMemoryRetriever = { archiveTurns: async () => { calls.archives++; return { inserted: 1, updated: 0, skipped: 0, evicted: [] }; } };
  loop.persistSession = async () => { calls.persisted++; };
  return { run: (session: Session) => loop.maybeCompactCompletedTurnWindow(session), calls, loop };
}

test('five short turns bypass even candidate generation and archive writes', async () => {
  const session = closedSession(5);
  const before = session.getHistory();
  const harness = boundaryHarness();
  await harness.run(session);
  assert.deepEqual(session.getHistory(), before);
  assert.deepEqual(harness.calls, { candidates: 0, archives: 0, persisted: 0 });
});

test('pressure without actual savings leaves history and archive unchanged', async () => {
  const session = closedSession(5);
  const before = session.getHistory();
  const harness = boundaryHarness(1);
  await harness.run(session);
  assert.deepEqual(session.getHistory(), before);
  assert.deepEqual(harness.calls, { candidates: 1, archives: 0, persisted: 0 });
});

test('large old turn compacts under active-model pressure and retains the newest four turns', async () => {
  const session = closedSession(5, true);
  const harness = boundaryHarness(5000);
  await harness.run(session);
  assert.deepEqual(harness.calls, { candidates: 1, archives: 1, persisted: 1 });
  const event = session.findLatestEventOfType('session/compaction');
  assert.deepEqual((event?.data.compactionState as any)?.turnWindow.preservedTurns, [2, 3, 4, 5]);
  assert.match(JSON.stringify(session.getHistory()), /ROLLING DIALOGUE SYNOPSIS/);
  session.assertRuntimeInvariants();
});

test('compactor budget is the fallback when the model has no input budget', async () => {
  const session = closedSession(5, true);
  const harness = boundaryHarness(undefined, new ContextCompactor({ maxTotalHistoryTokens: 5000 }));
  await harness.run(session);
  assert.equal(harness.calls.archives, 1);
});

test('archive rejection preserves original history and creates no compaction event', async () => {
  const session = closedSession(5, true);
  const before = session.getHistory();
  const harness = boundaryHarness(5000);
  harness.loop.turnMemoryRetriever.archiveTurns = async () => {
    harness.calls.archives++;
    throw new Error('archive write failed');
  };
  await harness.run(session);
  assert.deepEqual(session.getHistory(), before);
  assert.equal(session.findLatestEventOfType('session/compaction'), undefined);
  assert.deepEqual(harness.calls, { candidates: 1, archives: 1, persisted: 0 });
  session.assertRuntimeInvariants();
});

test('turn-count and lifecycle safety gates still block compaction under pressure', async () => {
  const onlyFour = closedSession(4, true);
  const fourHarness = boundaryHarness(1);
  await fourHarness.run(onlyFour);
  assert.equal(fourHarness.calls.candidates, 0);

  const open = closedSession(5, true);
  open.addUserMessage('open request');
  open.append('turn/start', { turn: 6 });
  const openHarness = boundaryHarness(1);
  await openHarness.run(open);
  assert.equal(openHarness.calls.candidates, 0);

  const pending = closedSession(5, true);
  pending.addModelMessage({ functionCalls: [{ name: 'read_file', id: 'pending', args: { path: 'a.ts' } }] as any });
  pending.append('tool/call', { toolName: 'read_file', toolCallId: 'pending', args: { path: 'a.ts' } });
  const pendingHarness = boundaryHarness(1);
  await pendingHarness.run(pending);
  assert.equal(pendingHarness.calls.candidates, 0);
});

test('unchanged closed-turn history with no material savings is not compacted twice', async () => {
  const session = closedSession(5);
  const harness = boundaryHarness(1);
  await harness.run(session);
  await harness.run(session);
  assert.equal(harness.calls.candidates, 1);
  assert.equal(harness.calls.archives, 0);
});

test('turn pressure includes request overhead and subtracts output reserve', async () => {
  const session = closedSession(5, true);
  const harness = boundaryHarness(100000);
  harness.loop.getTokenConfig = () => ({ maxInputTokens: 100000, maxOutputTokens: 20000 });
  harness.loop.lastRequestEnvelope = { sessionId: session.id, envelope: {
    provider: 'test', model: 'test', systemPrompt: 'large system prompt', tools: [],
    maxInputTokens: 100000, outputReserveTokens: 20000,
  } };
  harness.loop.contextBudgetManager = { counter: { count: async (envelope: any) => {
    const historyTokens = Math.ceil(JSON.stringify(envelope.history).length / 4);
    return { upperBoundTokens: historyTokens + 30000 };
  } } };
  await harness.run(session);
  assert.equal(harness.calls.candidates, 1, 'history-only pressure would miss this full request');
  assert.equal(harness.calls.archives, 1);
});
