import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunCommandTool } from './run-command.js';
import { Workspace } from '../workspace/workspace.js';

function taskManagerThatMustNotStart() {
  return {
    startTask: () => { throw new Error('background process must not be started'); },
  } as any;
}

test('background dispatch keeps the Docker boundary through docker exec argv', async () => {
  let captured: any;
  const sandbox = {
    getStatus: () => ({ mode: 'docker', isIsolated: true, fallbackToLocal: false, containerId: 'abc123' }),
    getExecArgv: (command: string) => ['docker', 'exec', '-i', 'abc123', 'sh', '-c', command],
    exec: async () => { throw new Error('must not execute synchronously'); },
  } as any;
  const taskManager = {
    startTask: (_command: string, _cwd: string, _env: any, options: any) => {
      captured = options;
      return { id: 'task_1', status: 'stopped', exitCode: 0, logs: ['ok'], stopRequested: false };
    },
  } as any;
  const result = await createRunCommandTool(sandbox, taskManager).execute(
    { command: 'npm test', WaitMsBeforeAsync: 100 }, new Workspace(),
  );
  assert.equal(result.commandOutcome, 'succeeded');
  assert.deepEqual(captured.argv.slice(0, 4), ['docker', 'exec', '-i', 'abc123']);
});

test('no approval channel: shell file-misuse skips the dead prompt and redirects to the tool', async () => {
  let prompted = 0;
  const permissionManager = {
    getMode: () => 'always_ask',
    hasApprovalChannel: () => false,
    checkPermission: async () => { prompted++; return { allowed: false, errorCode: 'APPROVAL_REQUIRED' }; },
  } as any;
  const result = await createRunCommandTool(undefined, undefined, permissionManager).execute(
    { command: 'cat src/a.ts && ./run-custom.sh' }, new Workspace(), {},
  );
  assert.equal(prompted, 0);
  assert.equal(result.errorCode, 'COMMAND_NOT_ALLOWED');
  assert.match(String(result.suggestion), /read_file/);
});

test('auto background dispatch refuses to cross an available Docker boundary', async () => {
  const sandbox = {
    getStatus: () => ({ isIsolated: true, fallbackToLocal: false }),
    exec: async () => { throw new Error('must not execute synchronously'); },
  } as any;
  const result = await createRunCommandTool(sandbox, taskManagerThatMustNotStart()).execute(
    { command: 'npm test', WaitMsBeforeAsync: 500 }, new Workspace(),
  );
  assert.equal(result.preflightCode, 'BACKGROUND_ISOLATION_UNSUPPORTED');
  assert.equal(result.commandOutcome, 'blocked_preflight');
  assert.equal(result.processStarted, false);
});

test('host-destructive command is blocked before background spawn even with approval', async () => {
  const result = await createRunCommandTool(undefined, taskManagerThatMustNotStart()).execute(
    { command: 'rm -rf C:\\Windows', WaitMsBeforeAsync: 500, execution_target: 'host' },
    new Workspace(),
    { permissionGranted: true } as any,
  );
  assert.equal(result.preflightCode, 'HOST_SYSTEM_RISK');
  assert.equal(result.commandOutcome, 'blocked_preflight');
  assert.equal(result.processStarted, false);
});

test('host system-risk policy runs before file-command emulation', async () => {
  const result = await createRunCommandTool().execute(
    { command: 'rm -rf C:\\Windows', execution_target: 'host' }, new Workspace(),
    { permissionGranted: true } as any,
  );
  assert.equal(result.preflightCode, 'HOST_SYSTEM_RISK');
  assert.equal(result.commandOutcome, 'blocked_preflight');
  assert.equal(result.processStarted, false);
});

test('invalid execution target is rejected before command dispatch', async () => {
  const result = await createRunCommandTool(undefined, taskManagerThatMustNotStart()).execute(
    { command: 'npm test', WaitMsBeforeAsync: 500, execution_target: 'docker' }, new Workspace(),
  );
  assert.equal(result.errorCode, 'INVALID_EXECUTION_TARGET');
});

test('shell operators outside && require explicit authorization before execution', async () => {
  const result = await createRunCommandTool().execute(
    { command: 'npm test & echo done' }, new Workspace(),
  );
  assert.equal(result.errorCode, 'COMMAND_PARSE_REJECTED');
  assert.equal(result.processStarted, undefined);
});

test('background command that exits during initial wait returns a terminal result contract', async () => {
  const taskManager = {
    startTask: () => ({
      id: 'task_1', status: 'stopped', exitCode: 0, logs: ['tests passed'], stopRequested: false,
    }),
  } as any;
  const result = await createRunCommandTool(undefined, taskManager).execute(
    { command: 'npm test', WaitMsBeforeAsync: 100 }, new Workspace(),
  );
  assert.equal(result.commandOutcome, 'succeeded');
  assert.equal(result.commandCompletion.terminalStatus, 'completed');
  assert.equal(result.commandCompletion.exitCode, 0);
});
