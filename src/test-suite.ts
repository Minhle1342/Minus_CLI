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
