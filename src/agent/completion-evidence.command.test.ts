import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionEvidenceGate, classifyToolEvidence, isVerificationCommand } from './completion-evidence.js';
import { Session } from '../session/session.js';
import { createManageTaskTool } from '../tools/manage-task.js';
import { Workspace } from '../workspace/workspace.js';

test('verification classifier recognizes common custom scripts and package-manager runners', () => {
  for (const command of [
    'npm test',
    'npm run test:unit',
    'npm run type-check',
    'npm run check-types',
    'yarn lint:ci',
    'pnpm exec vitest run',
    'cargo nextest run',
    'node --test',
  ]) assert.equal(isVerificationCommand(command), true, command);
});

test('verification classifier recognizes python byte-compile checks as static verification', () => {
  for (const command of [
    'python -m py_compile oop.py',
    'python3 -m py_compile src/app.py',
    'python -m compileall src',
    'python3 -m compileall -q .',
  ]) assert.equal(isVerificationCommand(command), true, command);
  // Running the script itself proves nothing about correctness — still not verification.
  for (const command of [
    'python oop.py',
    'python3 src/app.py',
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test('verification classifier rejects wrappers and commands that can mask test failure', () => {
  for (const command of [
    'echo npm test',
    'npm test || true',
    'npm test | cat',
    'npm test; echo done',
    'npm test & echo done',
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test('simple successful && verification chains remain valid', () => {
  assert.equal(isVerificationCommand('npm run build && npm test'), true);
  assert.equal(isVerificationCommand('npm test && echo completed'), true);
});

test('completed background verification contributes evidence only after terminal success', () => {
  const session = new Session('background-verification-evidence');
  session.append('turn/start', { turn: 1 } as any);
  session.append('tool/call', {
    turn: 1, toolCallId: 'mutation', toolName: 'write_file', args: { path: 'src/example.ts' },
  } as any);
  session.append('tool/result', {
    turn: 1, toolCallId: 'mutation', toolName: 'write_file', result: { success: true },
  } as any);
  session.append('tool/call', {
    turn: 1, toolCallId: 'status', toolName: 'manage_task', args: { Action: 'status', TaskId: 'task_1' },
  } as any);
  session.append('tool/result', {
    turn: 1, toolCallId: 'status', toolName: 'manage_task', result: {
      action: 'status', taskId: 'task_1', commandOutcome: 'succeeded', processStarted: true, success: true,
      commandCompletion: {
        taskId: 'task_1', command: 'npm run type-check', completed: true,
        terminalStatus: 'completed', commandOutcome: 'succeeded', exitCode: 0,
      },
    },
  } as any);

  assert.deepEqual(classifyToolEvidence('manage_task', { Action: 'status' }, {
    action: 'status', commandCompletion: {
      command: 'npm run type-check', completed: true, terminalStatus: 'completed',
      commandOutcome: 'succeeded', exitCode: 0,
    },
  }), ['verification']);

  const decision = new CompletionEvidenceGate().evaluate('The change is complete.', session, {
    turn: 1, codeChangeRequired: true,
  });
  assert.equal(decision.allow, true, decision.reasons.join('; '));
});

test('failed, cancelled, and still-running background tasks do not count as verification', () => {
  const base = { action: 'status' };
  for (const commandCompletion of [
    { command: 'npm test', completed: true, terminalStatus: 'failed', commandOutcome: 'failed_unexpected', exitCode: 1 },
    { command: 'npm test', completed: true, terminalStatus: 'cancelled', commandOutcome: 'failed_unexpected', exitCode: 130 },
    { command: 'npm test', completed: false, terminalStatus: 'running' },
  ]) {
    assert.deepEqual(classifyToolEvidence('manage_task', { Action: 'status' }, { ...base, commandCompletion }), []);
  }
});

test('run_command evidence requires a definite successful process outcome', () => {
  assert.deepEqual(classifyToolEvidence('run_command', { command: 'npm test' }, {
    command: 'npm test', processStarted: true,
  }), []);
  assert.deepEqual(classifyToolEvidence('run_command', { command: 'npm test' }, {
    command: 'npm test', processStarted: true, exitCode: 0, commandOutcome: 'failed_unexpected',
  }), []);
  assert.deepEqual(classifyToolEvidence('run_command', { command: 'npm test' }, {
    command: 'npm test', processStarted: true, exitCode: 0, commandOutcome: 'succeeded',
  }), ['verification']);
});

test('manage_task emits terminal command evidence only for completed tasks', async () => {
  const taskManager = {
    getTask: () => ({
      id: 'task_1', command: 'npm test', status: 'stopped', exitCode: 0,
      logs: [], startedAt: 'now', pid: 123,
    }),
    getTaskLogs: () => 'tests passed',
  } as any;
  const result = await createManageTaskTool(taskManager).execute({ Action: 'status', TaskId: 'task_1' }, new Workspace());
  assert.equal(result.commandOutcome, 'succeeded');
  assert.equal(result.commandCompletion.completed, true);
  assert.equal(result.commandCompletion.terminalStatus, 'completed');
  assert.deepEqual(classifyToolEvidence('manage_task', { Action: 'status' }, result), ['verification']);

  const runningTaskManager = {
    getTask: () => ({
      id: 'task_2', command: 'npm test', status: 'running', exitCode: undefined,
      logs: [], startedAt: 'now', pid: 456,
    }),
    getTaskLogs: () => 'tests running',
  } as any;
  const running = await createManageTaskTool(runningTaskManager).execute({ Action: 'status', TaskId: 'task_2' }, new Workspace());
  assert.equal(running.commandCompletion, undefined);
  assert.deepEqual(classifyToolEvidence('manage_task', { Action: 'status' }, running), []);
});
