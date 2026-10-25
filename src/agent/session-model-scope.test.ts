import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';

class NamedMockLLM {
  readonly calls: string[] = [];
  constructor(readonly modelName: string) {}
  async generate(session: Session): Promise<any> {
    this.calls.push(session.id);
    return {
      text: 'The string conflicts with the declared number type.',
      toolCalls: [],
    };
  }
}

function testLoop(llm: any, extraOptions: Record<string, any> = {}) {
  return new AgentLoop(llm, new ToolRegistry(), {
    workspace: new Workspace(process.cwd()),
    maxSteps: 4,
    ...extraOptions,
  } as any);
}

describe('per-session-tab model scoping', () => {
  it('parallel tabs run with their own LLM (no shared this.llm race)', async () => {
    const mockA = new NamedMockLLM('mock-a');
    const mockB = new NamedMockLLM('mock-b');
    const loop = testLoop(mockA as any);
    const sessA = new Session('tab-a');
    const sessB = new Session('tab-b');
    sessA.addUserMessage('task a', 'human');
    sessB.addUserMessage('task b', 'human');

    await loop.setSessionLLM(sessB, mockB as any, 'mock-b');
    assert.equal(sessB.getModelName(), 'mock-b');
    assert.equal(loop.getSessionModelName('tab-b'), 'mock-b');
    assert.equal(loop.getSessionModelName('tab-a'), undefined);

    const [answerA, answerB] = await Promise.all([loop.run(sessA, {}), loop.run(sessB, {})]);
    assert.ok(answerA.includes('conflicts with the declared number type'));
    assert.ok(answerB.includes('conflicts with the declared number type'));
    assert.deepEqual(mockA.calls, ['tab-a']);
    assert.deepEqual(mockB.calls, ['tab-b']);
  });

  it('restores a persisted per-tab model via factory after restart', async () => {
    const mockA = new NamedMockLLM('mock-a');
    const mockB = new NamedMockLLM('mock-b');
    const first = testLoop(mockA as any);
    const sess = new Session('tab-restart');
    sess.addUserMessage('task', 'human');
    await first.setSessionLLM(sess, mockB as any, 'mock-b');

    // Fresh loop, empty registry: only the persisted model/change event + factory remain.
    const second = testLoop(mockA as any, {
      createSessionLLM: async (name: string) => (name === 'mock-b' ? mockB : undefined),
    });
    assert.equal(second.getSessionModelName('tab-restart'), undefined);
    const answer = await second.run(sess, {});
    assert.ok(answer.includes('conflicts with the declared number type'));
    assert.deepEqual(mockB.calls, ['tab-restart']);
    assert.deepEqual(mockA.calls, []);
    assert.equal(second.getSessionModelName('tab-restart'), 'mock-b');
  });

  it('falls back to the default model when no factory can recreate', async () => {
    const mockA = new NamedMockLLM('mock-a');
    const loop = testLoop(mockA as any); // no factory
    const sess = new Session('tab-fallback');
    sess.addUserMessage('task', 'human');
    sess.append('model/change', { modelName: 'gone-model' });
    const answer = await loop.run(sess, {});
    assert.ok(answer.includes('conflicts with the declared number type'));
    assert.deepEqual(mockA.calls, ['tab-fallback']);
  });

  it('subagent loops inherit the parent tab model', async () => {
    const mockA = new NamedMockLLM('mock-a');
    const mockB = new NamedMockLLM('mock-b');
    const loop = testLoop(mockA as any);
    const parent = new Session('tab-parent');
    await loop.setSessionLLM(parent, mockB as any, 'mock-b');
    const execSession = new Session('session-sub-1');
    const child = (loop as unknown as {
      createSubagentLoop: (id: string, s: Session, o: Record<string, any>, sig: AbortSignal) => AgentLoop;
    }).createSubagentLoop('sub-1', execSession, { parentSessionId: 'tab-parent' }, new AbortController().signal);
    assert.equal((child as any).llm, mockB);
    const defaultChild = (loop as unknown as {
      createSubagentLoop: (id: string, s: Session, o: Record<string, any>, sig: AbortSignal) => AgentLoop;
    }).createSubagentLoop('sub-2', execSession, {}, new AbortController().signal);
    assert.equal((defaultChild as any).llm, mockA);
  });

  it('evictSessionState drops the per-tab override', async () => {
    const mockA = new NamedMockLLM('mock-a');
    const mockB = new NamedMockLLM('mock-b');
    const loop = testLoop(mockA as any);
    const sess = new Session('tab-evict');
    await loop.setSessionLLM(sess, mockB as any, 'mock-b');
    (loop as unknown as { activeSession?: Session }).activeSession = new Session('other');
    loop.evictSessionState('tab-evict');
    assert.equal(loop.getSessionModelName('tab-evict'), undefined);
  });
});
