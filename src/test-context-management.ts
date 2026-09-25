import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ContextSnapshotManager,
  type TaskContextSnapshot,
} from './session/context-snapshot-manager.js';
import { ContextCompactor } from './agent/context-compactor.js';
import { Session } from './session/session.js';

async function runTests() {
  console.log('🧪 Starting Context Management & Context Save Verification Suite...');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-save-test-'));

  try {
    const snapshotManager = new ContextSnapshotManager(tmpDir);
    await snapshotManager.init();

    // -------------------------------------------------------------
    // Test 1: Extract Architectural Decisions from Final Answer
    // -------------------------------------------------------------
    console.log('\n[Test 1] Architectural Decision & Semantic Extraction...');
    const sampleFinalAnswer = [
      'Task completed successfully.',
      '- Kiến trúc hệ thống chuyển sang mô hình Event-Driven kết hợp Snapshot Store.',
      'All tests passing.',
    ].join('\n');
    const mutatedFiles = ['src/session/context-snapshot-manager.ts', 'src/test-context.ts'];
    const decisions = snapshotManager.extractDecisionsFromTurn(
      sampleFinalAnswer,
      mutatedFiles,
      'Nâng cấp cơ chế lưu trữ ngữ cảnh',
    );

    assert(decisions.length >= 2, `Expected at least 2 decisions, got ${decisions.length}`);
    const moduleDec = decisions.find((d) => d.decisionType === 'MODULE_IMPLEMENTATION');
    const designDec = decisions.find((d) => d.decisionType === 'DESIGN_PATTERN_DECISION');
    assert(moduleDec, 'Should detect MODULE_IMPLEMENTATION decision');
    assert(designDec, 'Should detect DESIGN_PATTERN_DECISION decision');
    assert(designDec.rationale.includes('Event-Driven'), 'Rationale should capture pattern');
    console.log('  ✅ Architectural decisions extracted accurately.');

    // -------------------------------------------------------------
    // Test 2: Multi-format Snapshot Capture (JSON + MD with YAML)
    // -------------------------------------------------------------
    console.log('\n[Test 2] Multi-Format Snapshot Serialization...');
    // Create test file in tmpDir so fingerprinting can read mtime
    const dummyFilePath = path.join(tmpDir, 'test-file.ts');
    await fs.writeFile(dummyFilePath, 'export const x = 1;', 'utf8');

    const snapshot = await snapshotManager.captureSnapshot({
      sessionId: 'sess-test-123',
      turn: 1,
      taskPrompt: 'Tạo cơ chế Snapshot theo chuẩn context-management-context-save',
      finalAnswer: sampleFinalAnswer,
      mutatedFiles: [dummyFilePath],
      verificationStatus: 'verified',
      distilledLearnings: ['Snapshot Manager prevents attention decay across tasks'],
    });

    assert(snapshot.snapshotId.startsWith('task-1-'), 'Snapshot ID should include turn');
    assert(snapshot.contextFingerprint.length === 64, 'Fingerprint must be SHA-256 (64 hex chars)');
    assert.strictEqual(snapshot.verificationStatus, 'verified');

    // Verify files on disk
    const jsonPath = path.join(snapshotManager.snapshotsDir, `${snapshot.snapshotId}.json`);
    const mdPath = path.join(snapshotManager.snapshotsDir, `${snapshot.snapshotId}.md`);
    const jsonContent = await fs.readFile(jsonPath, 'utf8');
    const mdContent = await fs.readFile(mdPath, 'utf8');

    const parsedJson: TaskContextSnapshot = JSON.parse(jsonContent);
    assert.strictEqual(parsedJson.snapshotId, snapshot.snapshotId);
    assert(mdContent.includes('---'), 'Markdown must have YAML frontmatter');
    assert(mdContent.includes(snapshot.snapshotId), 'Markdown must contain snapshot ID');
    assert(mdContent.includes('## 2. Architectural Decisions & Rationales'), 'Markdown must contain decisions header');
    console.log('  ✅ Dual-format serialization (JSON + Markdown Frontmatter) verified.');

    // -------------------------------------------------------------
    // Test 3: Snapshot Index Registry
    // -------------------------------------------------------------
    console.log('\n[Test 3] Snapshot Index & Retrieval...');
    const index = await snapshotManager.listSnapshots();
    assert.strictEqual(index.length, 1);
    assert.strictEqual(index[0].snapshotId, snapshot.snapshotId);

    const latest = await snapshotManager.getLatestSnapshot();
    assert(latest !== undefined);
    assert.strictEqual(latest.snapshotId, snapshot.snapshotId);
    console.log('  ✅ Snapshot index & retrieval verified.');

    // -------------------------------------------------------------
    // Test 4: Context Drift Detection
    // -------------------------------------------------------------
    console.log('\n[Test 4] Context Drift Detection...');
    // Initial check: file has not changed -> No drift
    const noDrift = await snapshotManager.detectDrift(snapshot);
    assert.strictEqual(noDrift.hasDrift, false, 'Should report no drift initially');

    // Simulate external drift: modify file with a timestamp in the future
    await new Promise((r) => setTimeout(r, 2100)); // wait > 2000ms
    await fs.writeFile(dummyFilePath, 'export const x = 2; // modified externally', 'utf8');

    const driftDetected = await snapshotManager.detectDrift(snapshot);
    assert.strictEqual(driftDetected.hasDrift, true, 'Should detect drift after external edit');
    assert(driftDetected.divergedFiles.includes(dummyFilePath), 'Diverged files should list modified file');
    console.log('  ✅ Context drift detected accurately upon external workspace modification.');

    // -------------------------------------------------------------
    // Test 5: Task-to-Task Semantic Handoff Digest
    // -------------------------------------------------------------
    console.log('\n[Test 5] Task-to-Task Semantic Handoff Digest...');
    const digest = snapshotManager.generateHandoffDigest([snapshot]);
    assert(digest.includes('INTER-TASK INSTITUTIONAL CONTEXT'), 'Digest should have header');
    assert(digest.includes('TASK 1'), 'Digest should reference Task 1');
    assert(digest.includes('DESIGN_PATTERN_DECISION'), 'Digest should contain architectural decisions');
    assert(digest.includes('INVARIANT: Build upon the decisions'), 'Digest should enforce invariant continuity');
    console.log('  ✅ Semantic handoff digest preserves architectural intent across task boundaries.');

    // -------------------------------------------------------------
    // Test 6: Selective Context Restoration
    // -------------------------------------------------------------
    console.log('\n[Test 6] Selective Context Restoration...');
    const restored = await snapshotManager.restoreSelectiveContext(snapshot.snapshotId, {
      includeDecisions: true,
      includeMutations: true,
      includeLearnings: false,
    });
    assert(restored.includes('SELECTIVE CONTEXT RESTORATION'), 'Should include header');
    assert(restored.includes('Architectural Decisions:'), 'Should include decisions');
    assert(!restored.includes('Distilled Learnings:'), 'Should omit unrequested learnings');
    console.log('  ✅ Selective restoration filters context cleanly.');

    // -------------------------------------------------------------
    // Test 7: Active Auto-Compaction Gate Verification
    // -------------------------------------------------------------
    console.log('\n[Test 7] Active Auto-Compaction Gate Verification...');
    const compactor = new ContextCompactor({
      maxTotalHistoryTokens: 1000,
      preserveLastNToolResults: 2,
      maxCharactersPerToolResult: 300,
    });

    const session = new Session('compaction-test-sess');
    session.addUserMessage('Step 1 initial instruction');
    // Add large messages that exceed threshold
    for (let i = 0; i < 15; i++) {
      session.addModelMessage({
        text: `Execution step ${i}: detailed trace output with lots of characters `.repeat(15),
        functionCalls: [{ name: 'run_command', args: { command: 'echo test' }, id: `call_${i}` } as any],
      });
      session.addToolResultWithId('run_command', { stdout: Array(30).fill(`Command output line trace ${i}`).join('\n') }, `call_${i}`);
    }

    const history = session.getHistory();
    const compactionResult = compactor.compact(history, { triggerRatio: 0.50 });

    assert(compactionResult.stats.tokensSaved > 0, 'Compaction should save tokens');
    assert(compactionResult.stats.compactedTokens < compactionResult.stats.originalTokens, 'Compacted tokens must be less than original');
    assert(compactionResult.messages.length <= history.length, 'Compacted history must be within bound');
    console.log(`  ✅ Auto-compaction gate saved ~${compactionResult.stats.tokensSaved} tokens.`);

    // -------------------------------------------------------------
    // Test 8: Session Event Invariants with Context Snapshot
    // -------------------------------------------------------------
    console.log('\n[Test 8] Session Event Type Invariants...');
    session.append('context/snapshot', {
      snapshotId: snapshot.snapshotId,
      contextFingerprint: snapshot.contextFingerprint,
    });
    const lastEvent = session.getEvents().pop();
    assert.strictEqual(lastEvent?.type, 'context/snapshot');
    assert.strictEqual(lastEvent?.data.snapshotId, snapshot.snapshotId);
    console.log('  ✅ Session successfully recorded context/snapshot event.');

    console.log('\n🎉 ALL 8 TESTS PASSED SUCCESSFULLY! 100% INVARIANT INTEGRITY CONFIRMED.\n');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
