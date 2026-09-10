import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReflectionEngine, sliceErrorOutput } from '../src/agent/reflection-engine.js';
import { CodeSyntaxValidator } from '../src/workspace/syntax-diagnostics.js';
import { Workspace } from '../src/workspace/workspace.js';
import { replaceTextTool } from '../src/tools/replace-text.js';
import { applyPatchTool } from '../src/tools/apply-patch.js';
import { PlanManager } from '../src/agent/plan-manager.js';

async function runResilienceTests() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TOÀN DIỆN CÁC CƠ CHẾ CHỐNG LỖI CẢI TIẾN ===\n');

  // =========================================================================
  // TEST 1: REFLECTION ENGINE - CONSECUTIVE FAILURES PRESERVATION
  // Passive inspection tools (read_file, list_files) must NOT reset consecutiveFailures
  // =========================================================================
  console.log('[Test 1] ReflectionEngine: Passive inspection tools không reset consecutiveFailures');
  const engine = new ReflectionEngine();

  // Turn 1: run_command thất bại
  engine.analyze({
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { exitCode: 1, stderr: 'FAIL test suite' },
  });
  assert.strictEqual(engine.getConsecutiveFailures(), 1, 'Turn 1: consecutiveFailures phải là 1');

  // Turn 2: read_file (thao tác thăm dò / inspection)
  engine.analyze({
    toolName: 'read_file',
    args: { path: 'src/index.ts' },
    result: { content: 'console.log("hello")' },
  });
  assert.strictEqual(engine.getConsecutiveFailures(), 1, 'Turn 2: read_file KHÔNG ĐƯỢC reset consecutiveFailures về 0');

  // Turn 3: grep_search (thao tác thăm dò)
  engine.analyze({
    toolName: 'grep_search',
    args: { query: 'export' },
    result: { matches: [] },
  });
  assert.strictEqual(engine.getConsecutiveFailures(), 1, 'Turn 3: grep_search KHÔNG ĐƯỢC reset consecutiveFailures về 0');

  // Turn 4: run_command thất bại tiếp theo -> consecutiveFailures phải lên 2
  const reflection4 = engine.analyze({
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { exitCode: 1, stderr: 'FAIL test suite again' },
  });
  assert.strictEqual(engine.getConsecutiveFailures(), 2, 'Turn 4: consecutiveFailures phải tăng lên 2');
  assert.ok(
    reflection4.reflectionPrompt?.includes('consecutive times'),
    'Turn 4: reflectionPrompt phải kích hoạt cảnh báo consecutive failures >= 2',
  );
  console.log('  ✅ Đạt: consecutiveFailures được bảo toàn qua các bước inspection.');

  // Turn 5: run_command thành công (exitCode 0) -> lúc này mới reset về 0
  engine.analyze({
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { exitCode: 0, stdout: 'PASS all tests' },
  });
  assert.strictEqual(engine.getConsecutiveFailures(), 0, 'Turn 5: run_command thành công phải reset consecutiveFailures về 0');
  console.log('  ✅ Đạt: Reset bộ đếm chính xác khi lệnh thực thi thành công.');

  // =========================================================================
  // TEST 2: REFLECTION ENGINE - DIAGNOSTIC ENVIRONMENT ERROR CODES
  // =========================================================================
  console.log('\n[Test 2] ReflectionEngine: Nhận diện mã lỗi môi trường chuẩn hóa');
  const engineEnv = new ReflectionEngine();

  // Test POSIX_COMMAND_ON_WINDOWS
  const refPosix = engineEnv.analyze({
    toolName: 'run_command',
    args: { command: 'ls -la' },
    result: {
      errorCode: 'POSIX_COMMAND_ON_WINDOWS',
      stderr: "'ls' is not recognized as an internal or external command",
      suggestion: 'Dùng dir hoặc Get-ChildItem trên PowerShell',
    },
  });
  assert.strictEqual(refPosix.isFailure, true, 'isFailure phải là true');
  assert.ok(refPosix.reflectionPrompt?.includes('POSIX_COMMAND_ON_WINDOWS'), 'Prompt phải chứa POSIX_COMMAND_ON_WINDOWS');
  assert.ok(refPosix.reflectionPrompt?.includes('Get-ChildItem'), 'Prompt phải chứa gợi ý chuyển đổi lệnh');

  // Test HOST_MEMORY_COMMIT_EXHAUSTED
  const refOom = engineEnv.analyze({
    toolName: 'run_command',
    args: { command: 'node big.js' },
    result: {
      errorCode: 'HOST_MEMORY_COMMIT_EXHAUSTED',
      stderr: 'JavaScript heap out of memory',
      suggestion: 'Tăng hạn mức bộ nhớ qua --max-old-space-size hoặc tối ưu hóa dữ liệu.',
    },
  });
  assert.strictEqual(refOom.isFailure, true, 'isFailure phải là true');
  assert.ok(refOom.reflectionPrompt?.includes('HOST_MEMORY_COMMIT_EXHAUSTED'), 'Prompt phải chứa HOST_MEMORY_COMMIT_EXHAUSTED');
  console.log('  ✅ Đạt: Nhận diện chính xác POSIX_COMMAND_ON_WINDOWS và HOST_MEMORY_COMMIT_EXHAUSTED.');

  // =========================================================================
  // TEST 3: REFLECTION ENGINE - SMART ASSERTION DIFF SLICING
  // =========================================================================
  console.log('\n[Test 3] ReflectionEngine: sliceErrorOutput trích xuất thông minh khối assertion diff');
  const hugePrefix = 'Line log info...\n'.repeat(300); // ~5000 ký tự
  const assertionBlock = `
FAIL src/calculator.test.ts
  ✕ adds 1 + 2 to equal 3 (5 ms)

  ● adds 1 + 2 to equal 3

    expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 4

      12 | test('adds 1 + 2 to equal 3', () => {
    > 13 |   expect(add(1, 2)).toBe(3);
         |                     ^
      14 | });
`;
  const hugeSuffix = 'Trailing debug info...\n'.repeat(300);
  const fullOutput = hugePrefix + assertionBlock + hugeSuffix;

  const sliced = sliceErrorOutput(fullOutput, 1200);
  assert.ok(sliced.includes('Expected: 3'), 'sliceErrorOutput phải giữ lại dòng Expected: 3');
  assert.ok(sliced.includes('Received: 4'), 'sliceErrorOutput phải giữ lại dòng Received: 4');
  assert.ok(sliced.includes('expect(received).toBe(expected)'), 'sliceErrorOutput phải giữ lại dòng so sánh');
  assert.ok(sliced.length <= 2000, `Độ dài sliced (${sliced.length}) phải nằm trong giới hạn cho phép`);
  console.log('  ✅ Đạt: Khối assertion diff giữa output 10KB được bảo toàn nguyên vẹn.');

  // =========================================================================
  // TEST 4: IN-MEMORY AST SYNTAX VALIDATOR & PRE-COMMIT GUARDRAILS
  // =========================================================================
  console.log('\n[Test 4] CodeSyntaxValidator: Kiểm tra AST TypeScript/JavaScript trong RAM');
  const validTs = `
export function calculate(a: number, b: number): number {
  return a + b;
}
`;
  const invalidTs = `
export function calculate(a: number, b: number): number {
  return a + ; // Cú pháp gãy
}
`;
  const errorsValid = CodeSyntaxValidator.validateContentSyntax('test.ts', validTs);
  assert.strictEqual(errorsValid.length, 0, 'Code TypeScript hợp lệ không được có lỗi');

  const errorsInvalid = CodeSyntaxValidator.validateContentSyntax('test.ts', invalidTs);
  assert.ok(errorsInvalid.length > 0, 'Code TypeScript cú pháp gãy phải phát hiện được lỗi');
  assert.ok(errorsInvalid[0].line >= 3, 'Phải chỉ ra đúng dòng lỗi cú pháp');
  console.log(`  ✅ Đạt: Phát hiện lỗi cú pháp AST trong RAM: "${errorsInvalid[0].message}" tại dòng ${errorsInvalid[0].line}`);

  // =========================================================================
  // TEST 5: REPLACE_TEXT TOOL - IN-MEMORY SYNTAX GUARDRAIL & CANDIDATE DIFF
  // =========================================================================
  console.log('\n[Test 5] replace_text: In-Memory Syntax Guardrail chặn ghi đĩa file lỗi');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-resilience-'));
  const workspace = new Workspace(tempDir);
  const sampleFilePath = path.join(tempDir, 'math.ts');
  const originalCode = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
  await fs.writeFile(sampleFilePath, originalCode, 'utf-8');

  // Thử replace với cú pháp gãy
  const brokenReplacement = `export function add(a: number, b: number): number {\n  return a + ; // BROKEN\n}\n`;
  const replaceResult = await replaceTextTool.execute({
    path: 'math.ts',
    oldText: originalCode,
    newText: brokenReplacement,
  }, workspace);

  assert.strictEqual(replaceResult.success, false, 'replace_text phải trả về success: false');
  assert.strictEqual(replaceResult.errorCode, 'SYNTAX_ERROR_PREVENTED', 'errorCode phải là SYNTAX_ERROR_PREVENTED');
  // Kiểm tra file trên đĩa vẫn nguyên vẹn
  const diskContent = await fs.readFile(sampleFilePath, 'utf-8');
  assert.strictEqual(diskContent, originalCode, 'File trên đĩa tuyệt đối không bị sửa đổi khi lỗi cú pháp');
  console.log('  ✅ Đạt: replace_text chặn lưu file gãy cú pháp, bảo toàn workspace sạch sẽ.');

  // Thử trường hợp candidateDiffHint (sai khác dấu nháy)
  const singleQuoteFile = path.join(tempDir, 'config.ts');
  await fs.writeFile(singleQuoteFile, `const mode = 'production';\n`, 'utf-8');
  const diffResult = await replaceTextTool.execute({
    path: 'config.ts',
    oldText: `const mode = "production";`, // dùng ngoặc kép thay vì ngoặc đơn
    newText: `const mode = "development";`,
  }, workspace);
  assert.strictEqual(diffResult.success, false, 'Không khớp chuỗi');
  assert.strictEqual(diffResult.errorCode, 'TEXT_NOT_FOUND', 'Mã lỗi TEXT_NOT_FOUND');
  assert.ok(diffResult.candidateDiffHint, 'Phải cung cấp candidateDiffHint');
  assert.ok(diffResult.candidateDiffHint.includes('nháy') || diffResult.candidateDiffHint.includes('quote'), 'Hint phải chỉ rõ khác biệt dấu nháy');
  console.log('  ✅ Đạt: replace_text phát hiện sai khác dấu nháy và tạo candidateDiffHint:', diffResult.candidateDiffHint);

  // =========================================================================
  // TEST 6: APPLY_PATCH TOOL - PRE-COMMIT AST SYNTAX GATE
  // =========================================================================
  console.log('\n[Test 6] apply_patch: Pre-commit AST Syntax Gate chặn hunk tạo mã hỏng');
  const patchFilePath = path.join(tempDir, 'service.ts');
  const serviceCode = `export class UserService {\n  getName(): string {\n    return "Alice";\n  }\n}\n`;
  await fs.writeFile(patchFilePath, serviceCode, 'utf-8');

  const brokenPatch = `--- service.ts
+++ service.ts
@@ -2,3 +2,3 @@
   getName(): string {
-    return "Alice";
+    return "Alice" + ;
   }
`;
  const patchResult = await applyPatchTool.execute({
    patch: brokenPatch,
  }, workspace);

  assert.strictEqual(patchResult.success, false, 'apply_patch phải thất bại khi patch tạo mã hỏng');
  assert.strictEqual(patchResult.errorCode, 'PRE_COMMIT_SYNTAX_ERROR', 'errorCode phải là PRE_COMMIT_SYNTAX_ERROR');
  const diskService = await fs.readFile(patchFilePath, 'utf-8');
  assert.strictEqual(diskService, serviceCode, 'File trên đĩa phải giữ nguyên vẹn 100%');
  console.log('  ✅ Đạt: apply_patch chặn pre-commit cú pháp và giữ toàn vẹn file đĩa.');

  // =========================================================================
  // TEST 7: PLAN MANAGER - AUTO ADVANCE & EVIDENCE MANAGEMENT
  // =========================================================================
  console.log('\n[Test 7] PlanManager: Auto-advance từ PENDING sang COMPLETED khi có bằng chứng');
  const planManager = new PlanManager(tempDir);
  planManager.createPlan([
    { title: 'Viết hàm add và kiểm tra' },
    { title: 'Tối ưu hóa hiệu năng' },
  ]);

  const tasks = planManager.getTasks();
  const task1Id = tasks[0].id;

  // Ghi nhận evidence vào task-1
  planManager.recordToolEvidence(
    'run_command',
    { command: 'npm test' },
    { exitCode: 0, stdout: 'Tests passed' },
  );

  // Task-1 đang ở trạng thái PENDING. Thử update trực tiếp thành COMPLETED
  // Với cơ chế cải tiến, PlanManager tự động chuyển PENDING -> IN_PROGRESS -> COMPLETED
  const updatedTask1 = planManager.updateTask(task1Id, 'COMPLETED', 'Đã hoàn thành xuất sắc');

  assert.ok(updatedTask1, 'Auto-advance phải trả về task');
  assert.strictEqual(updatedTask1?.status, 'COMPLETED', 'Task 1 phải ở trạng thái COMPLETED');
  console.log('  ✅ Đạt: PlanManager Auto-advance PENDING -> COMPLETED trơn tru không bị kẹt trạng thái.');

  // Dọn dẹp tempDir
  await fs.rm(tempDir, { recursive: true, force: true });

  console.log('\n🎉 TOÀN BỘ 7 NHÓM KIỂM THỬ ĐẠT 100%! HỆ THỐNG PHÒNG CHỐNG LỖI HOẠT ĐỘNG HOÀN HẢO!');
}

runResilienceTests().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
