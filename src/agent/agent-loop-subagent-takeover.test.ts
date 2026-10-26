import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

function sessionText(session: Session): string {
  return JSON.stringify(session.getEvents());
}

async function withTempWorkspace(run: (workspace: Workspace) => Promise<void>): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeover-test-'));
  try {
    await run(new Workspace(rootDir));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('Subagent failure auto-continuation', () => {
  it('forces a takeover step when a failed spawn result is followed by a final answer', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return {
              text: 'Delegating',
              toolCalls: [{ id: 'call-1', name: 'spawn_agent', args: { brief: 'fix it' } }],
              finishReason: 'tool_calls',
            };
          }
          if (calls === 2) {
            return { text: 'The subagent failed, so I stopped.', toolCalls: [], finishReason: 'stop' };
          }
          return { text: 'Took over and finished the work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const registry = new ToolRegistry();
      registry.register({
        name: 'spawn_agent',
        description: 'Spawn a subagent',
        parameters: { type: 'object', properties: { brief: { type: 'string' } } } as any,
        execute: async () => ({
          success: false,
          status: 'failed',
          takeoverRequired: true,
          error: 'endpoint failed',
          handover: { objective: 'fix it', filesModified: [] },
          instruction: '[SUBAGENT FAILED (SELF-RELIANCE HANDOVER)]: take over now',
        }),
      });

      const loop = new AgentLoop(new MockLLM() as any, registry, { workspace, maxSteps: 6, enableSubagents: false });
      const session = new Session('takeover-sync');
      session.addUserMessage('Delegate the fix, then take over if it fails.');

      await loop.run(session);

      assert.equal(calls, 3, 'the loop must add one takeover step instead of ending after the failure');
      assert.match(sessionText(session), /TAKEOVER REQUIRED/);
      assert.match(sessionText(session), /Took over and finished the work/);
    });
  });

  it('forces a takeover step when a claimed subagent-failed notice is followed by a final answer', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return { text: 'Waiting for the background subagent.', toolCalls: [], finishReason: 'stop' };
          }
          return { text: 'Took over the background work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const loop = new AgentLoop(new MockLLM() as any, new ToolRegistry(), { workspace, maxSteps: 6 });
      const session = new Session('takeover-notice');
      session.addUserMessage('Run the background subagent.');
      loop.inbox.enqueue(
        session.id,
        '[SUBAGENT FAILED (SELF-RELIANCE HANDOVER)]: take over now',
        'system',
        { isSteering: true, kind: 'subagent-failed' },
      );

      await loop.run(session);

      assert.equal(calls, 2, 'the claimed failure notice must force one more step');
      assert.match(sessionText(session), /TAKEOVER REQUIRED/);
      assert.match(sessionText(session), /Took over the background work/);
    });
  });

  it('keeps the takeover pending after read-only tool calls', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return { text: 'Delegating', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { brief: 'fix it' } }], finishReason: 'tool_calls' };
          }
          if (calls === 2) {
            return { text: 'Checking', toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'notes.txt' } }], finishReason: 'tool_calls' };
          }
          if (calls === 3) {
            return { text: 'Nothing else to do.', toolCalls: [], finishReason: 'stop' };
          }
          return { text: 'Took over and finished the work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const registry = new ToolRegistry();
      registry.register({
        name: 'spawn_agent',
        description: 'Spawn a subagent',
        parameters: { type: 'object', properties: {} } as any,
        execute: async () => ({
          success: false,
          status: 'failed',
          takeoverRequired: true,
          error: 'endpoint failed',
          handover: { objective: 'fix it', filesModified: [] },
        }),
      });
      registry.register({
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } } as any,
        execute: async () => ({ success: true, content: 'notes' }),
      });

      const loop = new AgentLoop(new MockLLM() as any, registry, { workspace, maxSteps: 8, enableSubagents: false });
      const session = new Session('takeover-read-only');
      session.addUserMessage('Delegate the fix, then take over if it fails.');

      await loop.run(session);

      assert.equal(calls, 4, 'a read-only call must not count as takeover action');
      assert.match(sessionText(session), /TAKEOVER REQUIRED/);
    });
  });

  it('clears the takeover after a successful mutation', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return { text: 'Delegating', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { brief: 'fix it' } }], finishReason: 'tool_calls' };
          }
          if (calls === 2) {
            return { text: 'Fixing', toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'src/a.ts', content: 'x' } }], finishReason: 'tool_calls' };
          }
          return { text: 'Took over and finished the work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const registry = new ToolRegistry();
      registry.register({
        name: 'spawn_agent',
        description: 'Spawn a subagent',
        parameters: { type: 'object', properties: {} } as any,
        execute: async () => ({
          success: false,
          status: 'failed',
          takeoverRequired: true,
          error: 'endpoint failed',
          handover: { objective: 'fix it', filesModified: ['src/a.ts'] },
        }),
      });
      registry.register({
        name: 'write_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } as any,
        execute: async () => ({ success: true, path: 'src/a.ts' }),
      });

      const loop = new AgentLoop(new MockLLM() as any, registry, { workspace, maxSteps: 6, enableSubagents: false });
      const session = new Session('takeover-mutation');
      session.addUserMessage('Delegate the fix, then take over if it fails.');

      await loop.run(session);

      assert.equal(calls, 3, 'a mutation on a handover file proves takeover; no forced step');
      assert.doesNotMatch(sessionText(session), /TAKEOVER REQUIRED/);
    });
  });

  it('clears the takeover after reading a handover file', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return { text: 'Delegating', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { brief: 'fix it' } }], finishReason: 'tool_calls' };
          }
          if (calls === 2) {
            return { text: 'Checking', toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'src/a.ts' } }], finishReason: 'tool_calls' };
          }
          return { text: 'Took over and finished the work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const registry = new ToolRegistry();
      registry.register({
        name: 'spawn_agent',
        description: 'Spawn a subagent',
        parameters: { type: 'object', properties: {} } as any,
        execute: async () => ({
          success: false,
          status: 'failed',
          takeoverRequired: true,
          error: 'endpoint failed',
          handover: { objective: 'fix it', filesModified: ['src/a.ts'] },
        }),
      });
      registry.register({
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } } as any,
        execute: async () => ({ success: true, content: 'notes' }),
      });

      const loop = new AgentLoop(new MockLLM() as any, registry, { workspace, maxSteps: 6, enableSubagents: false });
      const session = new Session('takeover-read-handover');
      session.addUserMessage('Delegate the fix, then take over if it fails.');

      await loop.run(session);

      assert.equal(calls, 3, 'reading a handover file proves takeover; no forced step');
      assert.doesNotMatch(sessionText(session), /TAKEOVER REQUIRED/);
    });
  });

  it('keeps the takeover pending after mutating an unrelated file', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return { text: 'Delegating', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { brief: 'fix it' } }], finishReason: 'tool_calls' };
          }
          if (calls === 2) {
            return { text: 'Fixing something else', toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'src/b.ts', content: 'x' } }], finishReason: 'tool_calls' };
          }
          if (calls === 3) {
            return { text: 'Nothing else to do.', toolCalls: [], finishReason: 'stop' };
          }
          return { text: 'Took over and finished the work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const registry = new ToolRegistry();
      registry.register({
        name: 'spawn_agent',
        description: 'Spawn a subagent',
        parameters: { type: 'object', properties: {} } as any,
        execute: async () => ({
          success: false,
          status: 'failed',
          takeoverRequired: true,
          error: 'endpoint failed',
          handover: { objective: 'fix it', filesModified: ['src/a.ts'] },
        }),
      });
      registry.register({
        name: 'write_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } as any,
        execute: async () => ({ success: true, path: 'src/b.ts' }),
      });

      const loop = new AgentLoop(new MockLLM() as any, registry, { workspace, maxSteps: 8, enableSubagents: false });
      const session = new Session('takeover-unrelated-mutation');
      session.addUserMessage('Delegate the fix, then take over if it fails.');

      await loop.run(session);

      assert.equal(calls, 4, 'an unrelated mutation must not count as takeover action');
      assert.match(sessionText(session), /TAKEOVER REQUIRED/);
    });
  });

  it('clears the takeover after a mutation when the handover lists no files', async () => {
    await withTempWorkspace(async (workspace) => {
      let calls = 0;
      class MockLLM {
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 200000, maxOutputTokens: 8192 }; }
        async generateStream(): Promise<any> {
          calls++;
          if (calls === 1) {
            return { text: 'Delegating', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { brief: 'fix it' } }], finishReason: 'tool_calls' };
          }
          if (calls === 2) {
            return { text: 'Writing the fix', toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'src/new.ts', content: 'x' } }], finishReason: 'tool_calls' };
          }
          return { text: 'Took over and finished the work.', toolCalls: [], finishReason: 'stop' };
        }
      }

      const registry = new ToolRegistry();
      registry.register({
        name: 'spawn_agent',
        description: 'Spawn a subagent',
        parameters: { type: 'object', properties: {} } as any,
        execute: async () => ({
          success: false,
          status: 'failed',
          takeoverRequired: true,
          error: 'endpoint failed',
          handover: { objective: 'fix it', filesModified: [] },
        }),
      });
      registry.register({
        name: 'write_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } as any,
        execute: async () => ({ success: true, path: 'src/new.ts' }),
      });

      const loop = new AgentLoop(new MockLLM() as any, registry, { workspace, maxSteps: 6, enableSubagents: false });
      const session = new Session('takeover-empty-handover');
      session.addUserMessage('Delegate the fix, then take over if it fails.');

      await loop.run(session);

      assert.equal(calls, 3, 'with no handover baseline, any mutation proves takeover');
      assert.doesNotMatch(sessionText(session), /TAKEOVER REQUIRED/);
    });
  });
});
