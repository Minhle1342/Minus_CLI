import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskManager, shouldEmitStallNotice } from './task-manager.js';

test('exit notice carries the completion contract and resolves the waiter', async () => {
  const calls: any[] = [];
  const tm = new TaskManager(process.cwd());
  tm.startTask('node -e "setTimeout(() => process.exit(0), 100)"', process.cwd(), {}, {
    sessionId: 's1', turn: 1, autoPromoted: true,
    inbox: { enqueue: (sessionId: string, text: string, source: any, options: any) => { calls.push({ sessionId, text, source, options }); return {} as any; } } as any,
  });
  assert.equal(tm.hasAutoPromotedRunning('s1', 1), true);
  assert.equal(await tm.waitForAutoPromoted('s1', 1), 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].source, 'system');
  assert.equal(calls[0].options.isSteering, true);
  assert.equal(calls[0].options.kind, 'background-task-completed');
  assert.match(calls[0].text, /task_1/);
});

test('waitForAutoPromoted returns aborted when the signal is already aborted', async () => {
  const tm = new TaskManager(process.cwd());
  const controller = new AbortController();
  controller.abort();
  assert.equal(await tm.waitForAutoPromoted('s1', 1, controller.signal), 'aborted');
});

test('stall notice is emitted once per idle window and re-notified after the cooldown', () => {
  const now = 1_000_000;
  assert.equal(shouldEmitStallNotice({ status: 'running', lastOutputAt: now - 46_000 }, now, 45_000, 60_000), true);
  assert.equal(shouldEmitStallNotice({ status: 'running', lastOutputAt: now - 46_000, lastStallNoticeAt: now - 1_000 }, now, 45_000, 60_000), false);
  assert.equal(shouldEmitStallNotice({ status: 'stopped', lastOutputAt: now - 46_000 }, now, 45_000, 60_000), false);
});
