import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { CLI } from '../ui/cli-ui.js';

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
        } as any,
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
      (loop as any).toolRegistry.register({
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
        } as any,
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

  it('KV Cache Fix: Tool declarations remain 100% byte-for-byte identical across turn steps', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-cache-test-'));
    try {
      const workspace = new Workspace(rootDir);
      const toolSnapshots: string[] = [];

      class ToolTrackingLLM {
        calls = 0;
        modelName = 'test-model';
        getTokenConfig() { return { maxInputTokens: 8192, maxOutputTokens: 2048 }; }
        async generateStream(_session: Session, tools: any[]): Promise<any> {
          toolSnapshots.push(JSON.stringify(tools));
          if (this.calls === 0) {
            this.calls++;
            return {
              text: 'Reading file',
              toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'test.txt' } }],
              finishReason: 'tool_calls',
            };
          }
          if (this.calls === 1) {
            this.calls++;
            return {
              text: 'Executing command',
              toolCalls: [{ id: 'call-2', name: 'run_command', args: { command: 'echo ok' } }],
              finishReason: 'tool_calls',
            };
          }
          return {
            text: 'Completed verification.',
            toolCalls: [],
            finishReason: 'stop',
          };
        }
      }

      await fs.writeFile(path.join(rootDir, 'test.txt'), 'hello world', 'utf8');
      const llm = new ToolTrackingLLM();
      const registry = new ToolRegistry();
      registry.register({
        name: 'read_file',
        description: 'Read file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } } as any,
        execute: async () => ({ success: true, content: 'hello' }),
      });
      registry.register({
        name: 'run_command',
        description: 'Run command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } } as any,
        execute: async () => ({ success: true, exitCode: 0, stdout: 'ok' }),
      });

      const loop = new AgentLoop(llm as any, registry, {
        workspace,
        maxSteps: 5,
        enableDynamicToolRetrieval: true,
      });

      const session = new Session('session-kv-cache-test');
      session.addUserMessage('Please inspect test.txt and run verification.');

      await loop.run(session);

      assert.equal(toolSnapshots.length >= 3, true, 'At least 3 steps must have executed');
      assert.equal(
        toolSnapshots[0],
        toolSnapshots[1],
        'Step 1 and Step 2 tool declarations must be 100% byte-for-byte identical (KV Cache Prefix Invariance)',
      );
      assert.equal(
        toolSnapshots[1],
        toolSnapshots[2],
        'Step 2 and Step 3 tool declarations must be 100% byte-for-byte identical (KV Cache Prefix Invariance)',
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('Fix 8: Compact mode renders each concurrent read once (no duplicate tool lines)', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-dup-test-'));
    const origRenderToolCall = CLI.renderToolCall;
    const origOneLiner = CLI.renderCompactOneLiner;
    const origDotSpinner = CLI.startToolDotSpinner;
    const origStopDotSpinner = CLI.stopToolDotSpinner;
    try {
      const workspace = new Workspace(rootDir);
      const llm = new ScriptedCompletionLLM([
        {
          text: '',
          toolCalls: [
            { id: 'call-a', name: 'read_file', args: { path: 'a.ts' } },
            { id: 'call-b', name: 'read_file', args: { path: 'b.ts' } },
          ],
        },
        { text: 'Both files inspected.', toolCalls: [] },
      ]);
      const registry = new ToolRegistry();
      registry.register({
        name: 'read_file',
        description: 'Read file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        } as any,
        execute: async (args: any) => ({ content: `content of ${args.path}` }),
      });
      const loop = new AgentLoop(llm as any, registry, {
        workspace,
        enableConcurrentReadTools: true,
        maxSteps: 3,
      });
      loop.setCollapsePreferences({ compactSteps: true });

      let renderToolCallCount = 0;
      let oneLinerCount = 0;
      (CLI as any).renderToolCall = () => { renderToolCallCount++; };
      (CLI as any).renderCompactOneLiner = () => { oneLinerCount++; };
      (CLI as any).startToolDotSpinner = () => {};
      (CLI as any).stopToolDotSpinner = () => {};

      const session = new Session('session-compact-dup-test');
      session.addUserMessage('Read both files.');
      await loop.run(session);

      const toolResults = session.getEvents().filter((e) => e.type === 'tool/result');
      assert.equal(toolResults.length, 2, 'both parallel reads must complete');
      assert.equal(renderToolCallCount, 0, 'compact mode must not emit verbose call lines for concurrent reads');
      assert.equal(oneLinerCount, 2, 'compact mode must emit exactly one line per concurrent read');
    } finally {
      (CLI as any).renderToolCall = origRenderToolCall;
      (CLI as any).renderCompactOneLiner = origOneLiner;
      (CLI as any).startToolDotSpinner = origDotSpinner;
      (CLI as any).stopToolDotSpinner = origStopDotSpinner;
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
