import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunCommandTool, resolveAutoBackgroundWait } from './run-command.js';
import { isLongRunningServerCommand } from './command-preflight-guard.js';
import { Workspace } from '../workspace/workspace.js';

function fakeTaskManager() {
  const started: any[] = [];
  return {
    started,
    startTask: (command: string, cwd: string, env: object, options: any) => {
      const task = { id: `task_${started.length + 1}`, command, cwd, status: 'running', logs: [], pid: 1, lastOutputAt: Date.now() };
      started.push({ command, options, task });
      return task;
    },
    hasAutoPromotedRunning: () => false,
    waitForAutoPromoted: async () => 'completed' as const,
    listTasks: () => [],
  } as any;
}

test('a finite command that outlives the soft threshold runs to completion instead of being restarted', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '1000';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "setTimeout(() => process.exit(0), 1500)"' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(result.isBackgroundTask, undefined);
  assert.equal(result.success, true);
  assert.equal(tm.started.length, 0, 'the running command must never be killed and spawned again');
});

test('a command that finishes before the threshold stays synchronous', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '5000';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "console.log(1)"' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(result.isBackgroundTask, undefined);
  assert.equal(result.success, true);
  assert.equal(tm.started.length, 0);
});

test('an explicit WaitMsBeforeAsync command is long-lived', async () => {
  const tm = fakeTaskManager();
  await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "setTimeout(() => process.exit(0), 3000)"', WaitMsBeforeAsync: 50 }, new Workspace(),
  );
  assert.equal(tm.started[0].options.autoPromoted, false);
});

test('dev-server patterns are promoted but never awaited', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '10';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute({ command: 'npm run dev' }, new Workspace());
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(isLongRunningServerCommand('npm run dev'), true);
  assert.equal(result.longLived, true);
  assert.equal(tm.started[0].options.autoPromoted, false);
});

test('watcher/follow commands are long-lived so they never hang the turn', () => {
  for (const cmd of ['tsc --watch', 'npx jest --watchAll', 'tail -f app.log', 'docker logs -f web']) {
    assert.equal(isLongRunningServerCommand(cmd), true, cmd);
  }
  assert.equal(isLongRunningServerCommand('git add -f src/index.ts'), false, '-f for force must not read as follow');
  assert.equal(isLongRunningServerCommand('npx jest --watchAll=false'), false, '--watchAll=false is a one-shot CI run');
  assert.equal(isLongRunningServerCommand('vitest run --watch=false'), false, '--watch=false is a one-shot CI run');
  assert.equal(isLongRunningServerCommand('tsc --watch-path src'), true);
});

test('timeout_ms bounds the sync path regardless of the soft threshold', async () => {
  const tm = fakeTaskManager();
  const seen: number[] = [];
  const sandbox = {
    getStatus: () => ({ isIsolated: false, fallbackToLocal: true }),
    exec: async (_c: string, o: any) => {
      seen.push(o.timeoutMs);
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1, sandboxType: 'local', success: true };
    },
  } as any;
  await createRunCommandTool(sandbox, tm).execute({ command: 'git status', timeout_ms: 2000 }, new Workspace());
  await createRunCommandTool(sandbox, tm).execute({ command: 'git status', timeout_ms: 0 }, new Workspace());
  assert.deepEqual(seen, [2000, 0]);
});

test('auto-promotion does not cross an isolated sandbox boundary', async () => {
  const tm = fakeTaskManager();
  const sandbox = {
    getStatus: () => ({ isIsolated: true, fallbackToLocal: false }),
    exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, sandboxType: 'docker', success: true }),
  } as any;
  const result = await createRunCommandTool(sandbox, tm).execute({ command: 'npm test' }, new Workspace());
  assert.equal(tm.started.length, 0);
  assert.equal(result.preflightCode, undefined);
});

test('subagent contexts never auto-promote', () => {
  const tm = fakeTaskManager();
  assert.equal(resolveAutoBackgroundWait(undefined, tm, { isSubagent: true }), undefined);
  assert.equal(resolveAutoBackgroundWait(undefined, tm, { longLived: true, isSubagent: true }), undefined);
});

test('a timed-out sync command is reported, not restarted in the background', async () => {
  const tm = fakeTaskManager();
  const sandbox = {
    getStatus: () => ({ isIsolated: false, fallbackToLocal: true }),
    exec: async (_c: string, o: any) => ({ stdout: '', stderr: '', exitCode: 1, durationMs: o.timeoutMs, timedOut: true, sandboxType: 'local', success: false }),
  } as any;
  const result = await createRunCommandTool(sandbox, tm).execute(
    { command: 'git status' }, new Workspace(),
  );
  assert.equal(result.isBackgroundTask, undefined);
  assert.equal(tm.started.length, 0);
  assert.equal(result.timedOut, true);
});

test('a non-isolated sandbox never restarts the command on soft timeout', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '1000';
  process.env.MINUS_ALLOW_HOST_FALLBACK = 'true';
  const tm = fakeTaskManager();
  const sandbox = {
    getStatus: () => ({ isIsolated: false, fallbackToLocal: true }),
    exec: async (_c: string, o: any) => ({ stdout: '', stderr: '', exitCode: 1, durationMs: o.timeoutMs, timedOut: true, sandboxType: 'local', success: false }),
  } as any;
  const result = await createRunCommandTool(sandbox, tm).execute(
    { command: 'git status' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  delete process.env.MINUS_ALLOW_HOST_FALLBACK;
  assert.equal(result.isBackgroundTask, undefined);
  assert.equal(tm.started.length, 0);
});

test('network git is never auto-promoted, even over the threshold', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '1000';
  const tm = fakeTaskManager();
  const sandbox = {
    getStatus: () => ({ isIsolated: false, fallbackToLocal: true }),
    exec: async (_c: string, o: any) => ({ stdout: '', stderr: '', exitCode: 1, durationMs: o.timeoutMs, timedOut: true, sandboxType: 'local', success: false }),
  } as any;
  const result = await createRunCommandTool(sandbox, tm).execute(
    { command: 'git pull', timeout_ms: 300000 }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(result.isBackgroundTask, undefined);
  assert.equal(tm.started.length, 0);
});
