import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

class ScriptedLLM {
  calls: Array<{ tools: string[]; prompt: string }> = [];
  async generate(session: Session, tools: any[] = []): Promise<any> {
    this.calls.push({ tools: tools.map((t) => t.name), prompt: JSON.stringify(session.getHistory()) });
    return { text: this.calls.length === 1 ? 'The project is a CLI coding agent.' : 'Background tests passed.' };
  }
}

test('a pending auto-promoted task delays the final answer and unlocks manage_task', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  let pending = true;
  let loop: AgentLoop;
  const taskManager = {
    hasAutoPromotedRunning: () => pending,
    waitForAutoPromoted: async () => {
      pending = false;
      loop.inbox.enqueue('s-bg', '[BACKGROUND TASK COMPLETED] task_1 npm test exited 0. Use manage_task.', 'system', { isSteering: true, kind: 'background-task-completed' });
      return 'completed' as const;
    },
    listTasks: () => [],
  } as any;
  loop = new AgentLoop(llm as any, new ToolRegistry(), { workspace, taskManager, maxSteps: 1 });
  const session = new Session('s-bg');
  session.addUserMessage('What does this project do?');

  const answer = await loop.run(session);

  assert.equal(answer, 'Background tests passed.');
  assert.equal(llm.calls.length, 2, 'the gate must consume a leased step, not drop the answer');
  assert.equal(llm.calls[0].tools.includes('manage_task'), false);
  assert.equal(llm.calls[1].tools.includes('manage_task'), true);
  assert.match(llm.calls[1].prompt, /BACKGROUND TASK COMPLETED/);
});

test('a notice that arrives before the final answer is still claimed', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  let loop: AgentLoop;
  const taskManager = {
    hasAutoPromotedRunning: () => false,
    waitForAutoPromoted: async () => 'completed' as const,
    listTasks: () => [],
  } as any;
  loop = new AgentLoop(llm as any, new ToolRegistry(), { workspace, taskManager, maxSteps: 1 });
  const session = new Session('s-notice');
  session.addUserMessage('What does this project do?');
  // The task exited while the model was writing its answer; the notice is already queued.
  loop.inbox.enqueue('s-notice', '[BACKGROUND TASK COMPLETED] task_2 npm test exited 0. Use manage_task.', 'system', { isSteering: true, kind: 'background-task-completed' });

  const answer = await loop.run(session);

  assert.equal(answer, 'Background tests passed.');
  assert.equal(llm.calls.length, 2, 'a pending notice must not be skipped by the final answer');
  assert.match(llm.calls[1].prompt, /BACKGROUND TASK COMPLETED/);
});

test('a notice claimed by the inbox drain unlocks manage_task for its own turn', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  const taskManager = {
    hasAutoPromotedRunning: () => false,
    waitForAutoPromoted: async () => 'completed' as const,
    listTasks: () => [],
  } as any;
  const loop = new AgentLoop(llm as any, new ToolRegistry(), { workspace, taskManager, maxSteps: 1 });
  const session = new Session('s-drain');
  session.addUserMessage('What does this project do?');
  // drainInbox claims the notice before run() starts, so no step-top claim can unlock the tool.
  loop.inbox.enqueue('s-drain', '[BACKGROUND TASK COMPLETED] task_9 npm test exited 0. Use manage_task.', 'system', { isSteering: true, kind: 'background-task-completed' });

  await loop.submit(session, 'Next queued task.');

  assert.equal(llm.calls[0].tools.includes('manage_task'), true, 'the drained notice turn must see manage_task');
});

test('subagent loops never gate on background tasks', async () => {
  const workspace = new Workspace();
  const llm = new ScriptedLLM();
  const waitForAutoPromoted = async () => { throw new Error('subagent must not wait'); };
  const loop = new AgentLoop(llm as any, new ToolRegistry(), {
    workspace, agentId: 'subagent-test', enableSubagents: false, maxSteps: 1,
    taskManager: { hasAutoPromotedRunning: () => true, waitForAutoPromoted, listTasks: () => [] } as any,
  });
  const session = new Session('s-sub');
  session.addUserMessage('Report the file count.');

  const answer = await loop.run(session);

  assert.equal(typeof answer, 'string');
  assert.equal(llm.calls.length, 1, 'subagent finalizes without the gate');
});
