import assert from 'node:assert';
import { ErrorDetective } from './agent/error-detective.js';
import { ReflectionEngine } from './agent/reflection-engine.js';
import { CognitiveHarness } from './agent/cognitive-harness.js';
import { CLI } from './ui/cli-ui.js';

async function runErrorDetectiveTests(): Promise<void> {
  console.log('🧪 BẮT ĐẦU KIỂM THỬ ERROR DETECTIVE ENGINE & CAUSAL RCA PROTOCOL...\n');

  const detective = new ErrorDetective();

  // 1. Kiểm thử trích xuất lỗi TypeScript Compiler (TSxxxx)
  const tsLog = `
src/auth/jwt.ts(45,12): error TS2304: Cannot find name 'signToken'.
src/server.ts(120,5): error TS2322: Type 'string' is not assignable to type 'number'.
`;
  const reportTS = detective.investigate(tsLog);
  assert.strictEqual(reportTS.extractedErrors.length, 2, 'Trích xuất đúng 2 lỗi TS');
  assert.strictEqual(reportTS.extractedErrors[0].language, 'typescript');
  assert.strictEqual(reportTS.extractedErrors[0].file, 'src/auth/jwt.ts');
  assert.strictEqual(reportTS.extractedErrors[0].line, 45);
  assert.strictEqual(reportTS.extractedErrors[0].errorCode, 'TS2304');
  assert.strictEqual(reportTS.pattern, 'MISSING_IMPORT_OR_SYMBOL', 'Nhận diện pattern MISSING_IMPORT_OR_SYMBOL');
  console.log('  ✅ PASS: Trích xuất lỗi TypeScript compiler & phân loại MISSING_IMPORT_OR_SYMBOL');

  // 2. Kiểm thử trích xuất Node.js / V8 Runtime Stack Trace & Null Dereference
  const nodeRuntimeLog = `
TypeError: Cannot read properties of undefined (reading 'userId')
    at verifySession (D:/AgentLearn/CodingAgent/src/session/auth.ts:34:21)
    at handleRequest (D:/AgentLearn/CodingAgent/src/server.ts:89:10)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
`;
  const reportRuntime = detective.investigate(nodeRuntimeLog);
  assert(reportRuntime.extractedErrors.length >= 1, 'Trích xuất runtime exception');
  assert.strictEqual(reportRuntime.pattern, 'NULL_DEREFERENCE', 'Phân loại đúng NULL_DEREFERENCE');
  assert(reportRuntime.rootCause?.includes('Accessing nested property or method on undefined/null'), 'Giải thích nguyên nhân gốc rễ');
  assert(reportRuntime.cascadingChain && reportRuntime.cascadingChain.length >= 2, 'Xây dựng chuỗi lan truyền cascading');
  console.log('  ✅ PASS: Trích xuất Node runtime stack trace & phân loại NULL_DEREFERENCE với Causal Chain');

  // 3. Kiểm thử trích xuất Python Traceback
  const pythonLog = `
Traceback (most recent call last):
  File "app/main.py", line 12, in <module>
    run_server()
  File "app/server.py", line 55, in run_server
    db = connect_database()
  File "app/db.py", line 88, in connect_database
    raise ConnectionRefusedError("Database port 5432 is not reachable")
ConnectionRefusedError: Database port 5432 is not reachable
`;
  const reportPython = detective.investigate(pythonLog);
  const pyError = reportPython.extractedErrors.find((e) => e.language === 'python');
  assert(Boolean(pyError), 'Trích xuất lỗi Python');
  assert.strictEqual(pyError?.file, 'app/db.py', 'Xác định chính xác frame sâu nhất (app/db.py)');
  assert.strictEqual(pyError?.line, 88);
  assert.strictEqual(pyError?.errorType, 'ConnectionRefusedError');
  console.log('  ✅ PASS: Trích xuất Python traceback xác định chính xác frame lỗi sâu nhất');

  // 4. Kiểm thử trích xuất Test Assertion Failure (Vitest / Jest / Node assert)
  const testAssertionLog = `
FAIL src/math.test.ts > calculateTotal
AssertionError: Expected: 150
Received: 100
    at src/math.test.ts:25:14
`;
  const reportAssertion = detective.investigate(testAssertionLog);
  assert.strictEqual(reportAssertion.pattern, 'ASSERTION_FAILURE', 'Nhận diện ASSERTION_FAILURE');
  assert(Boolean(reportAssertion.suggestedRead), 'Đề xuất khoảng dòng cần đọc để debug');
  console.log('  ✅ PASS: Trích xuất Test Assertion failure và đề xuất vùng đọc code (suggestedRead)');

  // 5. Kiểm thử Go & Rust Parser
  const goLog = `src/handler/user.go:42:15: undefined: UserStore`;
  const reportGo = detective.investigate(goLog);
  assert(reportGo.extractedErrors.some((e) => e.language === 'go'), 'Trích xuất lỗi Go compile');

  const rustLog = `
error[E0425]: cannot find value 'config' in this scope
 --> src/main.rs:18:9
`;
  const reportRust = detective.investigate(rustLog);
  assert(reportRust.extractedErrors.some((e) => e.language === 'rust'), 'Trích xuất lỗi Rust compiler');
  console.log('  ✅ PASS: Trích xuất lỗi biên dịch Go và Rust compiler');

  // 6. Kiểm thử Tích hợp với ReflectionEngine
  const reflectionEngine = new ReflectionEngine();
  const feedback = {
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: {
      exitCode: 1,
      stderr: 'TypeError: Cannot read properties of undefined (reading \'token\')\n    at authenticate (src/auth/jwt.ts:28:10)',
    },
    durationMs: 150,
  };

  const analysis = reflectionEngine.analyze(feedback);
  assert.strictEqual(analysis.isFailure, true, 'ReflectionEngine nhận diện failure');
  assert(Boolean(analysis.detectiveReport), 'ReflectionEngine sinh ra detectiveReport');
  assert.strictEqual(analysis.detectiveReport?.pattern, 'NULL_DEREFERENCE', 'DetectiveReport có pattern NULL_DEREFERENCE');
  assert(analysis.reflectionPrompt?.includes('[ERROR DETECTIVE - CAUSAL ROOT CAUSE ANALYSIS ACTIVATED]'), 'ReflectionPrompt chứa tiêu chuẩn Error Detective');
  console.log('  ✅ PASS: ReflectionEngine tích hợp sâu ErrorDetective sinh Prompt Causal RCA');

  // 7. Kiểm thử CLI UI Render Error Detective Report
  assert.doesNotThrow(() => {
    CLI.renderErrorDetectiveReport(analysis.detectiveReport!);
  }, 'Render CLI không ném exception');
  console.log('  ✅ PASS: CLI.renderErrorDetectiveReport hiển thị trực quan thông tin RCA');

  // 8. Kiểm thử CognitiveHarness tạo Error Detective Scaffold
  const harness = new CognitiveHarness();
  const detectiveScaffold = harness.createScaffold({
    request: '/error-detective Tìm và sửa lỗi null pointer trong jwt.ts',
    phase: 'implement',
  });
  assert.strictEqual(detectiveScaffold.category, 'error_detective', 'Kích hoạt scaffold error_detective');
  assert(detectiveScaffold.negativeGate.some((g) => g.includes('downstream symptoms')), 'Chặn monkey-patch triệu chứng');
  assert(detectiveScaffold.executionTopology.some((t) => t.includes('Backward Causal Tracing')), 'Yêu cầu quy trình Backward Causal Tracing');
  console.log('  ✅ PASS: CognitiveHarness khởi tạo error_detective scaffold với tiêu chuẩn backward causal tracing');

  console.log('\n🎉 TẤT CẢ CÁC BÀI KIỂM THỬ ERROR DETECTIVE ĐÃ ĐẠT 100% THÀNH CÔNG!\n');
}

runErrorDetectiveTests().catch((err) => {
  console.error('❌ LỖI TRONG BÀI KIỂM THỬ:', err);
  process.exit(1);
});
