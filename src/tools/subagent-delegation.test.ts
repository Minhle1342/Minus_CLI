import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SubagentManager } from '../agent/subagent-manager.js';
import { AgentRegistry } from '../agent/agent-registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { createGetAgentResultTool, createSpawnAgentTool } from './subagent-tools.js';

describe('Satellite 5: Synchronous Subagent Task Delegation', () => {
  it('Scenario 1: Subagent chạy độc lập tiêu tốn nhiều thao tác nội bộ -> kết quả tóm tắt ≤ 1600 chars, context cha không bị ô nhiễm', async () => {
    const parentSession = new Session('parent-session-1');
    parentSession.append('user/message', {
      content: { role: 'user', parts: [{ text: 'Main user goal' }] },
    });

    const registry = new AgentRegistry();
    const manager = new SubagentManager(
      registry,
      ((agentId: string, childSession: Session) => ({
        submit: async () => {
          // Simulate subagent making multiple internal tool calls
          for (let i = 0; i < 5; i++) {
            childSession.append('tool/call', {
              toolCallId: `call_${i}`,
              toolName: 'read_file',
              args: { path: `src/internal_${i}.ts` },
            });
            childSession.append('tool/result', {
              toolCallId: `call_${i}`,
              result: { content: 'huge internal file content '.repeat(200) },
            });
          }
          // Produce a long output exceeding 1,600 characters
          return 'Internal finding result: ' + 'A'.repeat(3000);
        },
      })) as any,
    );

    manager.bindSession(parentSession);

    const result = await manager.executeIsolatedTask('Investigate components', {
      maxSteps: 6,
    });

    assert.equal(result.success, true);
    assert.ok(result.summary.length <= 1700, `Summary length was ${result.summary.length}`);
    assert.ok(result.summary.includes('[TRUNCATED: Subagent summary exceeded 1,600 chars]'));

    // Verify parent session was NOT polluted with subagent tool calls
    const parentToolCalls = parentSession.getEvents().filter((e) => e.type === 'tool/call');
    assert.equal(parentToolCalls.length, 0, 'Parent session must not contain subagent internal tool calls');
  });

  it('Scenario 2: filesModified được trích xuất chính xác từ các tool calls của subagent', async () => {
    const parentSession = new Session('parent-session-2');
    const registry = new AgentRegistry();
    const manager = new SubagentManager(
      registry,
      ((agentId: string, childSession: Session) => ({
        submit: async () => {
          childSession.append('tool/call', {
            toolCallId: 'call_edit_1',
            toolName: 'write_file',
            args: { path: 'src/utils/math.ts', content: 'export const add = 1;' },
          });
          childSession.append('tool/call', {
            toolCallId: 'call_edit_2',
            toolName: 'replace_file_content',
            args: { TargetFile: 'src/components/button.tsx' },
          });
          return 'Files created and updated successfully.';
        },
      })) as any,
    );

    manager.bindSession(parentSession);

    const result = await manager.executeIsolatedTask('Fix math utility and button component');

    assert.equal(result.success, true);
    assert.deepEqual(result.filesModified.sort(), ['src/components/button.tsx', 'src/utils/math.ts'].sort());
    assert.equal(result.summary, 'Files created and updated successfully.');
  });

  it('Scenario 3: spawn_agent trả về handover packet tự thân vận động khi subagent gặp lỗi kết nối', async () => {
    const parentSession = new Session('parent-session-3');
    const registry = new AgentRegistry();
    const manager = new SubagentManager(
      registry,
      ((agentId: string, childSession: Session) => ({
        submit: async () => {
          childSession.append('tool/call', {
            toolCallId: 'call_1',
            toolName: 'read_file',
            args: { path: 'src/config.ts' },
          });
          childSession.append('tool/result', {
            toolCallId: 'call_1',
            toolName: 'read_file',
            result: { success: true },
          });
          childSession.append('tool/call', {
            toolCallId: 'call_2',
            toolName: 'write_file',
            args: { path: 'src/partial.ts', content: 'test' },
          });
          childSession.append('tool/result', {
            toolCallId: 'call_2',
            toolName: 'write_file',
            result: { success: true, filesModified: ['src/partial.ts'] },
          });
          throw new Error('LLM provider error: 503 Service Unavailable after 3 retries');
        },
      })) as any,
    );
    manager.bindSession(parentSession);

    const tool = createSpawnAgentTool(manager);
    const executionResult = await tool.execute({
      brief: 'Update partial configuration',
      wait: true,
      timeoutMs: 5000,
    }, new Workspace('.'));

    assert.equal(executionResult.success, false);
    assert.equal(executionResult.status, 'failed');
    assert.ok(executionResult.instruction.includes('SUBAGENT FAILED'));
    // The parent must take over automatically instead of asking the user to re-run.
    assert.match(executionResult.instruction, /take over now/i);
    assert.ok(executionResult.handover);
    assert.equal(executionResult.handover.objective, 'Update partial configuration');
    assert.deepEqual(executionResult.handover.filesModified, ['src/partial.ts']);
    assert.equal(executionResult.handover.toolCalls.length, 2);
    assert.equal(executionResult.handover.toolCalls[0].toolName, 'read_file');
    assert.equal(executionResult.handover.toolCalls[0].status, 'PASS');
    assert.equal(executionResult.handover.toolCalls[1].toolName, 'write_file');
    assert.equal(executionResult.handover.toolCalls[1].status, 'PASS');
    // File bodies are dropped from the handover; only the path survives.
    assert.deepEqual(executionResult.handover.toolCalls[1].args, { path: 'src/partial.ts' });
  });

  it('Scenario 4: spawn_agent hỗ trợ cờ wait (async khi false, sync block khi true)', async () => {
    const parentSession = new Session('parent-session-4');
    const registry = new AgentRegistry();
    let ranTask = false;
    const manager = new SubagentManager(
      registry,
      ((agentId: string, childSession: Session) => ({
        submit: async () => {
          ranTask = true;
          return 'Subagent completed successfully.';
        },
      })) as any,
    );
    manager.bindSession(parentSession);

    const spawnTool = createSpawnAgentTool(manager);
    assert.equal(spawnTool.name, 'spawn_agent');

    // 1. Asynchronous (wait: false / omitted)
    const asyncResult = await spawnTool.execute({
      brief: 'Async background reconnaissance',
      wait: false,
    }, new Workspace('.'));

    assert.equal(asyncResult.success, true);
    assert.ok(asyncResult.agentId);
    assert.equal(asyncResult.agent.status, 'running');

    // 2. Synchronous (wait: true)
    const syncResult = await spawnTool.execute({
      brief: 'Synchronous blocking task',
      wait: true,
      timeoutMs: 5000,
    }, new Workspace('.'));

    assert.equal(syncResult.success, true);
    assert.ok(syncResult.agentId);
    assert.equal(syncResult.completed, true);
    assert.equal(syncResult.answer, 'Subagent completed successfully.');
    assert.equal(syncResult.agent, undefined, 'the full handle duplicates answer/handover');
  });

  it('Scenario 5: wait timeout stops the subagent instead of leaving it mutating files', async () => {
    const manager = new SubagentManager(
      new AgentRegistry(),
      (() => ({ submit: () => new Promise(() => {}) })) as any,
    );
    manager.bindSession(new Session('parent-session-5'));

    const tool = createSpawnAgentTool(manager);
    const result = await tool.execute({ brief: 'Long task', wait: true, timeoutMs: 20 }, new Workspace('.'));

    assert.equal(result.success, false);
    assert.match(result.instruction, /TIMED OUT/);
    assert.equal(manager.get(result.agentId)?.status, 'stopped');
  });

  it('Scenario 6: aborting the turn stops a synchronous wait', async () => {
    const manager = new SubagentManager(
      new AgentRegistry(),
      (() => ({ submit: () => new Promise(() => {}) })) as any,
    );
    manager.bindSession(new Session('parent-session-6'));
    const controller = new AbortController();
    controller.abort();

    const tool = createSpawnAgentTool(manager);
    const result = await tool.execute(
      { brief: 'Aborted task', wait: true },
      new Workspace('.'),
      { signal: controller.signal },
    );

    assert.equal(result.aborted, true);
    assert.equal(manager.get(result.agentId)?.status, 'stopped');
  });

  it('Scenario 7: an awaited result does not also enqueue a completion notice', async () => {
    let completions = 0;
    const manager = new SubagentManager(
      new AgentRegistry(),
      (() => ({ submit: async () => 'done' })) as any,
      undefined,
      undefined,
      () => { completions++; },
    );
    manager.bindSession(new Session('parent-session-7'));

    const tool = createSpawnAgentTool(manager);
    const result = await tool.execute({ brief: 'Sync task', wait: true, timeoutMs: 5000 }, new Workspace('.'));

    assert.equal(result.success, true);
    assert.equal(completions, 0);
  });

  it('Scenario 8: get_agent_result flags takeover for a failed agent', async () => {
    const tool = createGetAgentResultTool({
      get: () => ({ status: 'failed', handover: { filesModified: ['src/a.ts'] } }),
    } as any);
    const result = await tool.execute({ agentId: 'a1' }, new Workspace('.'));

    assert.equal(result.takeoverRequired, true);
    assert.deepEqual(result.handover.filesModified, ['src/a.ts']);
  });
});
