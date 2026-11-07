import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drainPostTurnQueue } from './post-turn-drain.js';

function queueOf(...ids: string[]) {
  const items = ids.map((id) => ({ id, text: `text-${id}` }));
  return {
    items,
    peek: () => items[0],
    pending: () => items.length,
  };
}

test('drains every queued input once the session has no active run', async () => {
  const q = queueOf('a', 'b');
  const drained: string[] = [];

  await drainPostTurnQueue({
    isShuttingDown: () => false,
    hasActiveRun: () => false,
    pending: q.pending,
    peek: q.peek,
    drainNext: async () => {
      drained.push(q.items.shift()!.id);
    },
  });

  assert.deepEqual(drained, ['a', 'b']);
});

test('waits while the session still has an active run', async () => {
  const q = queueOf('a');
  let drained = 0;

  await drainPostTurnQueue({
    isShuttingDown: () => false,
    hasActiveRun: () => true,
    pending: q.pending,
    peek: q.peek,
    drainNext: async () => { drained++; q.items.shift(); },
  });

  assert.equal(drained, 0);
  assert.equal(q.pending(), 1);
});

test('stops when shutting down, on drain error, and when the head item makes no progress', async () => {
  const shuttingDown = queueOf('a');
  let drained = 0;

  await drainPostTurnQueue({
    isShuttingDown: () => true,
    hasActiveRun: () => false,
    pending: shuttingDown.pending,
    peek: shuttingDown.peek,
    drainNext: async () => { drained++; },
  });
  assert.equal(drained, 0);

  const failing = queueOf('a', 'b');
  const errors: unknown[] = [];
  await drainPostTurnQueue({
    isShuttingDown: () => false,
    hasActiveRun: () => false,
    pending: failing.pending,
    peek: failing.peek,
    drainNext: async () => { throw new Error('boom'); },
    onError: (error) => errors.push(error),
  });
  assert.equal(errors.length, 1);
  assert.equal(failing.pending(), 2);

  const stuck = queueOf('a');
  let attempts = 0;
  await drainPostTurnQueue({
    isShuttingDown: () => false,
    hasActiveRun: () => false,
    pending: stuck.pending,
    peek: stuck.peek,
    drainNext: async () => { attempts++; }, // never claims the head item
  });
  assert.equal(attempts, 1);
});
