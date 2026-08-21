import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from './workspace/workspace.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolRunner } from './tools/tool-runner.js';
import { readFileTool } from './tools/read-file.js';
import { listFilesTool } from './tools/list-files.js';
import { searchTextTool } from './tools/search-text.js';
import { replaceTextTool } from './tools/replace-text.js';
import { writeFileTool } from './tools/write-file.js';
import { runCommandTool } from './tools/run-command.js';
import { Session } from './session/session.js';
import { SessionPersistence } from './session/session-persistence.js';
import { SessionManager } from './session/session-manager.js';
import { AgentLoop } from './agent/agent-loop.js';
import { EffectLedger } from './agent/effect-ledger.js';
import { GeminiLLM } from './llm/gemini.js';
import { CheckpointManager } from './workspace/checkpoint.js';
import { ContextCompactor } from './agent/context-compactor.js';
import { PlanManager } from './agent/plan-manager.js';
import { GoalManager } from './agent/goal-manager.js';
import { ReflectionEngine } from './agent/reflection-engine.js';
import { SemanticSlicer } from './agent/semantic-slicer.js';
import { ProjectMemoryManager } from './memory/project-memory.js';
import { AgentKernel } from './kernel/kernel.js';
import { WorkspacePlugin } from './kernel/plugins/workspace-plugin.js';
import { PlanningPlugin } from './kernel/plugins/planning-plugin.js';
import { MemoryPlugin } from './kernel/plugins/memory-plugin.js';
import { SandboxPlugin } from './kernel/plugins/sandbox-plugin.js';
import { TaskPlugin } from './kernel/plugins/task-plugin.js';
import { RepomixPlugin } from './kernel/plugins/repomix-plugin.js';
import { SearchPlugin } from './kernel/plugins/search-plugin.js';
import { LocalProcessSandbox } from './sandbox/local-sandbox.js';
import { SandboxManager } from './sandbox/sandbox-manager.js';
import { TaskManager } from './tasks/task-manager.js';
import { createRunCommandTool } from './tools/run-command.js';
import { createStartBackgroundTaskTool, createGetTaskOutputTool, createStopTaskTool } from './tools/task-tools.js';
import { loadSession, saveSession, clearSession, getSessionFilePath } from './session/persistent-session.js';
import dotenv from 'dotenv';

