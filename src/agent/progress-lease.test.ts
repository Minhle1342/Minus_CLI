import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

class ScriptedLLM {
  calls = 0;
  constructor(private readonly replies: any[]) {}
  async generate(): Promise<any> {
    const reply = this.replies[this.calls++];
    if (!reply) {
      return { text: 'Done', toolCalls: [] };
    }
    return reply;
  }
}

describe('Progress-Leased Step Extension', () => {
  it('extends maxSteps when a file is modified during execution', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lease-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const registry = new ToolRegistry();
      registry.register({
        name: 'write_file',
        description: 'write file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
        execute: async (args: any) => {
          const filePath = path.join(rootDir, args.path);
          await fs.writeFile(filePath, args.content || 'hello');
          return { success: true, path: args.path };
        },
      });

      // Initial budget is 2 steps.
      // Step 1: LLM calls write_file -> progress -> extends effectiveMaxSteps by 5 (now at least 7).
      // Step 2: LLM continues without stopping at step 2.
      // Step 3: LLM provides final answer.
      const replies = [
        { text: 'writing file', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'test.txt', content: 'test' } }] },
        { text: 'verifying progress', toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'test2.txt', content: 'test2' } }] },
        { text: 'Task completed successfully with evidence.', toolCalls: [] },
      ];

      const llm = new ScriptedLLM(replies);
      const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 2, toolControlMode: 'off' });
      const session = new Session('session-lease-test');
      session.addUserMessage('Create test files and finish', 'human');

      const result = await loop.run(session, { maxSteps: 2 });
      assert.ok(result.includes('Task completed successfully'), `Expected final answer but got: ${result}`);
      assert.equal(llm.calls, 3, 'Should have executed 3 steps due to progress lease extension');

      // Verify control/decision event logged the lease extension
      const leaseEvents = session.getEvents().filter((e) =>
        e.type === 'control/decision' && e.data?.controlDecision?.mode === 'step-lease-extension',
      );
      assert.ok(leaseEvents.length > 0, 'Expected at least one step-lease-extension control decision');
      assert.equal(leaseEvents[0].data.controlDecision.reason, 'file_mutated');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not extend maxSteps when no progress occurs', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-lease-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const registry = new ToolRegistry();
      registry.register({
        name: 'read_dummy',
        description: 'read dummy',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ data: 'nothing changed' }),
      });

      // Budget is 2 steps. LLM does non-mutating tool calls.
      const replies = [
        { text: 'reading', toolCalls: [{ id: 'c1', name: 'read_dummy', args: {} }] },
        { text: 'reading again', toolCalls: [{ id: 'c2', name: 'read_dummy', args: {} }] },
        { text: 'reading third time', toolCalls: [{ id: 'c3', name: 'read_dummy', args: {} }] },
      ];

      const llm = new ScriptedLLM(replies);
      const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 2, toolControlMode: 'off' });
      const session = new Session('session-no-lease');
      session.addUserMessage('Investigate without changes', 'human');

      const result = await loop.run(session, { maxSteps: 2 });
      assert.ok(result.includes('maximum steps'), `Expected maximum steps reached but got: ${result}`);
      assert.equal(llm.calls, 2, 'Should not exceed initial 2 steps when no progress occurs');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
