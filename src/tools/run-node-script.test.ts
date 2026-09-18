import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runNodeScriptTool, extractCleanScriptErrorMessage } from './run-node-script.js';
import { ToolRegistry } from './registry.js';
import { isMutationTool } from './diff-generator.js';
import { Workspace } from '../workspace/workspace.js';
import { DEFAULT_TOOL_ALTERNATIVES } from './tool-use-guardian.js';

test('tool-design: Description Engineering answers 4 core questions (What, When, When NOT, Returns)', () => {
  // 1. Kiểm tra định danh và description theo chuẩn tool-design & agent-tool-builder
  assert.equal(runNodeScriptTool.name, 'run_node_script');
  const desc = runNodeScriptTool.description;

  assert.ok(desc.length > 200, 'Description phải chi tiết và có cấu trúc rõ ràng');
  assert.match(desc, /• WHAT IT DOES:/, 'Phải nêu rõ mục đích (What it does)');
  assert.match(desc, /• WHEN TO USE:/, 'Phải nêu rõ thời điểm kích hoạt (When to use)');
  assert.match(desc, /• WHEN NOT TO USE:/, 'Phải có Negative Guidance để chống nhầm lẫn (When NOT to use)');
  assert.match(desc, /• RETURNS:/, 'Phải định nghĩa định dạng trả về (Returns)');

  // 2. Kiểm tra parameters schema và ví dụ minh họa
  const params = runNodeScriptTool.parameters as any;
  assert.ok(params.properties.scriptContent, 'Phải có tham số scriptContent');
  assert.match(params.properties.scriptContent.description, /Example:/, 'Phải có ví dụ 1-shot mẫu trong scriptContent');
  assert.ok(params.properties.description, 'Phải có tham số description');
  assert.ok(params.properties.timeoutMs, 'Phải có tham số timeoutMs');
  assert.ok(params.properties.targetFiles, 'Phải có tham số targetFiles');
  assert.ok(params.properties.responseFormat, 'Phải có tham số responseFormat');
  assert.deepEqual(params.required, ['scriptContent', 'description']);
});

test('tool-design: Response Format Optimization - concise vs detailed', async () => {
  const workspace = new Workspace(process.cwd());

  // Kịch bản 1: Mặc định responseFormat = 'concise' (hoặc truyền tường minh 'concise')
  const conciseResult = await runNodeScriptTool.execute(
    {
      scriptContent: 'console.log("A".repeat(500));',
      description: 'Test concise format token efficiency',
      responseFormat: 'concise',
    },
    workspace
  );

  assert.equal(conciseResult.success, true);
  assert.ok(conciseResult.summary, 'Chế độ concise phải có summary');
  assert.ok(conciseResult.guidance, 'Chế độ concise phải có guidance');
  assert.match(conciseResult.stdout, /truncated.*for token efficiency/, 'Stdout dài phải được tóm tắt trong concise format');
  assert.equal(conciseResult.stderr, undefined, 'Thành công thì không gửi trường stderr để tiết kiệm token');

  // Kịch bản 2: responseFormat = 'detailed'
  const detailedResult = await runNodeScriptTool.execute(
    {
      scriptContent: 'console.log("FULL_OUTPUT_LOG"); process.stderr.write("DEBUG_DIAGNOSTIC");',
      description: 'Test detailed format verbosity',
      responseFormat: 'detailed',
    },
    workspace
  );

  assert.equal(detailedResult.success, true);
  assert.match(detailedResult.stdout, /FULL_OUTPUT_LOG/, 'Detailed format phải trả về đầy đủ stdout');
  assert.match(detailedResult.stderr, /DEBUG_DIAGNOSTIC/, 'Detailed format phải trả về đầy đủ stderr');
  assert.equal(detailedResult.description, 'Test detailed format verbosity');
});

test('tool-design: Actionable Error Messages contain actionableFix and recoveryAction', async () => {
  const workspace = new Workspace(process.cwd());

  // Kịch bản: Bị lỗi cú pháp JS
  const syntaxErrResult = await runNodeScriptTool.execute(
    {
      scriptContent: 'const broken = ;',
      description: 'Syntax error test',
    },
    workspace
  );

  assert.equal(syntaxErrResult.success, false);
  assert.ok(syntaxErrResult.actionableFix, 'Lỗi phải cung cấp actionableFix để agent tự sửa');
  assert.ok(syntaxErrResult.recoveryAction, 'Lỗi phải cung cấp recoveryAction');
  assert.match(syntaxErrResult.actionableFix, /Inspect syntax near the reported token/);
});

