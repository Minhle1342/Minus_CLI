process.env.NODE_ENV = 'test';
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
  // submit_solution luôn có mặt: đó là kênh trả kết quả của subagent (không phải mutation).
  assert.deepEqual(names.sort(), ['read_file', 'submit_solution'], `intersect phải loại mọi mutation/exec, got: ${names.join(', ')}`);
});

test('message_agent hơi (steering) vào inbox của subagent đang chạy, claim được ở step kế tiếp', async () => {
  const childInbox = new AgentInbox();
  const manager = new SubagentManager(
    new AgentRegistry(),
    (() => ({ inbox: childInbox, submit: () => new Promise(() => {}) }) as any) as any, // submit treo → giữ trạng thái running
    undefined,
  );
  const parentSession = new Session('parent-sess-message-agent');
  manager.bindSession(parentSession);

  const handle = manager.start('Quét auth flow (dài)');
  const sent = manager.sendMessage(handle.id, '[MESSAGE FROM PARENT AGENT (mid-turn steering)]:\nChỉ tập trung vào middleware, bỏ qua guard.');
  assert.equal(sent.sent, true, `phải gửi được: ${sent.reason}`);

  const steer = (childInbox as any).claimSteerMessage(handle.sessionId);
  assert.ok(steer, 'Child inbox phải có steering message');
  assert.match(steer!.text, /\[MESSAGE FROM PARENT AGENT/);
  assert.match(steer!.text, /bỏ qua guard/);

  // Sai id → từ chối; subagent chưa kịp loop → từ chối có lý do.
  assert.equal(manager.sendMessage('subagent-unknown', 'hi').sent, false);
  const pending = new SubagentManager(new AgentRegistry(), () => { throw new Error('no launch'); }, undefined);
  pending.bindSession(parentSession);
  const h2 = pending.start('không khởi động');
  assert.equal(pending.sendMessage(h2.id, 'hi').sent, false);
});

test('Ưu tiên 1 & 3: Subagent hoàn tất thành công tự push notification vào inbox cha kèm structured resultBundle', async () => {
  const parentInbox = new AgentInbox();
  const parentSession = new Session('parent-sess-success-surface');
  let notifiedHandle: any;

  const manager = new SubagentManager(
    new AgentRegistry(),
    ((_id: string, childSession: Session) => {
      // Giả lập subagent gọi tool sửa file
      childSession.append('tool/call', { toolName: 'replace_text', args: { filePath: 'src/core.ts' } });
      childSession.append('tool/call', { toolName: 'write_file', args: { targetFile: 'src/helper.ts' } });
      return {
        submit: async () => 'Refactored core logic cleanly.',
      };
    }) as any,
    undefined,
    undefined,
    (handle, parentId) => {
      if (!parentId) return;
      notifiedHandle = handle;
      const files = handle.resultBundle?.touchedFiles?.length
        ? ` | modified: [${handle.resultBundle.touchedFiles.join(', ')}]`
        : '';
      parentInbox.enqueue(
        parentId,
        `[SUBAGENT COMPLETED]: Task "${handle.objective}" (task_id=${handle.id}) finished successfully.${files}\nResult: ${handle.resultBundle?.summary || handle.answer}`,
        'system',
        { isSteering: true },
      );
    },
  );
  manager.bindSession(parentSession);

  const handle = manager.start('Refactor core module');
  const finished = await manager.waitFor(handle.id, 2000);

  assert.equal(finished.status, 'completed');
  assert.equal(finished.answer, 'Refactored core logic cleanly.');
  assert.ok(finished.resultBundle, 'Phải có resultBundle');
  assert.equal(finished.resultBundle.summary, 'Refactored core logic cleanly.');
  assert.deepEqual(finished.resultBundle.touchedFiles.sort(), ['src/core.ts', 'src/helper.ts'].sort());
  assert.ok(finished.resultBundle.durationMs >= 0);

  // Kiểm tra inbox cha nhận được thông báo
  const steer = parentInbox.claimSteerMessage(parentSession.id);
  assert.ok(steer, 'Parent inbox phải nhận được completion steering message');
  assert.match(steer!.text, /\[SUBAGENT COMPLETED\]/);
  assert.match(steer!.text, /src\/core\.ts/);
  assert.match(steer!.text, /Refactored core logic/);
});

test('Ưu tiên 2: Subagent timeout tự kích hoạt AbortController và kết thúc với status stopped', async () => {
  const manager = new SubagentManager(
    new AgentRegistry(),
    ((_id: string, _session: Session, _opts: any, signal: AbortSignal) => {
      return {
        submit: () => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
        }),
      };
    }) as any,
    undefined,
  );
  const parentSession = new Session('parent-sess-timeout');
  manager.bindSession(parentSession);

  // Đặt timeoutMs siêu ngắn: 25ms
  const handle = manager.start('Long running task', { timeoutMs: 25 });
  const finished = await manager.waitFor(handle.id, 1000);

  assert.equal(finished.status, 'stopped');
  assert.match(String(finished.error), /timed out/);
});

