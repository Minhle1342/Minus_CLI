import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SubagentManager } from '../agent/subagent-manager.js';
import { AgentRegistry } from '../agent/agent-registry.js';
import { Session } from '../session/session.js';
import { Workspace } from '../workspace/workspace.js';
import { createDelegateTaskTool } from './subagent-tools.js';

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

  it('Scenario 3: delegate_task ToolDefinition thực thi đúng cấu trúc schema và trả về kết quả cho ToolRunner', async () => {
    const parentSession = new Session('parent-session-3');
    const registry = new AgentRegistry();
    const manager = new SubagentManager(
      registry,
      ((agentId: string, childSession: Session) => ({
        submit: async () => 'Subagent subtask complete.',
      })) as any,
    );
    manager.bindSession(parentSession);

    const tool = createDelegateTaskTool(manager);
    assert.equal(tool.name, 'delegate_task');

    const executionResult = await tool.execute({
      task: 'Verify dependencies',
      maxSteps: 4,
    }, new Workspace('.'));

    assert.equal(executionResult.success, true);
    assert.equal(executionResult.summary, 'Subagent subtask complete.');
    assert.ok(typeof executionResult.durationMs === 'number');
  });
});
