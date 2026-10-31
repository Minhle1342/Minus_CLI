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
  assert.equal((tm as any).inboxes.size, 0, 'the finished task must release its inbox reference');
});

test('a failed spawn releases its watchdog and inbox', async () => {
  const tm = new TaskManager(process.cwd());
  tm.startTask('echo hi', 'definitely-missing-dir-xyz', {}, {
    sessionId: 's-err', turn: 1,
    inbox: { enqueue: () => ({}) } as any,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((tm as any).watchdogs.size, 0, 'the stall watchdog must not outlive the spawn');
  assert.equal((tm as any).inboxes.size, 0);
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

test('completion notice redacts secrets from the log tail', async () => {
  process.env.MINUS_TEST_SECRET_TOKEN = 'supersecrettokenvalue123';
  const seen: any[] = [];
  const tm = new TaskManager(process.cwd());
  tm.startTask('node -e "console.log(\'token=supersecrettokenvalue123\'); process.exit(0)"', process.cwd(), {}, {
    sessionId: 's-redact', turn: 1, autoPromoted: true,
    inbox: { enqueue: (_s: string, text: string) => { seen.push(text); return {} as any; } },
  });
  await tm.waitForAutoPromoted('s-redact', 1);
  delete process.env.MINUS_TEST_SECRET_TOKEN;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes('supersecrettokenvalue123'), false, 'secret must be redacted');
  assert.match(seen[0], /REDACTED/);
});