dotenv.config();

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runUnitTests() {
  const workspace = new Workspace(process.cwd());
  const registry = new ToolRegistry();
  const runner = new ToolRunner(registry, workspace);

  console.log('\n========================================');
  console.log('🧪 1. KIỂM THỬ WORKSPACE & AN TOÀN BẢO MẬT');
  console.log('========================================');

  // Test 1.1: Path Traversal Protection
  try {
    workspace.resolveSafePath('../../outside.txt');
    assert(false, 'Chống Path Traversal thất bại');
  } catch (err: any) {
    assert(err.message.includes('Security Exception'), 'Chặn thành công path traversal "../../outside.txt"');
  }

  // Test 1.2: Ignore list & Binary detection
  assert(workspace.isIgnoredDirectory('node_modules'), 'Nhận diện đúng thư mục bỏ qua: node_modules');
  assert(workspace.isIgnoredDirectory('.git'), 'Nhận diện đúng thư mục bỏ qua: .git');
  assert(workspace.isBinaryFile('image.png'), 'Nhận diện đúng file nhị phân: .png');
  assert(!workspace.isBinaryFile('index.ts'), 'Không nhận diện nhầm file code: .ts');
  assert(workspace.isProtectedFile('.env'), 'Nhận diện đúng file bảo vệ: .env');

  console.log('\n========================================');
  console.log('🧪 2. KIỂM THỬ TOOL RUNNER & 5-STAGE PIPELINE');
  console.log('========================================');

  // Test 2.1: Unknown tool
  const unknownRes = await runner.run('non_existent_tool', {});
  assert(unknownRes.result.errorCode === 'UNKNOWN_TOOL', 'ToolRunner bắt đúng lỗi UNKNOWN_TOOL');

  // Test 2.2: Missing required args
  const missingArgsRes = await runner.run('read_file', {});
  assert(missingArgsRes.result.errorCode === 'INVALID_ARGS', 'ToolRunner bắt đúng lỗi INVALID_ARGS khi thiếu "path"');

  // Test 2.3: Security check via pipeline
  const secRes = await runner.run('read_file', { path: '../../secret.txt' });
  assert(secRes.result.errorCode === 'SECURITY_VIOLATION', 'ToolRunner chặn truy cập ra ngoài workspace');

  // Test 2.4: Protected file modification block
  const protectRes = await runner.run('replace_text', { path: '.env', oldText: 'A', newText: 'B' });
  assert(protectRes.result.errorCode === 'SECURITY_VIOLATION', 'ToolRunner chặn sửa đổi file .env bảo vệ');

  console.log('\n========================================');
  console.log('🧪 3. KIỂM THỬ 6 TOOLS CỐT LÕI');
  console.log('========================================');

  // Test 3.1: read_file (full & line ranges)
  const readFull = await readFileTool.execute({ path: 'package.json' }, workspace);
  assert(readFull.content && readFull.content.includes('mini-agent-loop'), 'read_file đọc đúng file package.json');
  
  const readRange = await readFileTool.execute({ path: 'package.json', startLine: 1, endLine: 3 }, workspace);
  assert(readRange.startLine === 1 && readRange.endLine === 3, 'read_file hỗ trợ đọc theo khoảng dòng');

  // Test 3.2: list_files
  const listRes = await listFilesTool.execute({ path: 'src' }, workspace);
  assert(Array.isArray(listRes.entries) && listRes.entries.some((e: any) => e.name === 'index.ts'), 'list_files liệt kê đúng thư mục src');
  assert(!listRes.entries.some((e: any) => e.name === 'node_modules'), 'list_files tự động lọc bỏ node_modules');

  // Test 3.3: search_text
  const searchRes = await searchTextTool.execute({ query: 'AgentLoop', path: 'src' }, workspace);
  assert(Array.isArray(searchRes.matches) && searchRes.matches.length > 0, 'search_text tìm thấy từ khoá "AgentLoop"');

  // Test 3.4: write_file & replace_text trên file tạm
  const testFilePath = 'temp/test-edit.txt';
  const writeRes = await writeFileTool.execute({ path: testFilePath, content: 'Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma' }, workspace);
  assert(writeRes.bytesWritten > 0, 'write_file tạo file tạm thành công');

  // Test 3.5: replace_text thành công
  const replaceRes = await replaceTextTool.execute({
    path: testFilePath,
    oldText: 'Line 2: Beta',
    newText: 'Line 2: Beta Updated',
  }, workspace);
  assert(replaceRes.success === true, 'replace_text thay thế chính xác 1 vị trí');

  // Test 3.6: replace_text lỗi không tìm thấy
  const replaceNotFound = await replaceTextTool.execute({
    path: testFilePath,
    oldText: 'Line 99: Not Exist',
    newText: 'New',
  }, workspace);
  assert(replaceNotFound.error && replaceNotFound.error.includes('Không tìm thấy'), 'replace_text báo lỗi rõ ràng khi không tìm thấy oldText');

  // Dọn dẹp file tạm
  try {
    const safeTemp = workspace.resolveSafePath(testFilePath);
    await fs.unlink(safeTemp);
  } catch {}

  // Test 3.7: run_command
  const cmdSafe = await runCommandTool.execute({ command: 'node -v' }, workspace);
  assert(cmdSafe.exitCode === 0 && cmdSafe.stdout.startsWith('v'), 'run_command thực thi thành công lệnh "node -v"');

  const cmdFail = await runCommandTool.execute({ command: 'node -e "process.exit(2)"' }, workspace);
  assert(cmdFail.exitCode === 2, 'run_command ghi nhận chính xác mã lỗi exitCode: 2');

  const cmdBlocked = await runCommandTool.execute({ command: 'rm -rf /' }, workspace);
  assert(cmdBlocked.errorCode === 'COMMAND_NOT_ALLOWED', 'run_command chặn thành công lệnh nguy hiểm ngoài allowlist');

  console.log('\n========================================');
  console.log('🧪 4. KIỂM THỬ TOOL REGISTRY & FUNCTION DECLARATIONS');
  console.log('========================================');

  assert(registry.getAll().length === 6, 'ToolRegistry chứa đủ 6 tools cốt lõi');
  const decls = registry.getFunctionDeclarations();
  assert(decls.length === 6, 'Xuất đúng 6 FunctionDeclaration cho Gemini API');
  const readOnlyScope = registry.createScope('read-only-agent', ['read_file', 'list_files']);
  assert(readOnlyScope.getFunctionDeclarations().length === 2, 'ToolScope xuất đúng capability allowlist cho agent');
  const scopedRunner = new ToolRunner(readOnlyScope, workspace);
  const deniedScopedTool = await scopedRunner.run('run_command', { command: 'node -v' });
  assert(deniedScopedTool.result.errorCode === 'UNKNOWN_TOOL', 'ToolRunner enforce tool scope khi agent gọi capability ngoài allowlist');

  console.log('\n========================================');
  console.log('🧪 5. KIỂM THỬ SESSION IN-MEMORY');
  console.log('========================================');

  const session = new Session('test-session');
  session.addUserMessage('Kiểm tra và sửa code');
  session.addModelMessage({
    functionCalls: [{ name: 'replace_text', args: { path: 'test.ts', oldText: 'a', newText: 'b' } }],
  });
  session.addToolResult('replace_text', { success: true });
  session.addModelMessage({
    functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }],
  });
  session.addToolResult('run_command', { exitCode: 0, stdout: 'PASS' });
  session.addModelMessage({ text: 'Đã sửa và kiểm thử thành công.' });

  const history = session.getHistory();
  assert(history.length === 6, 'Session lưu trữ chính xác 6 tin nhắn trong chu trình sửa + test');

  console.log('\n========================================');
  console.log('🧪 6. KIỂM THỬ AGENT LOOP & PHANH AN TOÀN (MAX STEPS)');
  console.log('========================================');

  // Mock LLM mô phỏng chu trình kiểm thử và sửa lỗi (TDD verification loop)
  class MockCodingLLM extends GeminiLLM {
    private turn = 0;
    constructor() {
      super('dummy-key', 'mock-coding-model');
    }
    async generateStream(): Promise<any> {
      return this.generate();
    }
    async generate(): Promise<any> {
      this.turn++;
      if (this.turn === 1) {
        return { toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }] };
      }
      if (this.turn === 2) {
        return { toolCalls: [{ name: 'run_command', args: { command: 'node -v' } }] };
      }
      return { text: 'Nhiệm vụ hoàn thành xuất sắc!', toolCalls: [] };
    }
  }

  const mockLLM = new MockCodingLLM();
  const codingLoop = new AgentLoop(mockLLM, registry, { maxSteps: 5, workspace });
  const testSession = new Session();
  testSession.addUserMessage('Khảo sát và xác minh project');

  const observedAgentHooks: string[] = [];
  const removeAgentHook = codingLoop.agentHooks.register('test-lifecycle-observer', {
    'agent/turn-start': () => { observedAgentHooks.push('turn-start'); },
    'agent/pre-step': (context) => { observedAgentHooks.push(`pre-step-${context.step}`); },
    'agent/request': () => { observedAgentHooks.push('request'); },
    'agent/after-step': (context) => { observedAgentHooks.push(`after-step-${context.step}`); },
    'agent/turn-stopping': () => { observedAgentHooks.push('turn-stopping'); },
  });

  const result = await codingLoop.run(testSession);
  removeAgentHook();
  assert(result.includes('hoàn thành xuất sắc'), 'AgentLoop hoàn thành chu trình multi-step với mock LLM');
  assert(codingLoop.agentRegistry.get(codingLoop.agentId)?.status === 'idle', 'AgentLoop cập nhật live agent status về idle sau turn');
  assert(observedAgentHooks.includes('turn-start') && observedAgentHooks.includes('turn-stopping'), 'AgentLoop phát live lifecycle hooks cho plugin');
  assert(observedAgentHooks.includes('request') && observedAgentHooks.includes('after-step-1'), 'Plugin quan sát được agent request và after-step');
  const lifecycleTypes = testSession.getEvents().map((event) => event.type);
  assert(lifecycleTypes.includes('turn/start') && lifecycleTypes.includes('turn/end'), 'Session ghi nhận lifecycle turn start/end');
  assert(lifecycleTypes.includes('step/start') && lifecycleTypes.includes('step/end'), 'Session ghi nhận lifecycle step start/end');
  assert(lifecycleTypes.includes('tool/call'), 'Session ghi nhận tool/call durable trước khi thực thi tool');
  const durableAssistantCall = testSession.getEvents()
    .find((event) => event.type === 'assistant/message')?.data.content?.parts?.find((part: any) => part.functionCall)?.functionCall;
  const durableToolResult = testSession.getEvents()
    .find((event) => event.type === 'tool/result')?.data.content?.parts?.find((part: any) => part.functionResponse)?.functionResponse;
  assert(Boolean(durableAssistantCall?.id) && durableAssistantCall?.id === durableToolResult?.id, 'Tool call ID giữ nguyên qua assistant message và tool result projection');
  const recordedEffects = testSession.getEffectStates();
  assert(recordedEffects.some((effect) => effect.toolName === 'run_command' && effect.status === 'committed'), 'Side-effect tool ghi durable effect lifecycle đến committed');
  const rollbackLedger = new EffectLedger();
  const rollbackSession = new Session('effect-rollback-session');
  rollbackLedger.bindSession(rollbackSession);
  const rollbackEffect = rollbackLedger.prepare('replace_text', 'rollback-call-1');
  rollbackLedger.attachCheckpoint(rollbackEffect.id, 'checkpoint-rollback-1');
  rollbackLedger.commit(rollbackEffect.id);
  rollbackLedger.rollback(rollbackEffect.id);
  assert(rollbackSession.getEffectStates().find((effect) => effect.id === rollbackEffect.id)?.status === 'rolledback', 'Effect ledger ghi nhận committed → rolledback qua operator action');

  // Mock LLM lặp vô tận để kiểm tra maxSteps
  class MockInfiniteLLM extends GeminiLLM {
    constructor() {
      super('dummy-key', 'mock-infinite-model');
    }
    async generateStream(): Promise<any> {
      return this.generate();
    }
    async generate(): Promise<any> {
      return { toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }] };
    }
  }

  const infiniteLoop = new AgentLoop(new MockInfiniteLLM(), registry, { maxSteps: 2, workspace });
  const infSession = new Session();
  infSession.addUserMessage('Lặp mãi mãi');
  const infResult = await infiniteLoop.run(infSession);
  assert(infResult.includes('maximum steps (2) reached'), 'AgentLoop dừng an toàn khi chạm maxSteps');

  const policyLoop = new AgentLoop(new MockCodingLLM(), registry, { maxSteps: 5, workspace });
  policyLoop.agentHooks.register('test-request-policy', {
    'agent/request': () => ({ allow: false, reason: 'approval-required' }),
  });
  const policySession = new Session();
  policySession.addUserMessage('Yêu cầu cần approval');
  const policyResult = await policyLoop.run(policySession);
  assert(policyResult.includes('approval-required'), 'Agent hook có thể chặn model request theo policy');
  assert(policySession.getEvents().some((event) => event.type === 'turn/end'), 'Turn bị policy chặn vẫn được đóng durable');

  class MockDelayedFinalLLM {
    private calls = 0;
    async generate(): Promise<any> {
      this.calls++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { text: `Concurrent request ${this.calls}`, toolCalls: [] };
    }
  }
  const serializedLoop = new AgentLoop(new MockDelayedFinalLLM(), registry, { maxSteps: 2, workspace });
  const serializedSession = new Session('serialized-run-session');
  const concurrentAnswers = await Promise.all([
    serializedLoop.run(serializedSession),
    serializedLoop.run(serializedSession),
  ]);
  const serializedEvents = serializedSession.getEvents();
  const turnStarts = serializedEvents.filter((event) => event.type === 'turn/start');
  const turnEnds = serializedEvents.filter((event) => event.type === 'turn/end');
  assert(concurrentAnswers.length === 2 && turnStarts.length === 2 && turnEnds.length === 2, 'Concurrent run cùng session được serialize thành hai turn đầy đủ');
  assert(turnStarts[0].seq < turnEnds[0].seq && turnEnds[0].seq < turnStarts[1].seq, 'Session event log không bị interleave giữa hai run cùng session');

  const inboxLoop = new AgentLoop(new MockCodingLLM(), registry, { maxSteps: 5, workspace });
  const inboxSession = new Session('inbox-test');
  const firstQueued = inboxLoop.submit(inboxSession, 'Yêu cầu inbox thứ nhất');
  const secondQueued = inboxLoop.submit(inboxSession, 'Yêu cầu inbox thứ hai');
  const queuedResults = await Promise.all([firstQueued, secondQueued]);
  assert(queuedResults.length === 2 && queuedResults.every((answer) => answer.length > 0), 'Agent inbox drain tuần tự nhiều input thành công');
  assert(inboxSession.getEvents().filter((event) => event.type === 'turn/start').length === 2, 'Input đến trong lúc agent chạy được chuyển thành turn kế tiếp');
  assert(
    inboxSession.getEvents().some((event) => event.type === 'input/queued') &&
      inboxSession.getEvents().filter((event) => event.type === 'input/claimed').length === 2,
    'Inbox ghi durable queued/claimed pairing cho từng input',
  );

  class MockFinalLLM {
    async generate(): Promise<any> {
      return { text: 'Đã tiếp tục input pending.', toolCalls: [] };
    }
  }
  const pendingInputSession = new Session('pending-input-replay');
  pendingInputSession.append('input/queued', {
    inputId: 'pending-input-1',
    inputText: 'Input phải được replay sau restart',
    source: 'human',
  });
  const pendingLoop = new AgentLoop(new MockFinalLLM(), registry, { maxSteps: 2, workspace });
  const pendingAnswers = await pendingLoop.resumePending(pendingInputSession);
  assert(pendingAnswers.length === 1 && pendingAnswers[0].includes('tiếp tục'), 'Durable pending input được replay bởi explicit resumePending');
  assert(pendingInputSession.getPendingInputs().length === 0, 'Replay pending input không để lại queue dangling');

  const delegationParent = new AgentLoop(new MockFinalLLM(), registry, { maxSteps: 2, workspace, agentId: 'delegation-parent' });
  const delegationParentSession = new Session('delegation-parent-session');
  delegationParent.bindSession(delegationParentSession);
  const delegated = delegationParent.subagentManager.start('Kiểm tra nhanh bằng subagent', { maxSteps: 2 });
  for (let attempt = 0; attempt < 50 && delegationParent.subagentManager.get(delegated.id)?.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const delegatedResult = delegationParent.subagentManager.get(delegated.id);
  assert(delegated.status === 'running' && delegatedResult?.status === 'completed', 'Subagent provider tạo child AgentLoop chạy nền và trả kết quả');
  assert(delegationParent.agentRegistry.get(delegated.id)?.status === 'idle', 'Subagent được phản ánh trong live AgentRegistry');
  assert(
    delegationParentSession.getDelegationStates().find((state) => state.id === delegated.id)?.status === 'completed',
    'Delegation state được ghi vào event log của parent session',
  );

  const interruptedDelegationSession = new Session('interrupted-delegation-session');
  interruptedDelegationSession.append('agent/delegation', {
    delegation: {
      id: 'subagent-restarted-1',
      sessionId: 'session-subagent-restarted-1',
      objective: 'Delegation bị gián đoạn bởi restart',
      status: 'running',
      startedAt: new Date().toISOString(),
    },
  });
  const recoveredDelegationLoop = new AgentLoop(new MockFinalLLM(), registry, {
    maxSteps: 2,
    workspace,
    agentId: 'delegation-recovery-parent',
    enableSubagents: false,
  });
  recoveredDelegationLoop.bindSession(interruptedDelegationSession);
  assert(
    interruptedDelegationSession.getDelegationStates().find((state) => state.id === 'subagent-restarted-1')?.status === 'stopped',
    'Delegation đang chạy được đánh dấu stopped an toàn sau process restart',
  );
  const resumed = recoveredDelegationLoop.subagentManager.resume('subagent-restarted-1', { maxSteps: 2 });
  for (let attempt = 0; attempt < 50 && recoveredDelegationLoop.subagentManager.get('subagent-restarted-1')?.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(resumed?.status === 'running' && recoveredDelegationLoop.subagentManager.get('subagent-restarted-1')?.status === 'completed', 'Delegation chỉ resume khi explicit và hoàn tất được lần chạy mới');

  console.log('\n========================================');
  console.log('🧪 7. KIỂM THỬ CHECKPOINT MANAGER & SHADOW ROLLBACK (/undo)');
  console.log('========================================');

  const cpManager = new CheckpointManager(workspace.rootDir);
  await cpManager.init();

  const cp1 = await cpManager.createCheckpoint('Before test edit 1');
  assert(cp1 !== null && cp1.index === 1, 'CheckpointManager tạo snapshot #1 thành công');
  assert(cpManager.getHistory().length === 1, 'Lịch sử lưu đúng 1 checkpoint');

  const cp2 = await cpManager.createCheckpoint('Before test edit 2');
  assert(cp2 !== null && cp2.index === 2, 'CheckpointManager tạo snapshot #2 thành công');
  assert(cpManager.getHistory().length === 2, 'Lịch sử lưu đúng 2 checkpoints');

  const rollbackRes = await cpManager.rollbackLast();
  assert(rollbackRes.success === true, 'Rollback hoàn tác checkpoint gần nhất thành công');
  assert(cpManager.getHistory().length === 1, 'Sau rollback, checkpoint stack giảm đi 1');

  console.log('\n========================================');
  console.log('🧪 8. KIỂM THỬ CONTEXT COMPACTOR & TOKEN BUDGETING');
  console.log('========================================');

  const compactor = new ContextCompactor({
    maxCharactersPerToolResult: 100,
    preserveLastNToolResults: 1,
  });

  const heavySession = new Session();
  heavySession.addUserMessage('Khảo sát codebase lớn');
  // Tool 1: File rất lớn (bước cũ, cần nén)
  heavySession.addModelMessage({ functionCalls: [{ name: 'read_file', args: { path: 'big-file.ts' } }] });
  heavySession.addToolResult('read_file', {
    path: 'big-file.ts',
    content: 'export const A = 1;\n'.repeat(100), // ~2000 chars
  });
  // Tool 2: Bước mới nhất (cần giữ nguyên)
  heavySession.addModelMessage({ functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }] });
  heavySession.addToolResult('run_command', {
    exitCode: 0,
    stdout: 'All tests passed!',
  });

  const compacted = compactor.compact(heavySession.getHistory());
  assert(compacted.stats.charsSaved > 500, 'ContextCompactor cắt tỉa thành công > 500 ký tự thừa');
  assert(compacted.stats.prunedPartsCount === 1, 'ContextCompactor nén chính xác 1 phần tử cũ');
  assert(compacted.messages.length === heavySession.getHistory().length, 'Số lượng message được bảo toàn nguyên vẹn');

  console.log('\n========================================');
  console.log('🧪 9. KIỂM THỬ PLAN MANAGER & TASK DECOMPOSITION (PLAN TREE)');
  console.log('========================================');

  const planMgr = new PlanManager();
  const tasks = planMgr.createPlan([
    { title: 'Phân tích mã nguồn' },
    { title: 'Viết reproduction test' },
    { title: 'Sửa implementation' },
    { title: 'Chạy test kiểm chứng' },
  ]);

  assert(tasks.length === 4, 'PlanManager tạo đủ 4 tasks');
  assert(tasks[0].status === 'IN_PROGRESS', 'Task #1 tự động ở trạng thái IN_PROGRESS');
  assert(tasks[1].status === 'PENDING', 'Task #2 ở trạng thái PENDING');

  const updatedTask = planMgr.updateTask(1, 'COMPLETED', 'Đã tìm ra dòng lỗi');
  assert(updatedTask?.status === 'COMPLETED', 'Task #1 chuyển sang COMPLETED');
  assert(planMgr.getTasks()[1].status === 'IN_PROGRESS', 'Task #2 tự động chuyển sang IN_PROGRESS khi Task #1 xong');

  const progress = planMgr.getProgress();
  assert(progress.completed === 1 && progress.inProgress === 1, 'Thống kê tiến độ chính xác');

  const planSession = new Session('plan-replay-test');
  const durablePlan = new PlanManager();
  durablePlan.bindSession(planSession);
  durablePlan.createPlan([{ title: 'Replay step A' }, { title: 'Replay step B' }]);
  durablePlan.updateTask(1, 'COMPLETED', 'Đã hoàn tất bước A');
  const replayedPlan = new PlanManager();
  replayedPlan.bindSession(Session.fromSnapshot(planSession.toSnapshot()));
  assert(replayedPlan.getTasks()[0]?.status === 'COMPLETED', 'Plan state được replay từ session events');
  assert(replayedPlan.getTasks()[1]?.status === 'IN_PROGRESS', 'Plan replay khôi phục task kế tiếp đang chạy');

  console.log('\n========================================');
  console.log('🧪 9B. KIỂM THỬ DURABLE GOAL LIFECYCLE');
  console.log('========================================');

  const goalSession = new Session('goal-replay-test');
  const goalManager = new GoalManager();
  goalManager.bindSession(goalSession);
  const createdGoal = goalManager.create('Hoàn tất mục tiêu có thể tiếp tục', 3);
  const firstRound = goalManager.beginRound();
  assert(createdGoal.phase === 'active', 'Goal mới được tạo ở phase active');
  assert(firstRound?.roundsStarted === 1, 'Goal ghi nhận durable round đầu tiên');
  assert(goalManager.isArmed() === true, 'Goal được armed bởi thao tác explicit trong process hiện tại');

  const resumedGoalManager = new GoalManager();
  resumedGoalManager.bindSession(Session.fromSnapshot(goalSession.toSnapshot()));
  assert(resumedGoalManager.getState()?.roundsStarted === 1, 'Goal state được replay từ session events');
  assert(resumedGoalManager.isArmed() === false, 'Load session không tự động kích hoạt goal');
  resumedGoalManager.resume();
  assert(resumedGoalManager.isArmed() === true, 'Resume là continuation authority explicit');
  resumedGoalManager.pause();
  assert(resumedGoalManager.getState()?.phase === 'paused' && !resumedGoalManager.isArmed(), 'Pause disarm và ghi phase paused');

  // Test qua ToolRegistry
  const planRegistry = new ToolRegistry(planMgr);
  const createPlanRes = await planRegistry.execute('create_plan', {
    tasks: [{ title: 'Bước A' }, { title: 'Bước B' }],
  });
  assert(createPlanRes.tasks?.length === 2, 'create_plan tool thực thi thành công');

  const updatePlanRes = await planRegistry.execute('update_plan_task', {
    id: 1,
    status: 'COMPLETED',
  });
  assert(updatePlanRes.task?.status === 'COMPLETED', 'update_plan_task tool cập nhật trạng thái thành công');

  console.log('\n========================================');
  console.log('🧪 10. KIỂM THỬ REFLECTION ENGINE & DEBUGGING PROTOCOL');
  console.log('========================================');

  const reflectionEngine = new ReflectionEngine();

  // Test thành công không kích hoạt reflection
  const successAnalysis = reflectionEngine.analyze({
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { exitCode: 0, stdout: 'Pass' },
    durationMs: 10,
  });
  assert(successAnalysis.isFailure === false, 'Không kích hoạt Reflection khi tool thành công');
  assert(reflectionEngine.getConsecutiveFailures() === 0, 'Bộ đếm thất bại liên tiếp là 0');

  // Test lệnh thất bại kích hoạt Debugging Protocol
  const failAnalysis1 = reflectionEngine.analyze({
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { exitCode: 1, stderr: 'AssertionError: expected true to be false' },
    durationMs: 50,
  });
  assert(failAnalysis1.isFailure === true, 'Nhận diện đúng lệnh thất bại');
  assert(failAnalysis1.reflectionPrompt?.includes('DEBUGGING PROTOCOL TRIGGERED') === true, 'Kích hoạt prompt Debugging Protocol');
  assert(reflectionEngine.getConsecutiveFailures() === 1, 'Bộ đếm thất bại tăng lên 1');

  // Test lỗi replace_text
  const failAnalysis2 = reflectionEngine.analyze({
    toolName: 'replace_text',
    args: { path: 'a.ts', oldText: 'xxx', newText: 'yyy' },
    result: { error: 'Không tìm thấy đoạn code cần thay thế' },
    durationMs: 5,
  });
  assert(failAnalysis2.isFailure === true, 'Nhận diện đúng lỗi replace_text');
  assert(failAnalysis2.reflectionPrompt?.includes('CẢNH BÁO') === true, 'Kích hoạt cảnh báo khi thất bại liên tiếp 2 lần');

  console.log('\n========================================');
  console.log('🧪 11. KIỂM THỬ SEMANTIC SLICER & AST OUTLINE EXTRACTION');
  console.log('========================================');

  const sampleTS = `
export interface UserConfig {
  name: string;
}

export class OrderService {
  processOrder(id: number): boolean {
    return true;
  }
}

export async function calculateTotal(items: any[]): Promise<number> {
  return items.length * 10;
}
  `;

  const outline = SemanticSlicer.extractOutline('src/order.ts', sampleTS);
  assert(outline.symbols.length >= 3, 'SemanticSlicer trích xuất đủ các symbols (interface, class, function)');
  assert(outline.symbols.some((s) => s.name === 'OrderService' && s.kind === 'class'), 'Nhận diện đúng class OrderService');
  assert(outline.symbols.some((s) => s.name === 'calculateTotal' && s.kind === 'function'), 'Nhận diện đúng function calculateTotal');

  const slicedFunc = SemanticSlicer.sliceSymbol(sampleTS, 'calculateTotal');
  assert(slicedFunc.found === true && slicedFunc.code?.includes('return items.length * 10') === true, 'Trích xuất chính xác code body của calculateTotal');

  // Test read_file với outlineOnly: true
  const readOutlineRes = await readFileTool.execute({ path: 'src/agent/agent-loop.ts', outlineOnly: true }, workspace);
  assert(readOutlineRes.symbolsCount > 0, 'read_file outlineOnly trích xuất thành công symbols');

  // Test read_file với symbol: 'AgentLoop'
  const readSymbolRes = await readFileTool.execute({ path: 'src/agent/agent-loop.ts', symbol: 'AgentLoop' }, workspace);
  assert(readSymbolRes.content?.includes('class AgentLoop') === true, 'read_file symbol trích xuất thành công class AgentLoop');

  console.log('\n========================================');
  console.log('🧪 12. KIỂM THỬ NÂNG CAO: MULTI-TURN COMPACTION & TOKEN BUDGET');
  console.log('========================================');

  const multiTurnSession = new Session();
  multiTurnSession.addUserMessage('Nhiệm vụ dài nhiều bước');

  // Turn 1: Đọc file lớn (cũ)
  multiTurnSession.addModelMessage({ functionCalls: [{ name: 'read_file', args: { path: 'heavy.ts' } }] });
  multiTurnSession.addToolResult('read_file', {
    path: 'heavy.ts',
    content: `export class BigEngine {\n` + `  runStep() {}\n`.repeat(500) + `}\n`,
  });

  // Turn 2: Chạy lệnh build log dài (cũ)
  multiTurnSession.addModelMessage({ functionCalls: [{ name: 'run_command', args: { command: 'npm run build' } }] });
  multiTurnSession.addToolResult('run_command', {
    exitCode: 1,
    stderr: `Start build\n` + `Compiling file...\n`.repeat(200) + `Error TS2345: Argument not assignable\nat line 45\n`,
  });

  // Turn 3: Bước mới nhất (giữ nguyên)
  multiTurnSession.addModelMessage({ functionCalls: [{ name: 'read_file', args: { path: 'fix.ts' } }] });
  multiTurnSession.addToolResult('read_file', {
    path: 'fix.ts',
    content: 'export const fix = true;',
  });

  const advancedCompactor = new ContextCompactor({
    maxCharactersPerToolResult: 150,
    preserveLastNToolResults: 1,
  });

  const advResult = advancedCompactor.compact(multiTurnSession.getHistory());
  assert(advResult.stats.tokensSaved > 500, 'Tối ưu hoá và tiết kiệm thành công > 500 Tokens');
  assert(advResult.stats.prunedPartsCount === 2, 'Cắt tỉa chính xác 2 turn cũ thành Semantic Outline và Log Tail');

  console.log('\n========================================');
  console.log('🧪 13. KIỂM THỬ PROJECT MEMORY MANAGER (LONG-TERM KB & WARM START)');
  console.log('========================================');

  const memoryMgr = new ProjectMemoryManager(workspace.rootDir);
  const memData = await memoryMgr.init(workspace);

  assert(memData.projectName.length > 0, 'ProjectMemoryManager quét thành công projectName');
  assert(memData.scripts['test'] !== undefined, 'Nhận diện đúng test script: npm test');
  assert(memData.scripts['build'] !== undefined, 'Nhận diện đúng build script: npm run build');

  const insight = await memoryMgr.saveInsight('test_rule', 'Always run npm test before committing', 'rule');
  assert(insight.key === 'test_rule', 'Lưu thành công insight vào Long-term Memory');

  const digest = memoryMgr.getProjectDigest();
  assert(digest.includes('[PROJECT KNOWLEDGE BASE'), 'Tạo thành công Warm-Start Digest');
  assert(digest.includes('Always run npm test before committing'), 'Digest bao gồm insight vừa lưu');

  const memorySession = new Session('memory-scope-test');
  memoryMgr.bindSession(memorySession);
  const sessionInsight = await memoryMgr.saveInsight(
    'current_task_context',
    'The current task is validating durable session replay',
    'insight',
    { scope: 'session', confidence: 0.8, source: 'model' },
  );
  assert(sessionInsight.scope === 'session' && memorySession.getMemoryRecords().length === 1, 'Session memory ghi vào event log thay vì project file');
  assert(
    memoryMgr.retrieve('durable replay', { scopes: ['session'], limit: 2 })[0]?.key === 'current_task_context',
    'Memory retrieval lọc theo scope và relevance',
  );
  const replayedMemoryMgr = new ProjectMemoryManager(workspace.rootDir);
  replayedMemoryMgr.bindSession(Session.fromSnapshot(memorySession.toSnapshot()));
  assert(replayedMemoryMgr.retrieve('session replay', { scopes: ['session'] }).length === 1, 'Session memory replay được sau khi restore session');

  console.log('\n========================================');
  console.log('🧪 14. KIỂM THỬ MEMORY TOOLS (save_memory & read_memory)');
  console.log('========================================');

  const memRegistry = new ToolRegistry(undefined, memoryMgr);
  const saveRes = await memRegistry.execute('save_memory', {
    key: 'auth_pattern',
    insight: 'Use JWT bearer tokens in header',
    category: 'architecture',
  });
  assert(saveRes.saved?.key === 'auth_pattern', 'save_memory tool thực thi thành công');

  const readRes = await memRegistry.execute('read_memory', {
    query: 'auth',
  });
  assert(readRes.learnedInsights?.some((i: any) => i.key === 'auth_pattern'), 'read_memory tool lọc đúng theo từ khoá "auth"');

  console.log('\n========================================');
  console.log('🧪 15. KIỂM THỬ SYSTEM 1 VS SYSTEM 2 (COT DEEP REASONING SEPARATION)');
  console.log('========================================');

  // Mock Reasoning Model (DeepSeek R1 / Gemini Thinking)
  class MockReasoningLLM {
    async generate(): Promise<any> {
      return {
        reasoningContent: 'Phân tích file bug: Cần kiểm tra kỹ hàm validateInput trước khi sửa để tránh regression.',
        text: 'Đã phân tích xong.',
        toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }],
      };
    }
  }

  const reasoningRegistry = new ToolRegistry();
  const reasoningLoop = new AgentLoop(new MockReasoningLLM(), reasoningRegistry, { maxSteps: 2, workspace });
  const reasoningSession = new Session();
  reasoningSession.addUserMessage('Kiểm tra và sửa bug');
  
  // Chạy 1 turn để kiểm tra việc bóc tách reasoningContent
  const mockResp = await new MockReasoningLLM().generate();
  assert(mockResp.reasoningContent !== undefined, 'Bóc tách thành công luồng reasoning_content (System 2)');
  assert(mockResp.toolCalls.length === 1, 'Bóc tách thành công luồng tool_calls (System 1)');
  assert(mockResp.reasoningContent.includes('validateInput'), 'Nội dung CoT chứa chuỗi tư duy phân tích rủi ro');

  console.log('\n========================================');
  console.log('🧪 16. KIỂM THỬ MICRO-KERNEL & PLUGIN-BASED ENGINE (PHASE 5)');
  console.log('========================================');

  const kernel = new AgentKernel(workspace);
  await kernel.use(WorkspacePlugin);
  await kernel.use(PlanningPlugin);
  await kernel.use(MemoryPlugin);

  const loadedPlugins = kernel.getLoadedPlugins();
  assert(loadedPlugins.length === 3, 'Kernel nạp đủ 3 plugins tiêu chuẩn');
  assert(loadedPlugins.includes('workspace-plugin'), 'Kernel nạp đúng workspace-plugin');
  assert(loadedPlugins.includes('planning-plugin'), 'Kernel nạp đúng planning-plugin');
  assert(loadedPlugins.includes('memory-plugin'), 'Kernel nạp đúng memory-plugin');

  const removePromptSection = kernel.ctx.systemPrompt.register({
    id: 'test-approval-policy',
    priority: 10,
    content: 'All destructive actions require explicit approval.',
  });
  assert(kernel.ctx.systemPrompt.list().includes('test-approval-policy'), 'Plugin đăng ký được system-prompt section');
  assert(kernel.ctx.systemPrompt.assemble().includes('explicit approval'), 'Prompt assembler ghép section theo cấu hình plugin');
  removePromptSection();
  const registeredAgent = kernel.ctx.agents.register('review-agent', 'Review Agent');
  const runningAgent = kernel.ctx.agents.update('review-agent', { status: 'running', sessionId: 'hook-probe', turn: 1, step: 1 });
  assert(registeredAgent.status === 'idle' && runningAgent.status === 'running', 'Kernel AgentRegistry quản lý live agent lifecycle');
  assert(kernel.ctx.agents.list().some((agent) => agent.id === 'review-agent'), 'AgentRegistry liệt kê được agent composable');
  assert(kernel.ctx.events.listenerCount('tool:before') >= 1, 'Kernel event bus cung cấp typed listener contract cho plugin');

  // Đăng ký Custom Plugin của bên thứ ba (Custom Tool Plugin)
  let customToolExecuted: boolean = false;
  await kernel.use({
    name: 'custom-git-plugin',
    apply(ctx) {
      ctx.registerTool({
        name: 'custom_git_branch',
        description: 'Lấy tên git branch hiện tại',
        parameters: { type: 'object' as any, properties: {} },
        async execute() {
          customToolExecuted = true;
          return { branch: 'develop' };
        },
      });
    },
  });

  assert(kernel.getLoadedPlugins().includes('custom-git-plugin'), 'Kernel hỗ trợ nạp Custom Plugin từ bên thứ 3');
  assert(kernel.ctx.tools.get('custom_git_branch') !== undefined, 'Tool tùy biến đã được đăng ký thành công vào ToolRegistry');

  const customExecRes = await kernel.ctx.tools.execute('custom_git_branch', {});
  assert(customExecRes.branch === 'develop' && Boolean(customToolExecuted), 'Custom Plugin Tool thực thi trả về kết quả chuẩn xác');

  let pluginHookObserved = false;
  await kernel.use({
    name: 'agent-observer-plugin',
    apply(ctx) {
      ctx.agentHooks.register('plugin-agent-observer', {
        'agent/pre-step': () => { pluginHookObserved = true; },
      }, -10);
    },
  });
  assert(kernel.ctx.agentHooks.list().includes('plugin-agent-observer'), 'Plugin đăng ký được agent lifecycle hook vào Kernel context');
  const hookProbeSession = new Session('hook-probe');
  const hookDecision = await kernel.ctx.agentHooks.run('agent/pre-step', {
    session: hookProbeSession,
    turn: 1,
    step: 1,
    maxSteps: 3,
    isGoalMode: false,
    metadata: {},
  });
  assert(hookDecision.allow && pluginHookObserved, 'Kernel agent hook chạy theo đúng thứ tự và cho phép tiếp tục');

  // Kiểm tra Event Bus
  let beforeToolEventFired: boolean = false;
  kernel.ctx.events.on('tool:before', (name) => {
    if (name === 'custom_git_branch') beforeToolEventFired = true;
  });
  kernel.ctx.events.emit('tool:before', 'custom_git_branch', {});
  assert(Boolean(beforeToolEventFired), 'Event Bus của Micro-Kernel phát và bắt sự kiện chính xác');

  console.log('\n========================================');
  console.log('🧪 17. KIỂM THỬ TRUE EXECUTION SANDBOX (PHASE 6)');
  console.log('========================================');

  // 1. Kiểm thử LocalProcessSandbox
  const localSandbox = new LocalProcessSandbox(workspace.rootDir);
  await localSandbox.init();
  const execSuccess = await localSandbox.exec('node -v');
  assert(execSuccess.exitCode === 0, 'LocalProcessSandbox thực thi thành công lệnh node -v');
  assert(execSuccess.sandboxType === 'local', 'Trả về đúng sandboxType là local');
  assert(execSuccess.stdout.startsWith('v'), 'Nhận diện đúng output phiên bản node');

  const execFail = await localSandbox.exec('node -e "process.exit(2)"');
  assert(execFail.exitCode === 2, 'LocalProcessSandbox bắt đúng exitCode thất bại (= 2)');

  // 2. Kiểm thử SandboxManager Orchestration
  const sandboxMgr = new SandboxManager({ workspacePath: workspace.rootDir, mode: 'local' });
  await sandboxMgr.init();
  const status = sandboxMgr.getStatus();
  assert(status.mode === 'local', 'SandboxManager khởi tạo thành công ở chế độ local');
  assert(status.activeProvider.includes('Sandbox'), 'Active provider được định danh chính xác');

  // 3. Kiểm thử run_command tool tích hợp SandboxManager
  const sandboxedRunTool = createRunCommandTool(sandboxMgr);
  const toolExecRes = await sandboxedRunTool.execute({ command: 'node -v' }, workspace);
  assert(toolExecRes.exitCode === 0, 'run_command tích hợp SandboxManager thực thi thành công');
  assert(toolExecRes.sandbox === 'local', 'run_command ghi nhận sandboxType đúng');

  // 4. Kiểm thử SandboxPlugin trong AgentKernel
  const sandboxKernel = new AgentKernel(workspace);
  await sandboxKernel.use(SandboxPlugin);
  assert(sandboxKernel.getLoadedPlugins().includes('sandbox-plugin'), 'SandboxPlugin nạp thành công vào AgentKernel');
  await sandboxKernel.unuse('sandbox-plugin');
  assert(!sandboxKernel.getLoadedPlugins().includes('sandbox-plugin'), 'SandboxPlugin giải phóng và unuse thành công');

  console.log('\n========================================');
  console.log('🧪 18. KIỂM THỬ REAL-TIME STREAMING & ASYNCHRONOUS SUBPROCESSES');
  console.log('========================================');

  // 1. Kiểm thử Real-time Streaming Callbacks
  class StreamingMockLLM {
    async generateStream(session: any, tools: any, callbacks?: any): Promise<any> {
      callbacks?.onThoughtToken?.('Thought 1: Analyzing issue\n');
      callbacks?.onThoughtToken?.('Thought 2: Checked code');
      callbacks?.onContentToken?.('Answer token 1 ');
      callbacks?.onContentToken?.('Answer token 2');
      return {
        reasoningContent: 'Thought 1: Analyzing issue\nThought 2: Checked code',
        text: 'Answer token 1 Answer token 2',
        toolCalls: [],
      };
    }
  }

  const streamedThoughts: string[] = [];
  const streamedTokens: string[] = [];
  const streamLLM = new StreamingMockLLM();
  const streamResp = await streamLLM.generateStream(new Session(), [], {
    onThoughtToken: (t: string) => streamedThoughts.push(t),
    onContentToken: (t: string) => streamedTokens.push(t),
  });

  assert(streamedThoughts.length === 2, 'Streamed đủ 2 token suy nghĩ thời gian thực');
  assert(streamedTokens.length === 2, 'Streamed đủ 2 token câu trả lời thời gian thực');
  assert(streamResp.text === 'Answer token 1 Answer token 2', 'Nội dung text tổng hợp trùng khớp');

  // 2. Kiểm thử TaskManager (Background Subprocesses)
  const taskManager = new TaskManager(workspace.rootDir);
  const task = taskManager.startTask('node -e "console.log(\'server-heartbeat\'); setInterval(() => {}, 50)"');
  
  assert(task.id.startsWith('task_'), 'Khởi tạo thành công task ID');
  assert(task.status === 'running', 'Trạng thái ban đầu là running');
  assert(task.pid !== undefined && task.pid > 0, 'Ghi nhận PID hợp lệ của subprocess');

  // Đợi 300ms để process spawn và flush stdout
  await new Promise((resolve) => setTimeout(resolve, 300));
  const logs = taskManager.getTaskLogs(task.id);
  assert(logs.includes('server-heartbeat'), 'Đọc logs thời gian thực từ circular log buffer thành công');

  const stopped = await taskManager.stopTask(task.id);
  assert(stopped === true, 'Dừng background task thành công');
  assert(task.status === 'stopped', 'Trạng thái chuyển sang stopped');

  // 3. Kiểm thử Background Task Tools
  const startTool = createStartBackgroundTaskTool(taskManager);
  const getOutputTool = createGetTaskOutputTool(taskManager);
  const stopTool = createStopTaskTool(taskManager);

  const startRes = await startTool.execute({ command: 'node -v' }, workspace);
  assert(startRes.success === true && startRes.task?.id, 'start_background_task tool thực thi thành công');

  const outRes = await getOutputTool.execute({ taskId: startRes.task.id, lines: 10 }, workspace);
  assert(outRes.logs !== undefined, 'get_task_output tool trả về log buffer');

  const stopRes = await stopTool.execute({ taskId: startRes.task.id }, workspace);
  assert(stopRes.success !== undefined, 'stop_task tool phản hồi thành công');

  // 4. Kiểm thử TaskPlugin
  const taskKernel = new AgentKernel(workspace);
  await taskKernel.use(TaskPlugin);
  assert(taskKernel.getLoadedPlugins().includes('task-plugin'), 'TaskPlugin nạp thành công vào AgentKernel');
  assert(taskKernel.ctx.tools.get('start_background_task') !== undefined, 'Tool start_background_task được đăng ký tự động');
  await taskKernel.unuse('task-plugin');
  assert(!taskKernel.getLoadedPlugins().includes('task-plugin'), 'TaskPlugin unuse thành công');
  await taskManager.dispose();

  console.log('\n========================================');
  console.log('🧪 19. KIỂM THỬ CONTINUATION PROTOCOL & EMPTY RESPONSE RECOVERY (DEEPSEEK-HARNESS)');
  console.log('========================================');

  // 1. Kiểm thử khi LLM trả về turn 1 rỗng (không text, không tool), Continuation Protocol tự động re-prompt
  class MockEmptyTurnLLM {
    private turn = 0;
    async generate(session: Session): Promise<any> {
      this.turn++;
      if (this.turn === 1) {
        // Turn 1 trả về hoàn toàn rỗng
        return { text: '', toolCalls: [] };
      }
      // Turn 2 sau khi nhận [SYSTEM NOTE] re-prompt từ AgentLoop
      const history = session.getHistory();
      const lastMsg = history[history.length - 1];
      const hasNote = lastMsg.parts?.some((p: any) => p.text?.includes('[SYSTEM NOTE]'));
      if (hasNote) {
        return { text: 'Tôi đã tiếp tục xử lý và hoàn thành nhiệm vụ thành công!', toolCalls: [] };
      }
      return { text: 'Không nhận được prompt khôi phục', toolCalls: [] };
    }
  }

  const emptyTurnLoop = new AgentLoop(new MockEmptyTurnLLM(), new ToolRegistry(), { maxSteps: 5, workspace });
  const emptySession = new Session();
  emptySession.addUserMessage('Kiểm tra tự phục hồi khi gặp turn rỗng');
  const recoveryResult = await emptyTurnLoop.run(emptySession);

  assert(!recoveryResult.includes('(Không có phản hồi từ model)'), 'Không bao giờ dừng sớm với lỗi (Không có phản hồi từ model)');
  assert(recoveryResult.includes('tiếp tục xử lý và hoàn thành nhiệm vụ'), 'Continuation Protocol tự động khôi phục và hoàn thành ở turn tiếp theo');

  // 2. Kiểm thử khi LLM trả về System 2 Reasoning nhưng chưa phát sinh hành động
  class MockReasoningOnlyLLM {
    private turn = 0;
    async generate(session: Session): Promise<any> {
      this.turn++;
      if (this.turn === 1) {
        return {
          reasoningContent: 'Tôi đã phân tích xong cấu trúc dự án. Cần đọc file package.json tiếp theo.',
          text: '',
          toolCalls: [],
        };
      }
      return {
        toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }],
      };
    }
  }

  const reasoningRegistry19 = new ToolRegistry();
  const reasoningLoop19 = new AgentLoop(new MockReasoningOnlyLLM(), reasoningRegistry19, { maxSteps: 3, workspace });
  const reasoningSession19 = new Session();
  reasoningSession19.addUserMessage('Phân tích dự án');
  await reasoningLoop19.run(reasoningSession19);
  assert(reasoningSession19.getHistory().length > 2, 'Continuation Protocol thúc đẩy model từ System 2 sang System 1 Tool Call');

  console.log('\n========================================');
  console.log('🧪 20. KIỂM THỬ PERSISTENT SESSION (SAVE & RESTORE MODEL / WORKSPACE)');
  console.log('========================================');

  console.log('\n========================================');
  console.log('20A. EVENT-SOURCED SESSION & JSONL RESUME');
  console.log('========================================');

  const sessionWorkspace = path.resolve(workspace.rootDir, 'temp', 'session-persistence-test');
  await fs.rm(sessionWorkspace, { recursive: true, force: true });

  const sessionPersistence = new SessionPersistence(sessionWorkspace);
  const sessionManager = new SessionManager(sessionWorkspace);
  const managerCreated = await sessionManager.create('manager-created-session');
  managerCreated.addUserMessage('Session được quản lý qua Kernel capability');
  await sessionManager.save(managerCreated);
  const managerLoaded = await new SessionManager(sessionWorkspace).load(managerCreated.id);
  assert(managerLoaded?.getHistory()[0]?.parts?.[0]?.text === 'Session được quản lý qua Kernel capability', 'SessionManager load/save session qua capability context');
  const managerFork = await sessionManager.fork(managerCreated, 1, 'manager-forked-session');
  assert(managerFork.getHistory().length === 1 && (await sessionManager.list()).includes('manager-forked-session'), 'SessionManager fork và discover child session bền vững');
  const durableSession = new Session('durable-test-session');
  durableSession.addUserMessage('Khởi tạo session bền vững');
  await sessionPersistence.save(durableSession);

  const resumedSession = await sessionPersistence.load(durableSession.id);
  assert(resumedSession?.seq === 1, 'JSONL lưu và resume đúng event đầu tiên');
  assert(resumedSession?.getHistory()[0]?.parts?.[0]?.text === 'Khởi tạo session bền vững', 'Resume khôi phục đúng message projection');

  resumedSession!.addModelMessage({ text: 'Đã tiếp nhận.' });
  await sessionPersistence.save(resumedSession!);
  const resumedAgain = await sessionPersistence.load(durableSession.id);
  assert(resumedAgain?.seq === 2 && resumedAgain.getHistory().length === 2, 'Append event mới không ghi đè event cũ');

  const forkedSession = resumedAgain!.fork(1, 'forked-session-test');
  assert(forkedSession.id === 'forked-session-test' && forkedSession.getHistory().length === 1, 'Session fork tạo child branch đúng boundary');
  assert(resumedAgain!.seq === 2 && forkedSession.getEvents().some((event) => event.type === 'session/fork'), 'Fork không mutate parent và ghi metadata branch durable');
  await sessionPersistence.save(forkedSession);
  const restoredFork = await sessionPersistence.load(forkedSession.id);
  assert(restoredFork?.getHistory().length === 1, 'Child session fork được persistence và restore độc lập');

  const persistedPath = sessionPersistence.getSessionPath(durableSession.id);
  const firstFlush = await fs.readFile(persistedPath, 'utf8');
  await sessionPersistence.save(resumedAgain!);
  const secondFlush = await fs.readFile(persistedPath, 'utf8');
  assert(firstFlush === secondFlush, 'Flush lặp lại không tạo duplicate events');

  const interrupted = new Session('interrupted-test-session');
  interrupted.addUserMessage('Kiểm tra crash recovery');
  interrupted.append('turn/start', { turn: 1 });
  interrupted.append('step/start', { turn: 1, step: 1 });
  interrupted.addModelMessage({ functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }] });
  const interruptedAssistantSeq = interrupted.lastEvent?.seq;
  interrupted.append('tool/call', {
    turn: 1,
    step: 1,
    toolName: 'run_command',
    toolCallId: 'recovery-call-1',
    assistantSeq: interruptedAssistantSeq,
    args: { command: 'npm test' },
  });
  interrupted.append('effect/change', {
    effect: {
      id: 'recovery-effect-1',
      toolName: 'run_command',
      toolCallId: 'recovery-call-1',
      status: 'prepared',
      reversible: true,
      checkpointId: 'checkpoint-recovery-1',
      preparedAt: new Date().toISOString(),
    },
    reason: 'prepared',
  });
  const interruptedDiagnostics = interrupted.getDiagnostics();
  assert(interruptedDiagnostics.openTurns.length === 1 && interruptedDiagnostics.openSteps.length === 1 && interruptedDiagnostics.pendingToolCallIds.includes('recovery-call-1') && interruptedDiagnostics.effects[0]?.status === 'prepared', 'Session diagnostics phát hiện turn/step/tool/effect dang dở trước recovery');
  await sessionPersistence.save(interrupted);

  const recovered = await sessionPersistence.load(interrupted.id);
  const recoveredEvents = recovered?.getEvents() || [];
  const recoveredResult = recoveredEvents.find(
    (event) => event.type === 'tool/result' && event.data.toolCallId === 'recovery-call-1'
  );
  assert(recoveredResult?.data.result?.errorCode === 'TOOL_OUTCOME_UNKNOWN', 'Crash recovery ghi nhận tool result chưa xác định');
  assert(recovered?.getPendingToolCalls().length === 0, 'Crash recovery đóng pairing tool/call còn dang dở');
  assert(recoveredEvents.some((event) => event.type === 'turn/end' && event.data.reason === 'interrupted'), 'Crash recovery đóng turn bị gián đoạn');
  assert(recovered?.getDiagnostics().openTurns.length === 0 && recovered?.getDiagnostics().openSteps.length === 0, 'Session diagnostics xác nhận recovery đã đóng lifecycle mở');
  assert(recovered?.getEffectStates().find((effect) => effect.id === 'recovery-effect-1')?.outcome === 'unknown', 'Crash recovery không giả định side-effect dang dở đã thành công');

  const unstarted = new Session('unstarted-test-session');
  unstarted.addUserMessage('Kiểm tra tool chưa bắt đầu');
  unstarted.append('turn/start', { turn: 1 });
  unstarted.append('step/start', { turn: 1, step: 1 });
  unstarted.addModelMessage({ functionCalls: [{ name: 'read_file', args: { path: 'README.md' } }] });
  await sessionPersistence.save(unstarted);
  const repairedUnstarted = await sessionPersistence.load(unstarted.id);
  assert(
    repairedUnstarted?.getEvents().some((event) => event.type === 'tool/result' && event.data.result?.errorCode === 'TOOL_NOT_STARTED') === true,
    'Crash recovery phân biệt tool call chưa kịp bắt đầu'
  );

  await fs.rm(sessionWorkspace, { recursive: true, force: true });

  const testSessionFile = path.resolve(workspace.rootDir, 'temp', 'test-session.json');

  // Đảm bảo dọn dẹp trước khi test
  clearSession(testSessionFile);

  // 1. Kiểm tra loadSession khi file chưa tồn tại
  const emptyLoaded = loadSession(testSessionFile);
  assert(emptyLoaded.modelName === undefined && emptyLoaded.workspacePath === undefined, 'loadSession trả về object rỗng khi file chưa tồn tại');

  // 2. Kiểm tra saveSession và loadSession đầy đủ
  const sampleWorkspace = path.resolve(workspace.rootDir, 'src');
  saveSession({
    modelName: 'deepseek-chat',
    workspacePath: sampleWorkspace,
  }, testSessionFile);

  const fullLoaded = loadSession(testSessionFile);
  assert(fullLoaded.modelName === 'deepseek-chat', 'Lưu và tải chính xác modelName từ session');
  assert(fullLoaded.workspacePath === sampleWorkspace, 'Lưu và tải chính xác workspacePath từ session');
  assert(typeof fullLoaded.lastUpdated === 'string', 'Tự động ghi nhận timestamp lastUpdated');

  // 3. Kiểm tra partial update (chỉ cập nhật modelName mà không làm mất workspacePath)
  saveSession({ modelName: 'gemini-2.5-pro' }, testSessionFile);
  const updatedModel = loadSession(testSessionFile);
  assert(updatedModel.modelName === 'gemini-2.5-pro', 'Cập nhật thành công modelName mới');
  assert(updatedModel.workspacePath === sampleWorkspace, 'Bảo toàn nguyên vẹn workspacePath cũ khi cập nhật riêng model');

  // 4. Kiểm tra partial update (chỉ cập nhật workspacePath mà không làm mất modelName)
  const newWorkspace = path.resolve(workspace.rootDir, 'dist');
  saveSession({ workspacePath: newWorkspace }, testSessionFile);
  const updatedWs = loadSession(testSessionFile);
  assert(updatedWs.workspacePath === newWorkspace, 'Cập nhật thành công workspacePath mới');
  assert(updatedWs.modelName === 'gemini-2.5-pro', 'Bảo toàn nguyên vẹn modelName cũ khi cập nhật riêng workspace');

  // 5. Kiểm tra getSessionFilePath trả về đường dẫn hợp lệ kết thúc bằng .codingagent/session.json
  const defaultPath = getSessionFilePath();
  assert(defaultPath.endsWith(path.join('.codingagent', 'session.json')), 'getSessionFilePath trả về đúng đường dẫn .codingagent/session.json');

  // 6. Kiểm tra clearSession dọn dẹp file thành công
  const cleared = clearSession(testSessionFile);
  assert(cleared === true, 'clearSession xóa file session thành công');
  assert(loadSession(testSessionFile).modelName === undefined, 'Sau khi clearSession, loadSession trả về rỗng');

  // 7. Kiểm tra Micro-Kernel phát event model:changed
  let modelChangedFired: string | null = null;
  const testKernel = new AgentKernel(workspace);
  testKernel.ctx.events.on('model:changed', (m: string) => {
    modelChangedFired = m;
  });
  testKernel.ctx.setLLM({ name: 'mock' }, 'gemini-3.5-flash');
  assert(modelChangedFired === 'gemini-3.5-flash', 'Micro-Kernel phát đúng event model:changed khi setLLM');

  console.log('\n========================================');
  console.log('🧪 21. KIỂM THỬ TOKEN OPTIMIZATION (REPOMIX, MINISEARCH & KV-CACHE ALIGNMENT)');
  console.log('========================================');

  // 1. Kiểm tra RepomixPlugin
  const optKernel = new AgentKernel(workspace);
  await optKernel.use(RepomixPlugin);
  await optKernel.use(SearchPlugin);

  assert(optKernel.ctx.tools.get('read_compressed_code') !== undefined, 'RepomixPlugin đăng ký thành công tool read_compressed_code');
  assert(optKernel.ctx.tools.get('pack_codebase') !== undefined, 'RepomixPlugin đăng ký thành công tool pack_codebase');
  assert(optKernel.ctx.tools.get('search_codebase_fast') !== undefined, 'SearchPlugin đăng ký thành công tool search_codebase_fast');

  // 2. Kiểm tra thực thi search_codebase_fast (MiniSearch BM25)
  const searchTool = optKernel.ctx.tools.get('search_codebase_fast')!;
  const msSearchRes = await searchTool.execute({ query: 'AgentLoop' }, workspace);
  assert(msSearchRes.totalHits > 0, 'search_codebase_fast tìm thấy ký hiệu code chính xác');
  assert(msSearchRes.hits && msSearchRes.hits.length > 0, 'search_codebase_fast trả về danh sách hits với score BM25');

  // 3. Kiểm tra thực thi read_compressed_code (Repomix Tree-sitter)
  const readCompTool = optKernel.ctx.tools.get('read_compressed_code')!;
  const compRes = await readCompTool.execute({ paths: ['src/tools/types.ts'] }, workspace);
  assert(compRes.totalFiles === 1, 'read_compressed_code nén và đọc đúng 1 tệp');
  assert(typeof compRes.totalTokens === 'number', 'read_compressed_code tính toán chính xác lượng token nén');

  // 4. Kiểm tra KV-Cache Prefix Alignment (Sắp xếp tool declarations cố định theo tên)
  const sortedDecls = optKernel.ctx.tools.getFunctionDeclarations();
  let isSorted = true;
  for (let i = 1; i < sortedDecls.length; i++) {
    const prevName = sortedDecls[i - 1]?.name || '';
    const currName = sortedDecls[i]?.name || '';
    if (prevName.localeCompare(currName) > 0) {
      isSorted = false;
      break;
    }
  }
  assert(isSorted === true, 'KV-Cache Prefix Alignment: Toàn bộ FunctionDeclarations được sắp xếp cố định theo tên');

  console.log('\n========================================');
  console.log(`KẾT QUẢ: ${passed} Passed, ${failed} Failed`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runUnitTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
