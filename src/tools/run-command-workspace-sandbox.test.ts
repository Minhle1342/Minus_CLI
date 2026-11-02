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

test('Docker isolation permits database query tools and external connections', async () => {
  const executedCommands: string[] = [];
  const tool = createRunCommandTool({
    getStatus: () => ({
      mode: 'docker', activeProvider: 'Docker Sandbox', isIsolated: true,
      dockerAvailable: true,
    }),
    exec: async (command: string) => {
      executedCommands.push(command);
      return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, success: true };
    },
  } as any);

  const testCommands = [
    'psql -h localhost -U postgres -d mydb -c "SELECT 1;"',
    'mysql -h 127.0.0.1 -u root -e "SHOW DATABASES;"',
    'sqlite3 test.db ".tables"',
    'mongosh --eval "db.stats()"',
    'redis-cli ping',
    'nc -zv 127.0.0.1 5432',
    'ssh user@remote-host',
    'telnet 10.0.0.1 5432',
    'ftp remote-server',
    'sftp remote-user@host',
  ];

  for (const cmd of testCommands) {
    const result = await tool.execute({ command: cmd }, workspace);
    assert.equal(result.success, true, `Expected success for: ${cmd}`);
    assert.equal(result.errorCode, undefined, `Expected no errorCode for: ${cmd}`);
  }
  assert.equal(executedCommands.length, testCommands.length);
});

test('Host execution continues to block remote protocols in Preflight without batch flags', async () => {
  const hostTool = createRunCommandTool({
    getStatus: () => ({ mode: 'local', isIsolated: false, dockerAvailable: false }),
  } as any);

  for (const cmd of ['ssh user@remote', 'telnet host 80', 'ftp example.com', 'sftp user@host']) {
    const res = await hostTool.execute({ command: cmd, execution_target: 'host' }, workspace);
    assert.equal(res.preflightCode, 'INTERACTIVE_COMMAND_PROHIBITED', `Expected preflight block for ${cmd}`);
  }
});
