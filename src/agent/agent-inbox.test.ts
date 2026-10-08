import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentInbox } from './agent-inbox.js';

test('an ignored inbox item can reject without an unhandled rejection and still rejects when awaited', async () => {
  const inbox = new AgentInbox();
  const item = inbox.enqueue('session', 'continue', 'human');
  inbox.cancel('session', item.id, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(item.promise, /cancelled/);
});
