import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentManager } from './subagent-manager.js';
import { AgentRegistry } from './agent-registry.js';
import { AgentInbox } from './agent-inbox.js';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { Session } from '../session/session.js';

test('Subagent thất bại được surface vào inbox của session cha với resumable task_id', () => {
  const inbox = new AgentInbox();
  const parentSession = new Session('parent-sess-fail-surface');
  const manager = new SubagentManager(
    new AgentRegistry(),
    () => { throw new Error('boom: provider unavailable'); },
    undefined,
    (handle, parentId) => {
      if (!parentId) return;
      inbox.enqueue(
        parentId,
        `[SUBAGENT FAILED (resumable)]: Task "${handle.objective}" failed (task_id=${handle.id}): ${handle.error || 'unknown error'}. Fix the cause, then call resume_agent(task_id="${handle.id}") to retry, or re-scope the task.`,
        'system',
        { isSteering: true },
      );
    },
  );
  manager.bindSession(parentSession);

  const handle = manager.start('Viết báo cáo phân tích');
  assert.equal(handle.status, 'failed');
  assert.match(String(handle.error), /boom/);

  const steer = inbox.claimSteerMessage(parentSession.id);
  assert.ok(steer, 'Parent inbox phải nhận được steering message');
  assert.match(steer!.text, /\[SUBAGENT FAILED \(resumable\)\]/);
  assert.match(steer!.text, new RegExp(`task_id=${handle.id}`));
  assert.match(steer!.text, /resume_agent/);
});

test('Subagent không thể spawn subagent cùng cấp (điểm cap depth = 1)', () => {
  const parentLoop = new AgentLoop({ generate: async () => ({}) } as any, new ToolRegistry());
  const childLoop = (parentLoop as any).createSubagentLoop(
    'depth-probe-agent',
    new Session('parent-session-depth-probe'),
    { parentSessionId: 'parent-session-depth-probe' },
    new AbortController().signal,
  );
  const childToolNames = childLoop.toolProvider.getAll().map((t: any) => t.name);
  const orchestrationTools = ['delegate_task', 'delegate_agent', 'spawn_agent', 'allocate_agent_task', 'schedule_dag_parallel'];
  assert.equal(
    childToolNames.filter((n: string) => orchestrationTools.includes(n)).length,
    0,
    `Child registry rò rỉ orchestration tools: ${childToolNames.filter((n: string) => orchestrationTools.includes(n)).join(', ')}`,
  );
});

test('mode=scout giới hạn subagent vào bộ tool chỉ đọc (deny-mặc định)', () => {
  const parentRegistry = new ToolRegistry();
  for (const name of ['read_file', 'write_file', 'run_command', 'search_text']) {
    parentRegistry.register({ name, description: name, parameters: { type: 'object', properties: {} } as any, execute: async () => ({}) } as any);
  }
  const parentLoop = new AgentLoop({ generate: async () => ({}) } as any, parentRegistry);
  const childLoop = (parentLoop as any).createSubagentLoop(
    'scout-probe-agent',
    new Session('parent-session-scout-probe'),
    { parentSessionId: 'parent-session-scout-probe', mode: 'scout' },
    new AbortController().signal,
  );
  const names = childLoop.toolProvider.getAll().map((t: any) => t.name);
  assert.ok(names.includes('read_file'), 'Scout phải giữ tool đọc file');
  assert.ok(names.includes('search_text'), 'Scout phải giữ tool tìm kiếm');
  assert.ok(!names.includes('write_file'), `Scout không được có write_file, got: ${names.join(', ')}`);
  assert.ok(!names.includes('run_command'), `Scout không được có run_command, got: ${names.join(', ')}`);
});

test('toolNames tuỳ ý + mode=scout bị intersect về bộ chỉ đọc', () => {
  const parentRegistry = new ToolRegistry();
  for (const name of ['read_file', 'write_file', 'run_command']) {
    parentRegistry.register({ name, description: name, parameters: { type: 'object', properties: {} } as any, execute: async () => ({}) } as any);
  }
  const parentLoop = new AgentLoop({ generate: async () => ({}) } as any, parentRegistry);
  const childLoop = (parentLoop as any).createSubagentLoop(
    'scout-intersect-agent',
    new Session('parent-session-scout-intersect'),
    { parentSessionId: 'parent-session-scout-intersect', mode: 'scout', toolNames: ['read_file', 'write_file'] },
    new AbortController().signal,
  );
  const names = childLoop.toolProvider.getAll().map((t: any) => t.name);
  assert.deepEqual(names, ['read_file'], `intersect phải loại mọiMutation/exec, got: ${names.join(', ')}`);
});
