import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

class ScriptedCompletionLLM {
  calls = 0;
  constructor(private readonly replies: any[]) {}
  async generate(): Promise<any> {
    const reply = this.replies[this.calls++];
    if (reply) return reply;
    return { text: 'Done.', toolCalls: [] };
  }
}

function timeout<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${ms}ms`)), ms).unref?.();
  });
}

describe('Same-session run serialization', () => {
  it('two concurrent runs on one session never interleave turns', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-serial-'));
    try {
      const workspace = new Workspace(rootDir);
      const llm = new ScriptedCompletionLLM([
        { text: 'First task complete.', toolCalls: [] },
        { text: 'Second task complete.', toolCalls: [] },
      ]);
      const loop = new AgentLoop(llm as any, new ToolRegistry(), { workspace, maxSteps: 2 });
      const session = new Session(`session-serial-${Date.now()}`);
      session.addUserMessage('task one', 'human');

      const runA = loop.run(session, {});
      session.addUserMessage('task two', 'human');
      const runB = loop.run(session, {});
      await Promise.race([Promise.all([runA, runB]), timeout<never>(90000, 'concurrent runs')]);

      const markers = session
        .getEvents()
        .filter((e) => e.type === 'turn/start' || e.type === 'turn/end')
        .map((e) => `${e.type}:${(e.data as any)?.turn}`);
      assert.deepEqual(markers, ['turn/start:1', 'turn/end:1', 'turn/start:2', 'turn/end:2']);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('withSessionLock runs special flows FIFO per session id', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sess-lock-'));
    try {
      const { SessionManager } = await import('../session/session-manager.js');
      const manager = new SessionManager(rootDir);
      const order: string[] = [];
      const slow = manager.withSessionLock('s', async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push('slow');
      });
      const fast = manager.withSessionLock('s', async () => {
        order.push('fast');
      });
      const other = manager.withSessionLock('other', async () => {
        order.push('other');
      });
      await Promise.all([slow, fast, other]);
      assert.ok(order.indexOf('slow') < order.indexOf('fast'), `FIFO violated: ${order.join(',')}`);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