test('Benchmark Specialists được thay thế thành provider InternAI (Discovery API) và kế thừa model/prompt', async () => {
  const { BENCHMARK_SPECIALISTS, findSpecialistForBenchmark, registerBenchmarkSpecialists } = await import('./benchmark-agents.js');
  
  // 1. Kiểm tra toàn bộ 6 specialist thuộc provider InternAI
  assert.equal(BENCHMARK_SPECIALISTS.length, 6);
  for (const s of BENCHMARK_SPECIALISTS) {
    assert.equal(s.provider, 'InternAI (Discovery API)', `Specialist ${s.id} phải dùng provider InternAI`);
    assert.ok(s.model.startsWith('internai/'), `Specialist ${s.id} phải dùng model internai/*, got ${s.model}`);
    assert.ok(s.aliasId, `Specialist ${s.id} phải có aliasId`);
  }

  // 2. Kiểm tra các model cụ thể
  const math = BENCHMARK_SPECIALISTS.find((s) => s.id === 'subagent-deepseek-r1-math');
  assert.equal(math?.model, 'internai/deepseek-v4-pro-0813');
  const coder = BENCHMARK_SPECIALISTS.find((s) => s.id === 'subagent-qwen25-coder-synthesis');
  assert.equal(coder?.model, 'internai/qwen3.8-27b');
  const swe = BENCHMARK_SPECIALISTS.find((s) => s.id === 'subagent-gemini-swe-architect');
  assert.equal(swe?.model, 'internai/deepseek-v4-flash-0731');
  const governor = BENCHMARK_SPECIALISTS.find((s) => s.id === 'subagent-llama33-instruction-governor');
  assert.equal(governor?.model, 'internai/Agents-A1');
  const fim = BENCHMARK_SPECIALISTS.find((s) => s.id === 'subagent-codestral-fim-surgeon');
  assert.equal(fim?.model, 'internai/kimi-k2.6');
  const adversary = BENCHMARK_SPECIALISTS.find((s) => s.id === 'subagent-skeptical-adversary');
  assert.equal(adversary?.model, 'internai/glm-5.3');

  // 3. Đăng ký vào AgentRegistry
  const registry = new AgentRegistry();
  const registered = registerBenchmarkSpecialists(registry);
  assert.ok(registered.length >= 12, 'Phải đăng ký cả 6 primary IDs và 6 alias IDs');
  assert.ok(registry.get('subagent-deepseek-r1-math'));
  assert.ok(registry.get('subagent-internai-deepseek-v4-pro-math'));

  // 4. Tra cứu theo benchmark và InternAI model
  assert.equal(findSpecialistForBenchmark('humaneval')?.model, 'internai/qwen3.8-27b');
  assert.equal(findSpecialistForBenchmark('deepseek-v4-pro')?.id, 'subagent-deepseek-r1-math');
  assert.equal(findSpecialistForBenchmark('Agents-A1')?.id, 'subagent-llama33-instruction-governor');

  // 5. Kiểm tra SubagentLoop kế thừa model và prompt từ specialist
  let childModel: string | undefined;
  const mockParentLLM = {
    modelName: 'gemini-3.7-flash',
    cloneWithModel: (m: string) => {
      childModel = m;
      return { modelName: m, generateStream: async () => ({ text: 'ok', toolCalls: [] }) };
    },
  };
  const parentLoop = new AgentLoop(mockParentLLM as any, new ToolRegistry(), { agentRegistry: registry });
  const childLoop = (parentLoop as any).createSubagentLoop(
    'subagent-deepseek-r1-math',
    new Session('session-internai-test'),
    { specialistId: 'subagent-deepseek-r1-math' },
    new AbortController().signal,
  );

  assert.equal(childModel, 'internai/deepseek-v4-pro-0813', 'Child loop phải được tạo với model InternAI của specialist');
  const specialistPrompt = (childLoop as any).promptAssembler?.sections?.get('specialist-instruction');
  assert.ok(specialistPrompt, 'Child loop phải nhận được chỉ dẫn hệ thống của specialist');
  assert.match(specialistPrompt.content, /DeepSeek V4 Pro/);
});

