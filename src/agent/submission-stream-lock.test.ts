import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';

test('ready state blocks early streaming and concurrent read dispatch, not only sequential calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-stream-lock-'));
  try {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({ name: 'read_file', description: 'Read a file.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } as any,
      execute: async () => { executed++; return { success: true, content: 'probe' }; } });
    const summary = 'The string conflicts with the declared number type.';
    let calls = 0;
    const llm = { async generateStream(_session: Session, _tools: any[], callbacks: any, request: any) {
      calls++;
      if (calls === 1) return { text: summary, toolCalls: [] };
      if (calls === 2) {
        assert.equal(request.functionCallingMode, 'ANY');
        const early = { id: 'early-read', name: 'read_file', args: { path: 'a.ts' } };
        callbacks.onToolCallEarly(early);
        return { toolCalls: [early, { id: 'second-read', name: 'read_file', args: { path: 'b.ts' } }] };
      }
      return { toolCalls: [{ name: 'submit_solution', args: { summary } }] };
    } };
    const session = new Session(); session.addUserMessage('Explain the type error; read only.');
    const loop = new AgentLoop(llm, registry, { workspace: new Workspace(root), maxSteps: 4, toolControlMode: 'off' });
    assert.equal(await loop.run(session), summary);
    assert.equal(executed, 0);
    assert.equal(session.getEvents().filter(event => event.type === 'tool/result'
      && event.data.result?.errorCode === 'READY_TO_SUBMIT_TOOL_BLOCKED').length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
