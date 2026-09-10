import fs from 'node:fs';
import path from 'node:path';
import {
  AgentOrchestrator,
  computeTaskSimilarity,
  computeTaskSimilarityDetailed,
} from '../src/agent/agent-orchestrator.js';
import { AgentRegistry } from '../src/agent/agent-registry.js';
import { LocalProcessSandbox } from '../src/sandbox/local-sandbox.js';
import { VirtualWorkspace } from '../src/workspace/virtual-workspace.js';
import {
  getNativeVersion,
  isNativeAvailable,
  nativeExecuteSandboxed,
} from '../src/native/index.js';

async function verifyAllTier4Milestones() {
  console.log('========================================================================');
  console.log('🚀 MINUS_CLI: KIỂM TRA TOÀN DIỆN 3 BƯỚC NÂNG CẤP ORCHESTRATOR LÊN TIER 4+');
  console.log('========================================================================\n');

  console.log('📦 NATIVE RUNTIME ENGINE:');
  console.log('   ▸ Status:  ', isNativeAvailable() ? 'ONLINE (Loaded)' : 'OFFLINE (Fallback)');
  console.log('   ▸ Version: ', getNativeVersion());
  console.log('   ▸ Features: SIMD Cosine, Subword Embedding, WinJob Sandbox, CoW VFS\n');

  if (!isNativeAvailable()) {
    throw new Error('Native addon minus_core must be available for Tier 4+ operations!');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BƯỚC 1: HYBRID SEMANTIC TASK DEDUPLICATION & INTENT ROUTER
  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── BƯỚC 1: SEMANTIC TASK DEDUPLICATION & INTENT ROUTER ───────────────');
  const taskA = 'Fix JWT auth token timeout expiration bug';
  const taskB = 'Resolve authentication bearer token expiry issue';
  const taskC = 'Refactor SQL migration schema for user table';

  const breakdownAB = computeTaskSimilarityDetailed(taskA, taskB);
  console.log('   ▸ Task A:', taskA);
  console.log('   ▸ Task B:', taskB);
  console.log(`   ▸ Similarity: ${(breakdownAB.combinedScore * 100).toFixed(1)}% [Match Type: ${breakdownAB.matchType}]`);
  console.log(`     (Lexical: ${(breakdownAB.lexicalScore * 100).toFixed(1)}% | Semantic Vector: ${(breakdownAB.semanticScore * 100).toFixed(1)}%)`);

  const breakdownAC = computeTaskSimilarityDetailed(taskA, taskC);
  console.log('   ▸ Task C:', taskC);
  console.log(`   ▸ Task A vs Task C Similarity: ${(breakdownAC.combinedScore * 100).toFixed(1)}%`);

  if (breakdownAB.combinedScore < 0.65 || breakdownAB.matchType !== 'semantic') {
    throw new Error('Bước 1 Check Failed: Expected high semantic match between Task A & Task B');
  }
  if (breakdownAC.combinedScore >= 0.40) {
    throw new Error('Bước 1 Check Failed: Expected low similarity between Task A & Task C');
  }

  // Kiểm tra chặn trùng lặp trong AgentOrchestrator
  const registry = new AgentRegistry();
  registry.register('agent-security', 'Security Specialist');
  registry.update('agent-security', { capabilities: ['security', 'auth'] });
  const orchestrator = new AgentOrchestrator(registry);

  orchestrator.allocateTask(taskA, ['auth'], { checkAntiDuplication: true });
  let blocked = false;
  try {
    orchestrator.allocateTask(taskB, ['auth'], { checkAntiDuplication: true });
  } catch (err: any) {
    if (err.message.includes('DUPLICATE_TASK_DETECTED') && err.message.includes('Semantic Vector SIMD')) {
      blocked = true;
      console.log('   ▸ Chặn thành công: ' + err.message.split('\n')[0]);
    }
  }

  if (!blocked) {
    throw new Error('Bước 1 Check Failed: Orchestrator failed to detect duplicate semantic task');
  }
  console.log('   ✅ BƯỚC 1 PASSED: Hybrid Lexical-Vector Router hoạt động xuất sắc!\n');

  // ──────────────────────────────────────────────────────────────────────────
  // BƯỚC 2: HARD PROCESS ISOLATION & KERNEL-LEVEL SANDBOX GUARD
  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── BƯỚC 2: HARD PROCESS ISOLATION (WINDOWS JOB OBJECTS) ──────────────');
  const sandbox = new LocalProcessSandbox();
  const sbStatus = sandbox.getStatus();
  console.log('   ▸ Sandbox Mode:      ', sbStatus.mode);
  console.log('   ▸ Hard Isolation:    ', sbStatus.isIsolated);

  if (!sbStatus.isIsolated) {
    throw new Error('Bước 2 Check Failed: Sandbox should report hard isolation active');
  }

  // Kiểm tra thực thi có quota
  const execResult = nativeExecuteSandboxed('echo "Minus Job Object Guard Active"', process.cwd(), 5000, 1024 * 1024, 1024);
  console.log('   ▸ Sandboxed Execution:', execResult?.stdout?.trim());
  console.log('   ▸ Duration:           ', execResult?.durationMs, 'ms');
  console.log('   ▸ Is Sandboxed:       ', execResult?.isSandboxed);

  if (!execResult || execResult.exitCode !== 0 || !execResult.stdout.includes('Minus Job Object Guard Active')) {
    throw new Error('Bước 2 Check Failed: Sandboxed command failed');
  }

  // Kiểm tra timeout tree-kill
  const tStart = Date.now();
  const timeoutRes = await sandbox.exec('ping 127.0.0.1 -n 5', { timeoutMs: 600 });
  const tElapsed = Date.now() - tStart;
  console.log(`   ▸ Timeout Test: TimedOut=${timeoutRes.timedOut}, ExitCode=${timeoutRes.exitCode}, Terminated in ${tElapsed}ms`);

  if (!timeoutRes.timedOut || tElapsed >= 3000) {
    throw new Error('Bước 2 Check Failed: Process was not killed by Job Object guard promptly');
  }
  console.log('   ✅ BƯỚC 2 PASSED: Job Object Guard bảo vệ tài nguyên và diệt tiến trình con triệt để!\n');

  // ──────────────────────────────────────────────────────────────────────────
  // BƯỚC 3: IN-MEMORY COPY-ON-WRITE (CoW) VIRTUAL WORKSPACE
  // ──────────────────────────────────────────────────────────────────────────
  console.log('─── BƯỚC 3: IN-MEMORY CoW VIRTUAL WORKSPACE (ZERO-COST BRANCHING) ──────');
  const vfsSessionId = `subagent_tier4_${Date.now()}`;
  const vfs = orchestrator.createVirtualWorkspace('subagent-swe-1', process.cwd());

  console.log('   ▸ Virtual Workspace Session:', vfs.sessionId);
  
  // 1. Đọc file base
  const basePkg = vfs.readFile('package.json');
  if (!basePkg || !basePkg.includes('mini-agent-loop')) {
    throw new Error('Bước 3 Check Failed: Cannot read package.json via VFS');
  }

  // 2. Ghi đè trong RAM
  const virtualFilePath = 'src/virtual_test_tier4.ts';
  const virtualContent = '// Tier 4 Multi-Agent In-Memory Code\nexport const TIER_4_ACTIVE = true;\n';
  vfs.writeFile(virtualFilePath, virtualContent);
  vfs.writeFile('package.json', basePkg.replace('"version": "1.0.0"', '"version": "1.0.0-tier4-cow"'));

  // 3. Kiểm tra đĩa vật lý không bị đụng chạm
  const physicalDiskContent = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
  if (physicalDiskContent.includes('tier4-cow')) {
    throw new Error('Bước 3 Check Failed: Physical disk was modified prematurely!');
  }
  if (fs.existsSync(path.join(process.cwd(), virtualFilePath))) {
    throw new Error('Bước 3 Check Failed: Physical disk contains virtual file before commit!');
  }
  console.log('   ▸ Physical Disk Isolation: 100% Nguyên vẹn (Zero disk pollution)');

  // 4. Sinh Diff và thống kê
  const stats = vfs.getStats();
  console.log(`   ▸ VFS Stats: ${stats.totalDirtyFiles} dirty files (${stats.createdCount} created, ${stats.modifiedCount} modified)`);
  const diffOutput = vfs.generateDiff();
  console.log('   ▸ VFS Unified Diff Generated: ' + diffOutput.split('\n')[0]);

  // 5. Thử nghiệm atomic commit
  const tempVerifyPath = 'scratch/temp_tier4_flush.txt';
  vfs.writeFile(tempVerifyPath, 'Tier 4 flush verified at ' + new Date().toISOString());
  const committed = vfs.commitToDisk();
  console.log('   ▸ Committed files:', committed);

  const fullVerifyPath = path.join(process.cwd(), tempVerifyPath);
  if (!fs.existsSync(fullVerifyPath)) {
    throw new Error('Bước 3 Check Failed: File was not committed to disk');
  }

  // Dọn dẹp
  if (fs.existsSync(fullVerifyPath)) {
    fs.unlinkSync(fullVerifyPath);
  }
  const fullVirtualPath = path.join(process.cwd(), virtualFilePath);
  if (fs.existsSync(fullVirtualPath)) {
    fs.unlinkSync(fullVirtualPath);
  }
  // Revert package.json if needed
  if (committed.includes('package.json')) {
    fs.writeFileSync(path.join(process.cwd(), 'package.json'), physicalDiskContent, 'utf8');
  }
  vfs.discard();
  console.log('   ✅ BƯỚC 3 PASSED: Virtual Workspace rẽ nhánh trong RAM O(1) và commit nguyên tử thành công!\n');

  console.log('========================================================================');
  console.log('🏆 KẾT QUẢ: TOÀN BỘ 3 BƯỚC NÂNG CẤP TIẾN ĐẾN TIER 4+ ĐẠT 100% HOÀN HẢO!');
  console.log('========================================================================');
}

verifyAllTier4Milestones().catch((err) => {
  console.error('\n❌ FAILED:', err);
  process.exit(1);
});