test('delegate_task chuyển tiếp specialistId xuống child loop (không bị rơi)', async () => {
  let receivedOptions: any;
  const manager = new SubagentManager(
    new AgentRegistry(),
    ((_id: string, _session: Session, options: any) => {
      receivedOptions = options;
      return { submit: async () => 'done' } as any;
    }) as any,
  );
  const parentSession = new Session('parent-sess-specialist-forward');
  manager.bindSession(parentSession);

  const result = await manager.executeIsolatedTask('viết tài liệu', {
    specialistId: 'subagent-deepseek-r1-math',
  });

  assert.equal(result.success, true);
  assert.equal(receivedOptions?.specialistId, 'subagent-deepseek-r1-math', 'specialistId phải tới factory');
  assert.equal(receivedOptions?.brief, 'viết tài liệu', 'brief phải tới factory');
});

test('Schema của subagent tools hướng dẫn rõ ràng LLM khả năng chạy subagent song song (Parallel Delegation)', async () => {
  const { createSpawnAgentTool, createDelegateTaskTool, createAllocateAgentTaskTool } = await import('../tools/subagent-tools.js');
  const manager = new SubagentManager(new AgentRegistry(), (() => ({})) as any);

  // 1. spawn_agent schema
  const spawnTool = createSpawnAgentTool(manager);
  const spawnProps = (spawnTool.parameters as any).properties;
  assert.match(spawnTool.description, /PARALLEL/i, 'spawn_agent description phải nêu bật khả năng chạy song song');
  assert.match(spawnTool.description, /MULTIPLE TIMES IN PARALLEL/i, 'spawn_agent description phải chỉ rõ gọi nhiều lần cùng lượt');
  assert.match(spawnProps.brief.description, /parallel/i, 'brief description phải hướng dẫn emit song song');
  assert.match(spawnProps.fileScope.description, /parallel/i, 'fileScope description phải hướng dẫn non-overlapping scopes');
  assert.match(spawnProps.mode.description, /scout/i, 'mode description phải gợi ý scout cho parallel');

  // 2. delegate_task schema
  const delegateTaskTool = createDelegateTaskTool(manager);
  assert.match(delegateTaskTool.description, /SYNCHRONOUS/i, 'delegate_task phải nêu rõ tính đồng bộ blocking');
  assert.match(delegateTaskTool.description, /spawn_agent.*PARALLEL/i, 'delegate_task phải gợi ý spawn_agent song song khi có 2+ subtasks');

  // 3. allocate_agent_task schema
  const orchestrator = new (await import('./agent-orchestrator.js')).AgentOrchestrator(new AgentRegistry(), manager);
  const allocateTool = createAllocateAgentTaskTool(orchestrator);
  assert.match(allocateTool.description, /PARALLEL/i, 'allocate_agent_task phải nêu bật khả năng phân bổ chuyên gia song song');
});
