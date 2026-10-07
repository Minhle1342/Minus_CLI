import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';

test('ready-to-submit enforces runtime scope even if a provider ignores forced choice and tool control is off', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-runtime-lock-'));
  try {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({ name: 'probe_tool', description: 'Inspect the probe.', parameters: { type: 'OBJECT', properties: {} } as any,
      execute: async () => { executed++; return { success: true }; } });
    const summary = 'The string conflicts with the declared number type.';
    const replies = [{ text: summary, toolCalls: [] }, { toolCalls: [{ name: 'probe_tool', args: {} }] },
      { toolCalls: [{ name: 'submit_solution', args: { summary } }] }];
    let calls = 0;
    const llm = { async generate() { return replies[calls++]; } };
    const session = new Session(); session.addUserMessage('Explain the type error; read only.');
    const loop = new AgentLoop(llm, registry, { workspace: new Workspace(root), maxSteps: 4, toolControlMode: 'off' });
    assert.equal(await loop.run(session), summary);
    assert.equal(executed, 0);
    assert.ok(session.getEvents().some(event => event.type === 'tool/result' && event.data.toolName === 'probe_tool'
      && event.data.result?.success === false));
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
