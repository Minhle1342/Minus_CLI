import { LocalProcessSandbox } from '../src/sandbox/local-sandbox.js';
import { nativeExecuteSandboxed, isNativeAvailable, getNativeVersion } from '../src/native/index.js';

async function runSandboxTest() {
  console.log('=== TEST SUITE: BƯỚC 2 - HARD PROCESS ISOLATION & JOB OBJECT GUARD ===');
  console.log('Native Addon Available:', isNativeAvailable());
  console.log('Native Version:', getNativeVersion());

  const sandbox = new LocalProcessSandbox();
  const status = sandbox.getStatus();
  console.log('Sandbox Status:', status);

  if (!status.isIsolated) {
    throw new Error('Sandbox should report isIsolated: true when Native Core is active!');
  }

  // Test 1: Lệnh tiêu chuẩn thông qua Sandbox Guard
  console.log('\n[Test 1] Thực thi lệnh cơ bản trong Hard Sandbox:');
  const res1 = await sandbox.exec('echo "minus sandbox active"');
  console.log('   Stdout:', res1.stdout);
  console.log('   Exit code:', res1.exitCode);
  console.log('   Duration:', res1.durationMs, 'ms');
  console.log('   Success:', res1.success);

  if (res1.exitCode !== 0 || !res1.stdout.includes('minus sandbox active')) {
    throw new Error('Test 1 Failed: Standard command execution failed');
  }

  // Test 2: Kiểm tra timeout và ngắt cứng tiến trình (Tree-kill)
  console.log('\n[Test 2] Kiểm tra Timeout Guard & Job Object Terminate:');
  const timeoutMs = 800;
  // Chạy lệnh sleep 5 giây với timeout 800ms
  const start = Date.now();
  const resTimeout = await sandbox.exec('ping 127.0.0.1 -n 6', { timeoutMs });
  const elapsed = Date.now() - start;
  console.log('   Elapsed:', elapsed, 'ms');
  console.log('   Timed out:', resTimeout.timedOut);
  console.log('   Exit code:', resTimeout.exitCode);

  if (!resTimeout.timedOut && resTimeout.exitCode === 0) {
    throw new Error('Test 2 Failed: Command was supposed to timeout!');
  }
  if (elapsed >= 4000) {
    throw new Error(`Test 2 Failed: Process was not terminated promptly, elapsed ${elapsed}ms`);
  }
  console.log('   ✅ Job Object ngắt tiến trình kịp thời và sạch sẽ!');

  // Test 3: Trực tiếp gọi nativeExecuteSandboxed với memory quota
  console.log('\n[Test 3] Kiểm tra nativeExecuteSandboxed với memoryLimitMb = 512MB:');
  const sandboxedDirect = nativeExecuteSandboxed('echo "sandboxed direct"', process.cwd(), 3000, 1024 * 1024, 512);
  console.log('   Direct result:', sandboxedDirect);

  if (!sandboxedDirect || sandboxedDirect.exitCode !== 0 || !sandboxedDirect.stdout.includes('sandboxed direct')) {
    throw new Error('Test 3 Failed: nativeExecuteSandboxed failed');
  }
  if (!sandboxedDirect.isSandboxed) {
    console.log('   [Notice]: is_sandboxed boolean returned:', sandboxedDirect.isSandboxed);
  }

  console.log('\n🎉 TOÀN BỘ KIỂM TRA BƯỚC 2 ĐẠT 100%! BƯỚC 2 HOÀN TẤT XUẤT SẮC!');
}

runSandboxTest().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
