import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentInbox, isBackgroundTaskNotice } from './agent-inbox.js';

test('an ignored inbox item can reject without an unhandled rejection and still rejects when awaited', async () => {
  const inbox = new AgentInbox();
  const item = inbox.enqueue('session', 'continue', 'human');
  inbox.cancel('session', item.id, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(item.promise, /cancelled/);
});

test('enqueue preserves the background notice kind', () => {
  const inbox = new AgentInbox();
  const item = inbox.enqueue('session', 'done', 'system', { isSteering: true, kind: 'background-task-completed' });
  assert.equal(item.kind, 'background-task-completed');
  assert.equal(isBackgroundTaskNotice(item), true);
  assert.equal(isBackgroundTaskNotice(inbox.enqueue('session', 'hi', 'human')), false);
});

test('hasPendingKind finds unclaimed background notices only', () => {
  const inbox = new AgentInbox();
  inbox.enqueue('session', 'notice', 'system', { isSteering: true, kind: 'background-task-completed' });
  inbox.enqueue('session', 'steer', 'human', { isSteering: true });
  assert.equal(inbox.hasPendingKind('session', 'background-task'), true);
  assert.equal(inbox.hasPendingKind('session', 'user'), false);
  assert.equal(inbox.hasPendingKind('other-session', 'background-task'), false);
});
