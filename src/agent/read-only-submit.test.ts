import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSubmitSolutionTool } from '../tools/submit-solution.js';

const answer = 'The string conflicts with the declared number type.';
const submit = (summary = answer) => ({ toolCalls: [{ name: 'submit_solution', args: { summary, resolutionType: 'investigation_only', verificationMethod: 'not_applicable' } }] });

class ScriptedReadOnlyLLM {
  calls = 0;
  prompts: string[] = [];
  declarations: string[][] = [];
  constructor(private readonly replies: any[]) {}
  async generate(session: Session, tools: any[]): Promise<any> {
    this.prompts.push(JSON.stringify(session.getHistory()));
    this.declarations.push(tools.map(tool => tool.name));
    const reply = this.replies[this.calls++];
    assert.ok(reply, 'Unexpected extra model call');
    return reply;
  }
}

test('every read-only control mode requires submit as the final tool, even after a direct answer', async () => {
  for (const toolControlMode of ['off', 'shadow', 'enforce'] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-submit-'));
    try {
      const workspace = new Workspace(root);
      const llm = new ScriptedReadOnlyLLM([{ text: answer, toolCalls: [] }, submit()]);
      const session = new Session();
      session.addUserMessage('Explain the type error; read only.');
      const loop = new AgentLoop(llm, new ToolRegistry(), { workspace, maxSteps: 4, toolControlMode });
      assert.equal(await loop.run(session), answer);
      assert.equal(llm.calls, 2);
      assert.match(llm.prompts[1], /STRONG ADVISORY.*SUBMIT/);
      assert.ok(llm.declarations.every(names => names.includes('submit_solution')));
      const calls = session.getEvents().filter(event => event.type === 'tool/call');
      assert.deepEqual(calls.map(event => event.data.toolName), ['submit_solution']);
      assert.ok(session.getEvents().some(event => event.type === 'tool/result' && event.data.result?.submitted === true));
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

test('read-only submit stays pinned when retrieval returns only a read tool, including cached steps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-retrieval-'));
  try {
    const workspace = new Workspace(root);
    await fs.writeFile(path.join(root, 'sample.txt'), 'hello');
    const registry = new ToolRegistry();
    registry.getRelevantTools = () => registry.getFunctionDeclarations().filter(tool => tool.name === 'read_file');
    const llm = new ScriptedReadOnlyLLM([
      { toolCalls: [{ name: 'read_file', args: { path: 'sample.txt' } }] },
      submit('The file contains hello.'),
    ]);
    const session = new Session();
    session.addUserMessage('Read sample.txt and explain its content; do not edit.');
    const loop = new AgentLoop(llm, registry, { workspace, maxSteps: 4, toolControlMode: 'enforce' });
    assert.equal(await loop.run(session), 'The file contains hello.');
    assert.ok(llm.declarations.every(names => names.includes('submit_solution')));
    assert.deepEqual(llm.declarations[0], llm.declarations[1], 'stable tool prefix on cached steps');
    assert.equal(session.getEvents().filter(event => event.type === 'tool/call').at(-1)?.data.toolName, 'submit_solution');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('read-only tool accepts a concise non-technical answer without fabricated verification', async () => {
  const workspace = new Workspace();
  const session = new Session();
  const tool = createSubmitSolutionTool(workspace);
  const result = await tool.execute({ summary: '2', resolutionType: 'investigation_only', verificationMethod: 'not_applicable' }, workspace, {
    session, turn: 1, userRequest: 'What is one plus one?',
  } as any);
  assert.equal(result.submitted, true);
  assert.deepEqual(result.filesModified, []);
  assert.equal(result.verificationEvidence, '');
  assert.doesNotMatch(result.message, /verified with empirical evidence/i);
});

test('failed submission and an old-turn receipt cannot authorize a direct final answer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-retry-'));
  try {
    const workspace = new Workspace(root);
    const session = new Session();
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    session.append('tool/call', { turn: 1, step: 1, toolCallId: 'old', toolName: 'submit_solution', args: { summary: answer } });
    session.append('tool/result', { turn: 1, step: 1, toolCallId: 'old', toolName: 'submit_solution', result: { success: true, submitted: true, summary: answer } });
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1 });
    session.addUserMessage('Explain the type error; read only.');
    const llm = new ScriptedReadOnlyLLM([submit('Done.'), { text: answer, toolCalls: [] }, submit()]);
    const loop = new AgentLoop(llm, new ToolRegistry(), { workspace, maxSteps: 4, agentId: 'subagent-readonly', enableSubagents: false });
    assert.equal(await loop.run(session), answer);
    assert.equal(llm.calls, 3);
    const events = session.getEvents();
    const turnStart = events.findIndex(event => event.type === 'turn/start' && event.data.turn === 2);
    assert.ok(turnStart >= 0);
    const results = events.slice(turnStart).filter(event => event.type === 'tool/result');
    assert.equal(results[0].data.result?.submitted, false);
    assert.equal(results[1].data.result?.submitted, true);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('non-editing answers require submission even without an explicit read-only phrase', async () => {
  for (const request of ['Summarize this type annotation.', 'Find the type error.']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-generic-'));
    try {
      const workspace = new Workspace(root);
      const llm = new ScriptedReadOnlyLLM([{ text: answer, toolCalls: [] }, submit()]);
      const session = new Session();
      session.addUserMessage(request);
      const loop = new AgentLoop(llm, new ToolRegistry(), { workspace, maxSteps: 4 });
      assert.equal(await loop.run(session), answer);
      assert.equal(llm.calls, 2);
      assert.equal(session.getEvents().filter(event => event.type === 'tool/call').at(-1)?.data.toolName, 'submit_solution');
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});

test('read-only completion still requires submission when auto-finalization is disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-no-auto-'));
  try {
    const workspace = new Workspace(root);
    const llm = new ScriptedReadOnlyLLM([{ text: answer, toolCalls: [] }, submit(), { text: answer, toolCalls: [] }]);
    const session = new Session();
    session.addUserMessage('Explain the type error; read only.');
    const loop = new AgentLoop(llm, new ToolRegistry(), { workspace, maxSteps: 4, enableSubmitAutoFinalization: false });
    assert.equal(await loop.run(session), answer);
    assert.equal(llm.calls, 3);
    assert.deepEqual(llm.declarations[2], [], 'no tool schemas after successful submission');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('read-only submit rejects stubs and fabricated execution claims', async () => {
  const workspace = new Workspace();
  const session = new Session();
  const tool = createSubmitSolutionTool(workspace);
  for (const summary of ['Done.', 'I will inspect the code tomorrow.', 'I ran tests and they passed.']) {
    const result = await tool.execute({ summary, resolutionType: 'investigation_only' }, workspace, {
      session, turn: 1, userRequest: 'Explain the code; read only.',
    } as any);
    assert.equal(result.submitted, false, summary);
  }
});

test('successful read-only submission stops tools in the same response batch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readonly-batch-'));
  try {
    const workspace = new Workspace(root);
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({ name: 'read_file', description: 'read', parameters: { type: 'OBJECT', properties: {} } as any, execute: async () => { executed = true; return { content: 'unused' }; } });
    const llm = new ScriptedReadOnlyLLM([{ toolCalls: [...submit().toolCalls, { name: 'read_file', args: {} }] }]);
    const session = new Session();
    session.addUserMessage('Explain the type error; read only.');
    const loop = new AgentLoop(llm, registry, { workspace, maxSteps: 3 });
    assert.equal(await loop.run(session), answer);
    assert.equal(executed, false);
    assert.equal(llm.calls, 1);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
