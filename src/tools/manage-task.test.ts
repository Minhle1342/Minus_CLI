import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskManager } from '../tasks/task-manager.js';
import { createManageTaskTool } from './manage-task.js';
import { Workspace } from '../workspace/workspace.js';

test('status returns the evidence-compatible completion contract', async () => {
  const tm = new TaskManager(process.cwd());
  const tool = createManageTaskTool(tm);
  const workspace = new Workspace();
  const task = tm.startTask('node -e "process.exit(0)"', process.cwd());
  while (task.status === 'running') await new Promise((r) => setTimeout(r, 20));

  const result = await tool.execute({ Action: 'status', TaskId: task.id }, workspace);
  assert.equal(result.action, 'status');
  assert.equal(result.status, 'stopped');
  assert.equal(result.commandCompletion.completed, true);
  assert.equal(result.commandCompletion.terminalStatus, 'completed');
  assert.equal(result.commandCompletion.commandOutcome, 'succeeded');
  assert.equal(result.commandCompletion.exitCode, 0);
  assert.match(String(result.logTail), /exited with code/);

  const list = await tool.execute({ Action: 'list' }, workspace);
  assert.equal(list.action, 'list');
  assert.equal(list.count, 1);
});

test('send_input and kill work on a running task', async () => {
  const tm = new TaskManager(process.cwd());
  const tool = createManageTaskTool(tm);
  const workspace = new Workspace();
  const task = tm.startTask('node -e "process.stdin.resume(); setInterval(() => {}, 1000)"', process.cwd());
  assert.equal((await tool.execute({ Action: 'send_input', TaskId: task.id, Input: 'PING' }, workspace)).success, true);
  assert.equal((await tool.execute({ Action: 'kill', TaskId: task.id }, workspace)).success, true);
});

test('unknown task id returns a structured error', async () => {
  const tool = createManageTaskTool(new TaskManager(process.cwd()));
  const result = await tool.execute({ Action: 'status', TaskId: 'task_999' }, new Workspace());
  assert.equal(result.errorCode, 'TASK_NOT_FOUND');
});
