import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from './session.js';

test('prompt/prefix-churn events are accepted and stay out of model history', () => {
  const session = new Session();
  const event = session.append('prompt/prefix-churn', {
    promptPrefixChurn: {
      sessionId: session.id,
      turn: 1,
      step: 1,
      changed: true,
      systemChanged: true,
      toolsChanged: false,
      turnChanged: false,
      stablePrefixChanged: true,
      unexpectedStableChurn: false,
      changedTiers: ['T1'],
      changedSections: ['repo-rules'],
      systemHash: 'a'.repeat(32),
      toolsHash: 'b'.repeat(32),
      toolCount: 12,
      reasons: ['system-prompt'],
    },
  });

  assert.equal(event.type, 'prompt/prefix-churn');
  assert.equal(session.getEvents().filter((item) => item.type === 'prompt/prefix-churn').length, 1);
  assert.deepEqual(session.getHistory(), [], 'telemetry events must never become model context');
  assert.doesNotThrow(() => session.assertRuntimeInvariants());
});