test('tool-use-guardian: Pre-Call Validation - In-Memory Syntax Check', async () => {
  const workspace = new Workspace(process.cwd());

  const result = await runNodeScriptTool.execute(
    {
      scriptContent: 'function brokenSyntax( { const a = ; return a; ',
      description: 'Test in-memory syntax validation',
    },
    workspace
  );

  assert.equal(result.success, false, 'Phải trả về success = false khi cú pháp lỗi');
  assert.equal(result.is_error, true, 'Phải đánh dấu is_error = true');
  assert.equal(result.category, 'SCHEMA_MISMATCH', 'Phải phân loại là SCHEMA_MISMATCH');
  assert.equal(result.errorCode, 'SYNTAX_ERROR', 'Phải có mã lỗi SYNTAX_ERROR');
  assert.match(result.error, /JavaScript Syntax Error/);
  assert.equal(result.suggestedAlternative, 'apply_patch', 'Phải gợi ý công cụ thay thế apply_patch');
});

test('tool-use-guardian: Pre-Call Validation - Payload Size Limit', async () => {
  const workspace = new Workspace(process.cwd());

  const hugeScript = 'console.log("x");\n'.repeat(10000); // ~180KB
  const result = await runNodeScriptTool.execute(
    {
      scriptContent: hugeScript,
      description: 'Test payload size guard',
    },
    workspace
  );

  assert.equal(result.success, false, 'Phải từ chối payload vượt quá 128KB');
  assert.equal(result.is_error, true, 'Phải đánh dấu is_error = true');
  assert.equal(result.errorCode, 'PAYLOAD_TOO_LARGE');
  assert.equal(result.category, 'SCHEMA_MISMATCH');
  assert.match(result.error, /exceeds maximum payload limit/);
  assert.ok(result.actionableFix, 'Phải có actionableFix');
});

test('tool-use-guardian: Chốt chặn 1 - Hard Timeout & Infinite Loop Protection', async () => {
  const workspace = new Workspace(process.cwd());

  const result = await runNodeScriptTool.execute(
    {
      scriptContent: 'while (true) { /* infinite loop */ }',
      description: 'Test timeout protection against infinite loop',
      timeoutMs: 1000,
    },
    workspace
  );

  assert.equal(result.success, false, 'Phải trả về success = false khi timeout');
  assert.equal(result.is_error, true, 'Phải đánh dấu is_error = true');
  assert.equal(result.category, 'API_TIMEOUT', 'Phải phân loại lỗi là category: API_TIMEOUT');
  assert.match(result.error, /Script execution timed out/);
  assert.ok(result.recoveryAction, 'Phải có recoveryAction hướng dẫn LLM khắc phục');
  assert.ok(result.actionableFix, 'Phải có actionableFix');
  assert.equal(result.suggestedAlternative, 'apply_patch', 'Phải có suggestedAlternative');
});

test('tool-use-guardian: Chốt chặn 2 - Thực thi an toàn & dọn dẹp file tạm', async () => {
  const workspace = new Workspace(process.cwd());
  const scratchDir = path.resolve(process.cwd(), '.codingagent', 'scratch');

  const result = await runNodeScriptTool.execute(
    {
      scriptContent: 'console.log("HELLO_TOOL_BUILDER"); process.stdout.write("SUCCESS");',
      description: 'Echo message to stdout',
      timeoutMs: 5000,
    },
    workspace
  );

  assert.equal(result.success, true, 'Script hợp lệ phải trả về success = true');
  assert.equal(result.exitCode, 0, 'Exit code phải bằng 0');
  assert.match(result.stdout, /HELLO_TOOL_BUILDER/);
  assert.ok(Array.isArray(result.modifiedFiles), 'Phải có mảng modifiedFiles');

  // Đảm bảo không có file script tạm nào bị rò rỉ sau khi chạy xong
  const filesAfter = await fs.readdir(scratchDir).catch(() => []);
  const leakedScripts = filesAfter.filter((f) => f.startsWith('batch-script-'));
  assert.equal(leakedScripts.length, 0, 'File script tạm phải được tự động dọn dẹp (zero leak)');
});

