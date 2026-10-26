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

test('a finite command without WaitMsBeforeAsync auto-promotes as awaited', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '1000';
  const tm = fakeTaskManager();
  const result = await createRunCommandTool(undefined, tm).execute(
    { command: 'node -e "setTimeout(() => process.exit(0), 3000)"' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  assert.equal(result.isBackgroundTask, true);
  assert.equal(result.autoPromoted, true);
  assert.equal(tm.started[0].options.autoPromoted, true);
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
  assert.equal(resolveAutoBackgroundWait(undefined, 120000, tm, { isSubagent: true }), undefined);
});

test('a non-isolated sandbox manager still auto-promotes on soft timeout', async () => {
  process.env.MINUS_SOFT_TIMEOUT_MS = '1000';
  process.env.MINUS_ALLOW_HOST_FALLBACK = 'true';
  const tm = fakeTaskManager();
  const sandbox = {
    getStatus: () => ({ isIsolated: false, fallbackToLocal: true }),
    exec: async (_c: string, o: any) => ({ stdout: '', stderr: '', exitCode: 1, durationMs: o.timeoutMs, timedOut: true, sandboxType: 'local', success: false }),
  } as any;
  const result = await createRunCommandTool(sandbox, tm).execute(
    { command: 'node -e "setTimeout(() => process.exit(0), 3000)"' }, new Workspace(),
  );
  delete process.env.MINUS_SOFT_TIMEOUT_MS;
  delete process.env.MINUS_ALLOW_HOST_FALLBACK;
  assert.equal(result.isBackgroundTask, true);
  assert.equal(result.autoPromoted, true);
  assert.equal(tm.started.length, 1);
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
