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
        name: 'replace_text',
        description: 'edit',
        parameters: { type: 'OBJECT', properties: {} } as any,
        execute: async () => ({ success: true, filesModified: ['a.ts'] }),
      });

      const summary = 'Completed fixes in a.ts with verification.';
      // Initial baseMaxSteps is 2.
      // Step 1: replace_text (mutation) -> triggers progress lease extension (+5 steps).
      // Step 2: replace_text (mutation) -> triggers progress lease extension (+5 steps).
      // Step 3: submit_solution (runs beyond initial budget of 2).
      const replies = [
        { toolCalls: [{ id: 'c1', name: 'replace_text', args: { path: 'a.ts' } }] },
        { toolCalls: [{ id: 'c2', name: 'replace_text', args: { path: 'b.ts' } }] },
        { toolCalls: [{ id: 'c3', name: 'submit_solution', args: { summary } }] },
      ];

      const llm = new ScriptedLLM(replies);
      const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 2, toolControlMode: 'off' });
      const session = new Session('session-lease-test');
      session.addUserMessage('Fix the issue in a.ts and b.ts /no-verify.', 'human');

      await loop.run(session, { maxSteps: 2 });
      // If leased extension worked, llm.calls must reach at least 3 despite initial maxSteps = 2
      assert.ok(llm.calls >= 3, `Should have executed at least 3 steps due to progress lease extension, got ${llm.calls}`);

      // Verify control/decision event logged the lease extension
      const leaseEvents = session.getEvents().filter((e) =>
        e.type === 'control/decision' && e.data?.controlDecision?.mode === 'step-lease-extension',
      );
      assert.ok(leaseEvents.length > 0, 'Expected at least one step-lease-extension control decision');
      assert.equal(leaseEvents[0]?.data?.controlDecision?.reason, 'file_mutated');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not extend maxSteps when no progress occurs', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-lease-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const registry = new ToolRegistry();
      let callCount = 0;
      registry.register({
        name: 'read_dummy',
        description: 'read dummy',
        parameters: { type: 'OBJECT', properties: {} } as any,
        execute: async () => {
          callCount++;
          return { data: `tick-${callCount}` };
        },
      });

      // Base budget = 2 steps.
      // Steps only call read_dummy without mutation or plan tasks.
      const replies = [
        { toolCalls: [{ id: 'c1', name: 'read_dummy', args: { query: '1' } }] },
        { toolCalls: [{ id: 'c2', name: 'read_dummy', args: { query: '2' } }] },
        { toolCalls: [{ id: 'c3', name: 'read_dummy', args: { query: '3' } }] },
        { toolCalls: [{ id: 'c4', name: 'read_dummy', args: { query: '4' } }] },
      ];

      const llm = new ScriptedLLM(replies);
      const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 2, toolControlMode: 'off' });
      const session = new Session('session-no-lease');
      session.addUserMessage('Investigate without changes', 'human');

      const result = await loop.run(session, { maxSteps: 2 });
      assert.ok(result.includes('maximum steps (2) reached'), `Expected maximum steps reached but got: ${result}`);
      assert.equal(llm.calls, 2, 'Should strictly stop at initial 2 steps when no progress occurs');

      // Verify no lease extension events were appended
      const leaseEvents = session.getEvents().filter((e) =>
        e.type === 'control/decision' && e.data?.controlDecision?.mode === 'step-lease-extension',
      );
      assert.equal(leaseEvents.length, 0, 'Should not grant any step lease when no progress occurred');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