test('tool-use-guardian: Error-as-200 Detection & Unmasking', async () => {
  const workspace = new Workspace(process.cwd());

  const result = await runNodeScriptTool.execute(
    {
      scriptContent: `
        try {
          const obj = null;
          obj.doSomething();
        } catch (err) {
          console.error("TypeError: Cannot read properties of null (reading 'doSomething')");
        }
      `,
      description: 'Demonstrate swallowed error unmasking',
      timeoutMs: 5000,
    },
    workspace
  );

  assert.equal(result.success, false, 'Error-as-200 phải bị unmask thành success = false');
  assert.equal(result.is_error, true, 'Phải đánh dấu is_error = true');
  assert.equal(result.category, 'ERROR_AS_200', 'Phải phân loại là ERROR_AS_200');
  assert.equal(result.errorAs200Unmasked, true, 'Phải đánh dấu cờ errorAs200Unmasked = true');
  assert.match(result.error, /emitted unhandled error/);
  assert.ok(result.recoveryAction, 'Phải cung cấp recoveryAction');
  assert.ok(result.actionableFix, 'Phải cung cấp actionableFix');
});

test('ToolRegistry & Guardian Alternatives Integration', () => {
  const registry = new ToolRegistry();
  const tool = registry.get('run_node_script');
  assert.ok(tool, 'run_node_script phải được đăng ký sẵn trong ToolRegistry');
  assert.equal(tool.name, 'run_node_script');

  // Kiểm tra nhận diện Mutation Tool
  assert.equal(isMutationTool('run_node_script'), true, 'run_node_script phải được phân loại là mutation tool');

  // Kiểm tra đăng ký DEFAULT_TOOL_ALTERNATIVES
  assert.ok(DEFAULT_TOOL_ALTERNATIVES['run_node_script'], 'Phải có DEFAULT_TOOL_ALTERNATIVES cho run_node_script');
  assert.ok(
    DEFAULT_TOOL_ALTERNATIVES['run_node_script'].includes('apply_patch'),
    'Phải bao gồm apply_patch trong danh sách công cụ thay thế'
  );
});

test('extractCleanScriptErrorMessage: extracts concise and accurate error without command path noise', () => {
  // Test case 1: Node.js execFile error message with Command failed prefix and TypeError
  const execErrLike = {
    message: 'Command failed: C:\\Program Files\\nodejs\\node.exe D:\\APIGo\\.codingagent\\scratch\\batch-script-123.mjs\nfile:///D:/APIGo/scratch.mjs:2\nconst a = b.c;\n            ^\nTypeError: Cannot read properties of undefined (reading \'c\')\n    at file:///D:/APIGo/scratch.mjs:2:13',
  };
  const clean1 = extractCleanScriptErrorMessage('', execErrLike);
  assert.equal(clean1, "TypeError: Cannot read properties of undefined (reading 'c')");

  // Test case 2: stderr has Error [ERR_MODULE_NOT_FOUND]
  const stderr2 = `
node:internal/modules/esm/resolve:265
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
  ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'nonexistent-lib' imported from D:\\project\\script.mjs
    at new NodeError (node:internal/errors:405:5)
`;
  const clean2 = extractCleanScriptErrorMessage(stderr2);
  assert.match(clean2, /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package 'nonexistent-lib'/);

  // Test case 3: Custom script error via console.error and exit
  const stderr3 = 'Custom database connection failed at localhost:5432\n';
  const clean3 = extractCleanScriptErrorMessage(stderr3);
  assert.equal(clean3, 'Custom database connection failed at localhost:5432');
});

test('runNodeScriptTool: runtime exception execution produces clean error without Command failed prefix', async () => {
  const workspace = new Workspace(process.cwd());

  const result = await runNodeScriptTool.execute(
    {
      scriptContent: 'throw new TypeError("Simulated runtime failure: invalid property access");',
      description: 'Test runtime exception handling and clean error formatting',
      timeoutMs: 5000,
    },
    workspace
  );

  assert.equal(result.success, false, 'Runtime error phải có success = false');
  assert.equal(result.is_error, true, 'Runtime error phải có is_error = true');
  assert.equal(result.errorCode, 'SCRIPT_EXECUTION_FAILED');
  assert.equal(result.exitCode, 1);

  // Quan trọng: result.error không được chứa "Command failed:" hay đường dẫn tuyệt đối dài dòng
  assert.doesNotMatch(result.error, /Command failed:/i, 'Thông điệp lỗi không được chứa tiền tố Command failed: rác');
  assert.match(result.error, /Script execution failed with exit code 1: TypeError: Simulated runtime failure/);
  assert.ok(result.stderr, 'Full stderr vẫn phải được lưu lại đầy đủ để debug sâu');
});
