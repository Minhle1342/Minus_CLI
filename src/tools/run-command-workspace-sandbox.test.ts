import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import { createRunCommandTool, findWorkspaceEscapeViolations } from './run-command.js';

const workspace = new Workspace();

test('workspace sandbox flags absolute, traversal, home and redirect escapes', () => {
  const outside = path.resolve(workspace.rootDir, '..', 'secret.txt');
  for (const command of [
    'cat ../secret.txt',
    `cat "${outside}"`,
    'ls /',
    'cat ~/.ssh/id_rsa',
    'echo x > ../outside.txt',
    'cd .. && ls',
    'grep -r token /etc',
  ]) {
    assert.ok(findWorkspaceEscapeViolations(command, workspace).length > 0, command);
  }
});

test('workspace sandbox allows inside paths, URLs and safe devices', () => {
  const inside = path.join(workspace.rootDir, 'src', 'index.ts');
  for (const command of [
    `cat "${inside}"`,
    'node --import tsx --test src/tools/run-command.test.ts',
    'curl https://example.com/api/v1',
    'git clone https://github.com/org/repo.git',
    'echo ok > /dev/null',
    'cat /dev/null',
  ]) {
    assert.deepEqual(findWorkspaceEscapeViolations(command, workspace), [], command);
  }
});

test('local dispatch rejects an outside path before spawning', async () => {
  let executed = false;
  const tool = createRunCommandTool({
    getStatus: () => ({
      mode: 'local', activeProvider: 'Local Process Sandbox', isIsolated: false,
      dockerAvailable: false, fallbackToLocal: true,
    }),
    exec: async () => {
      executed = true;
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1, success: true };
    },
  } as any);
  const result = await tool.execute({ command: 'cat ../secret.txt' }, workspace);
  assert.equal(result.errorCode, 'SECURITY_VIOLATION');
  assert.equal(result.processStarted, false);
  assert.equal(result.commandOutcome, 'blocked_preflight');
  assert.equal(executed, false);
});

test('host dispatch rejects workspace traversal before spawning', async () => {
  const result = await createRunCommandTool().execute(
    { command: 'cd .. && ls', execution_target: 'host' },
    workspace,
    { permissionGranted: true } as any,
  );
  assert.equal(result.errorCode, 'SECURITY_VIOLATION');
  assert.equal(result.processStarted, false);
});

test('Docker isolation keeps container paths available', async () => {
  let executedCommand = '';
  const tool = createRunCommandTool({
    getStatus: () => ({
      mode: 'docker', activeProvider: 'Docker Sandbox', isIsolated: true,
      dockerAvailable: true,
    }),
    exec: async (command: string) => {
      executedCommand = command;
      return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, success: true };
    },
  } as any);
  const result = await tool.execute({ command: 'node /tmp/build.js' }, workspace);
  assert.notEqual(result.errorCode, 'SECURITY_VIOLATION');
  assert.equal(executedCommand, 'node /tmp/build.js');
});
