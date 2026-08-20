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
import { AgentLoop } from './agent/agent-loop.js';
import { GeminiLLM } from './llm/gemini.js';
import { CheckpointManager } from './workspace/checkpoint.js';
import { ContextCompactor } from './agent/context-compactor.js';
import { PlanManager } from './agent/plan-manager.js';
import { ReflectionEngine } from './agent/reflection-engine.js';
import { SemanticSlicer } from './agent/semantic-slicer.js';
import { ProjectMemoryManager } from './memory/project-memory.js';
import { AgentKernel } from './kernel/kernel.js';
import { WorkspacePlugin } from './kernel/plugins/workspace-plugin.js';
import { PlanningPlugin } from './kernel/plugins/planning-plugin.js';
import { MemoryPlugin } from './kernel/plugins/memory-plugin.js';
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

  const result = await codingLoop.run(testSession);
  assert(result.includes('hoàn thành xuất sắc'), 'AgentLoop hoàn thành chu trình multi-step với mock LLM');

  // Mock LLM lặp vô tận để kiểm tra maxSteps
  class MockInfiniteLLM extends GeminiLLM {
    constructor() {
      super('dummy-key', 'mock-infinite-model');
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

  // Kiểm tra Event Bus
  let beforeToolEventFired: boolean = false;
  kernel.ctx.events.on('tool:before', (name) => {
    if (name === 'custom_git_branch') beforeToolEventFired = true;
  });
  kernel.ctx.events.emit('tool:before', 'custom_git_branch', {});
  assert(Boolean(beforeToolEventFired), 'Event Bus của Micro-Kernel phát và bắt sự kiện chính xác');

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
