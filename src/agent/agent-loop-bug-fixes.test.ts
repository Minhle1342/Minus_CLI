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
  prompts: string[] = [];
  constructor(private readonly replies: any[]) {}
  async generate(session: Session): Promise<any> {
    this.prompts.push(JSON.stringify(session.getHistory()));
    const reply = this.replies[this.calls++];
    if (!reply) {
      return { text: 'AgentLoop coordinates tools and completion.', toolCalls: [] };
    }
    return reply;
  }
}

describe('AgentLoop Bug Fixes Verification', () => {
  it('Fix 4: Circuit breaker retries are scoped per session and isolated', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const llm = new ScriptedCompletionLLM([]);
      const registry = new ToolRegistry();
      const loop = new AgentLoop(llm as any, registry, { workspace });

      const s1 = new Session('session-cb-1');
      const s2 = new Session('session-cb-2');

      const loopAny = loop as any;
      assert.equal(loopAny.getCircuitBreakerRetries(s1.id), 0);
      assert.equal(loopAny.getCircuitBreakerRetries(s2.id), 0);

      loopAny.setCircuitBreakerRetries(s1.id, 2);
      assert.equal(loopAny.getCircuitBreakerRetries(s1.id), 2);
      assert.equal(loopAny.getCircuitBreakerRetries(s2.id), 0, 'Session 2 must not be affected by session 1');

      loopAny.setCircuitBreakerRetries(s1.id, 0);
      assert.equal(loopAny.getCircuitBreakerRetries(s1.id), 0);
      assert.equal(loopAny.circuitBreakerRetriesBySession.has(s1.id), false, '0 count deletes entry from Map');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Fix 1: Steer promises are rejected upon cancellation or abnormal turn completion', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steer-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const llm = new ScriptedCompletionLLM([]);
      const registry = new ToolRegistry();
      const loop = new AgentLoop(llm as any, registry, { workspace });

      const session = new Session('session-steer-test');
      session.addUserMessage('Explain the architecture in one sentence.');

      let rejectedError: any = null;
      const steerItem = loop.inbox.enqueue(session.id, 'Steer prompt', 'human', { isSteering: true });
      steerItem.promise.then(
        () => {},
        (err) => { rejectedError = err; },
      );

      const controller = new AbortController();
      controller.abort();

      const result = await loop.run(session, { signal: controller.signal });
      assert.match(result, /cancellation requested/i);

      await new Promise((r) => setTimeout(r, 20));
      assert.ok(rejectedError !== null, 'Steer promise must be rejected on abort, not hang');
      assert.match(rejectedError.message, /cancellation requested|Agent execution cancelled|Agent turn ended/);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Fix 2: Concurrent-read partition blocks executions after submit_solution', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-sub-test-'));
    try {
      const workspace = new Workspace(rootDir);
      let readFileExecuted = false;
      const llm = new ScriptedCompletionLLM([
        {
          text: '',
          toolCalls: [
            {
              id: 'call-submit',
              name: 'submit_solution',
              args: { summary: 'Completed task and verified architecture.' },
            },
            {
              id: 'call-read',
              name: 'read_file',
              args: { path: 'package.json' },
            },
          ],
        },
        {
          text: 'AgentLoop coordinates tools and completion.',
          toolCalls: [],
        },
      ]);

      const registry = new ToolRegistry();
      registry.register({
        name: 'read_file',
        description: 'Read file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: async () => {
          readFileExecuted = true;
          return { content: '{}' };
        },
      });

      const loop = new AgentLoop(llm as any, registry, {
        workspace,
        enableConcurrentReadTools: true,
        maxSteps: 3,
      });
      const session = new Session('session-post-sub-test');
      session.addUserMessage('Explain the architecture in one sentence.');

      await loop.run(session);
      assert.equal(readFileExecuted, false, 'read_file must NOT be executed after submit_solution');

      const toolResults = session.getEvents().filter((e) => e.type === 'tool/result');
      const blockedResult = toolResults.find((e: any) => e.data?.result?.errorCode === 'POST_SUBMISSION_TOOL_CALL_BLOCKED');
      assert.ok(blockedResult, 'Expected POST_SUBMISSION_TOOL_CALL_BLOCKED in tool results');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Fix 6: Subagent abort propagation stops all child subagents', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const llm = new ScriptedCompletionLLM([]);
      const registry = new ToolRegistry();
      const loop = new AgentLoop(llm as any, registry, { workspace });

      const controller = new AbortController();
      const loopAny = loop as any;
      const session = new Session('session-subagent');

      const childLoop = loopAny.createSubagentLoop(
        'subagent-test',
        session,
        { brief: 'Test child' },
        controller.signal,
      );

      let stoppedAllCalled = false;
      childLoop.subagentManager.stopAll = () => {
        stoppedAllCalled = true;
        return 1;
      };

      controller.abort();
      assert.equal(stoppedAllCalled, true, 'SubagentManager.stopAll must be called when signal aborts');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Fix 7: Refuted hypothesis triggers rollbackOrchestrator and injects guidance', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hypo-test-'));
    try {
      const workspace = new Workspace(rootDir);
      let rollbackTriggered = false;
      let rolledBackHypothesisId = '';

      const llm = new ScriptedCompletionLLM([
        {
          text: '',
          toolCalls: [
            {
              id: 'call-hypo',
              name: 'formulate_and_verify_hypothesis',
              args: {
                statement: 'Hypothesis statement for verification.',
                falsificationTest: 'Run npm test to verify',
                targetFiles: ['src/index.ts'],
                evidence: 'Observed error in src/index.ts',
              },
            },
          ],
        },
        {
          text: 'AgentLoop coordinates tools and completion.',
          toolCalls: [],
        },
      ]);

      const registry = new ToolRegistry();
      const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 3 });
      loop.toolRegistry.register({
        name: 'formulate_and_verify_hypothesis',
        description: 'Hypothesis tool',
        parameters: {
          type: 'object',
          properties: {
            statement: { type: 'string' },
            falsificationTest: { type: 'string' },
            targetFiles: { type: 'array' },
            evidence: { type: 'string' },
          },
          additionalProperties: true,
        },
        execute: async () => ({
          success: true,
          hypothesisId: 'H-999',
          status: 'refuted',
        }),
      });
      const loopAny = loop as any;
      loopAny.rollbackOrchestrator.rollbackOnFalsifiedHypothesis = async (id: string) => {
        rollbackTriggered = true;
        rolledBackHypothesisId = id;
        return { rolledBack: true, reason: 'Test rollback', guidancePrompt: 'Guidance after rollback' };
      };

      const session = new Session('session-hypo-test');
      session.addUserMessage('Explain the architecture in one sentence.');

      await loop.run(session);
      assert.equal(rollbackTriggered, true, 'rollbackOnFalsifiedHypothesis must be called when status is refuted');
      assert.equal(rolledBackHypothesisId, 'H-999', 'Should roll back the refuted hypothesis ID');

      const toolResults = session.getEvents().filter((e) => e.type === 'tool/result');
      const hypoResult = toolResults.find((e: any) => e.data?.toolName === 'formulate_and_verify_hypothesis');
      assert.equal((hypoResult?.data?.result as any)?._system_hypothesis_rollback, 'Guidance after rollback');
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
