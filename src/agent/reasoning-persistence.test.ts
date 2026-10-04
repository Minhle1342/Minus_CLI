import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldPersistReasoning } from './reasoning-persistence.js';
import { Session, MAX_REASONING_CHARS } from '../session/session.js';

test('shouldPersistReasoning prioritizes failure over high-risk over debug', () => {
  assert.deepEqual(
    shouldPersistReasoning({ thought: 't', failure: true, failureTrigger: 'verification-failed', highRisk: true, debugLogEnabled: true }),
    { persist: true, kind: 'failure', trigger: 'verification-failed' },
  );
  assert.deepEqual(
    shouldPersistReasoning({ thought: 't', highRisk: true, highRiskTrigger: 'blast-critical', debugLogEnabled: true }),
    { persist: true, kind: 'high-risk', trigger: 'blast-critical' },
  );
  assert.deepEqual(
    shouldPersistReasoning({ thought: 't', debugLogEnabled: true }),
    { persist: true, kind: 'debug', trigger: 'debug-audit-mode' },
  );
});

test('shouldPersistReasoning stays silent for empty or routine thoughts', () => {
  assert.deepEqual(shouldPersistReasoning({ thought: '   ' }), { persist: false });
  assert.deepEqual(shouldPersistReasoning({ thought: 'routine step' }), { persist: false });
  assert.deepEqual(
    shouldPersistReasoning({ thought: 'routine step', failure: true }),
    { persist: true, kind: 'failure', trigger: 'failure' },
  );
});

test('addReasoning stores a projection-excluded event', () => {
  const session = new Session('reasoning-projection');
  session.addUserMessage('do the thing');
  session.addModelMessage({ text: 'working on it' });
  const historyBefore = session.getHistory().length;

  const event = session.addReasoning('I decided to edit auth.ts because the guard was missing.', {
    kind: 'failure',
    step: 2,
    turn: 1,
    trigger: 'verification-failed:npm test',
  });
  assert.equal(event?.type, 'assistant/reasoning');
  assert.equal(event?.data.reasoning?.kind, 'failure');
  assert.equal(event?.data.reasoning?.step, 2);
  assert.equal(event?.data.reasoning?.turn, 1);

  // Model-facing projection is byte-identical: zero token cost.
  assert.equal(session.getHistory().length, historyBefore);
  assert.ok(!JSON.stringify(session.getHistory()).includes('guard was missing'));
});

test('reasoning events do not disturb request digests or invariants', () => {
  const session = new Session('reasoning-digest');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.addUserMessage('do the thing');
  session.addModelMessage({ text: 'working on it' });
  session.recordRequestHeader(
    { turn: 1, step: 1, systemPrompt: 'p', tools: [], history: session.getHistory() },
    { compactHistory: true },
  );
  session.addReasoning('second-guessing the approach after the failure', { kind: 'failure', step: 1, turn: 1 });
  session.append('step/end', { turn: 1, step: 1 });
  session.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'all' });
});

test('addReasoning caps oversized thoughts and skips empties', () => {
  const session = new Session('reasoning-cap');
  assert.equal(session.addReasoning('   ', { kind: 'debug' }), undefined);

  const big = 'x'.repeat(MAX_REASONING_CHARS + 500);
  const event = session.addReasoning(big, { kind: 'debug', step: 1, turn: 1 });
  assert.equal(event?.data.reasoning?.truncated, true);
  assert.equal(event?.data.reasoning?.fullChars, big.length);
  assert.ok((event?.data.reasoning?.thought.length || 0) < big.length);
  assert.match(event?.data.reasoning?.thought || '', /TRUNCATED THOUGHT/);

  const stored = session.getEvents().filter((e) => e.type === 'assistant/reasoning');
  assert.equal(stored.length, 1);
});

test('intent lines persist as one-liners retrievable from the event log', () => {
  const session = new Session('reasoning-intent');
  session.addUserMessage('fix the login bug');
  session.addReasoning('Doing run command "npm test".', { kind: 'intent', step: 3, turn: 1, trigger: 'step-summary' });
  const intents = session.getEvents().filter((e) => e.data.reasoning?.kind === 'intent');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].data.reasoning?.thought, 'Doing run command "npm test".');
});
