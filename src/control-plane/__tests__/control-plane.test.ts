import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  EvidenceDrivenControlPlane,
  EvidenceLedger,
  EvidenceRecordBuilder,
  WorkspaceStateManager,
  HypothesisGraph,
  HypothesisRanker,
  FalsificationEngine,
  MutationImpactAnalyzer,
  VerificationContractFactory,
  VerificationContractEngine,
  ProgressVectorCalculator,
  StagnationDetector,
  STRATEGY_POLICIES,
  AcceptancePolicy,
  CriticEngine,
  CompletionGate,
  CompletionReportGenerator,
} from '../index.js';
import { Workspace } from '../../workspace/workspace.js';
import { CheckpointManager } from '../../workspace/checkpoint.js';

let passed = 0;
let failed = 0;
const failureList: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    failed++;
    failureList.push(message);
    console.error(`  ❌ FAIL: ${message}`);
  }
}

export async function runControlPlaneTests(): Promise<{ passed: number; failed: number }> {
  console.log('\n========================================');
  console.log('🧪 EVIDENCE-DRIVEN CONTROL PLANE TEST SUITE (SCENARIOS A - H)');
  console.log('========================================');

  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcp-test-'));
  fs.writeFileSync(path.join(testTempDir, 'package.json'), JSON.stringify({ name: 'edcp-test-app', version: '1.0.0' }));
  fs.writeFileSync(path.join(testTempDir, 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

  try {
    const ws = new Workspace(testTempDir);
    const cp = new EvidenceDrivenControlPlane({ workspace: ws });

    // ========================================
    // Scenario A: Stale Evidence Invalidation & Rejection
    // ========================================
    console.log('\n--- Scenario A: Stale Evidence Invalidation & Rejection ---');
    await cp.captureBaseline('Initial test baseline');
    assert(cp.getState().workspace.workspaceDigest.length === 64, 'Baseline workspace digest SHA-256 is accurately calculated');
    assert(cp.getState().workspace.lastGreenCheckpoint !== undefined, 'Initial baseline is recorded as G0 green checkpoint');

    // Record initial passing test evidence at mutationSeq #0
    const ev1 = cp.recordEvidence({
      type: 'test',
      sourceTool: 'run_command',
      command: 'npm test',
      status: 'PASS',
      summary: 'All unit tests passed',
      affectedFiles: ['math.ts'],
    });
    assert(ev1.status === 'PASS' && ev1.freshness === 'FRESH', 'Recorded evidence is marked FRESH');

    // Mutate math.ts -> mutationSeq increments -> ev1 must be marked STALE
    const mutResult = cp.recordMutation({ filePath: 'math.ts' });
    assert(mutResult.mutationSeq === 1, 'Mutation increments active mutation sequence to #1');
    assert(mutResult.invalidatedEvidenceIds.includes(ev1.evidenceId), 'Mutation invalidates prior evidence on affected file');

    const freshEvidenceAfterMutation = cp.evidenceLedger.getFresh(cp.workspaceManager.getState());
    assert(freshEvidenceAfterMutation.length === 0, 'Ledger confirms zero fresh evidence remains for mutated file');

    // Critic Gate must reject completion when required evidence is STALE
    const completionBeforeRerun = cp.authorizeCompletion(false);
    assert(completionBeforeRerun.authorized === false, 'CompletionGate rejects completion when evidence is stale');
    assert(completionBeforeRerun.decision.staleEvidence.length > 0, 'Critic lists specific stale evidence items requiring re-run');

    // Re-run test and record fresh evidence at mutationSeq #1
    const ev2 = cp.recordEvidence({
      type: 'test',
      sourceTool: 'run_command',
      command: 'npm test',
      status: 'PASS',
      summary: 'All unit tests passed after mutation',
      affectedFiles: ['math.ts'],
    });
    assert(ev2.freshness === 'FRESH', 'New evidence at current mutation sequence is FRESH');

    // ========================================
    // Scenario B: Compiler Regression Hard Rejection (Invariant 2.1)
    // ========================================
    console.log('\n--- Scenario B: Compiler & Syntax Regression Hard Invariant ---');
    const hardCheck = AcceptancePolicy.checkHardInvariants({
      diagnostics: {
        errors: [{ file: 'math.ts', line: 1, message: 'Type error: cannot assign string to number', category: 'error' }],
        syntaxErrors: [],
        unresolvedImports: [],
        warnings: [],
        timestamp: Date.now(),
      },
      changedFiles: [{ path: 'math.ts', language: 'typescript', contentHash: 'abc', mutationSeq: 1 }],
    });
    assert(hardCheck.passed === false, 'Hard Invariant 2.1: Compiler error forces passed = false');
    assert(hardCheck.violations.some(v => v.includes('compiler')), 'Hard violation mentions compiler error');

    const decisionWithCompilerError = CriticEngine.evaluate({
      workspace: {
        ...cp.getState().workspace,
        diagnostics: {
          errors: [{ file: 'math.ts', line: 1, message: 'Type error: cannot assign string to number', category: 'error' }],
          syntaxErrors: [],
          unresolvedImports: [],
          warnings: [],
          timestamp: Date.now(),
        },
      },
      freshEvidence: [ev2],
      allEvidence: [ev1, ev2],
      contract: cp.getState().verification.contract,
    });
    assert(decisionWithCompilerError.score === 0, 'Hard Invariant 2.1: Compiler error forces candidate score to exactly 0');
    assert(decisionWithCompilerError.approved === false, 'Hard Invariant 2.1: Compiler error forces approved = false');
    assert(decisionWithCompilerError.hardBlockers.some(b => b.includes('compiler')), 'Hard blocker mentions compiler regression');

    // ========================================
    // Scenario C: Repeated Failed Hypothesis Rejection (Invariant 2.3)
    // ========================================
    console.log('\n--- Scenario C: Repeated Failed Hypothesis Prevention ---');
    const hypGraph = new HypothesisGraph();
    const h1 = hypGraph.formulate({
      statement: 'Add type cast to fix overflow in math.ts',
      targetFiles: ['math.ts'],
    });
    assert(h1.id === 'H1', 'Initial hypothesis H1 formulated successfully');

    // Mark H1 as falsified
    hypGraph.markFalsified(h1.id, 'Test failed on negative boundary values');
    const falsifiedList = hypGraph.getAll().filter(h => h.status === 'FALSIFIED');
    assert(falsifiedList.length === 1, 'Hypothesis recorded in falsified set');

    // Check repetition detection
    const repetitionCheck = hypGraph.isRepeatedFalsified('Add type cast to fix overflow in math.ts');
    assert(repetitionCheck.isRepeated === true, 'Invariant 2.3: Formulating semantically identical hypothesis to falsified one is detected');

    // Formulate via Control Plane
    const cpRepeatAttempt = cp.formulateHypothesis({
      statement: 'Add type cast to fix overflow in math.ts',
      targetFiles: ['math.ts'],
    });
    // First formulation in CP
    cp.hypothesisGraph.markFalsified(cpRepeatAttempt.hypothesis!.id, 'Failed on negative values');
    const cpBlockedAttempt = cp.formulateHypothesis({
      statement: 'Add type cast to fix overflow in math.ts',
      targetFiles: ['math.ts'],
    });
    assert(cpBlockedAttempt.allowed === false, 'Invariant 2.3: Control plane blocks formulation of repeating falsified hypothesis');

    // ========================================
    // Scenario D: Stagnation Detection & Strategy Switching (Invariant 2.4)
    // ========================================
    console.log('\n--- Scenario D: Stagnation & Ping-Pong Loop Auto Switch ---');
    const stagDetector = new StagnationDetector();
    stagDetector.record({ toolName: 'read_file', argsFingerprint: 'math.ts:1-10', resultFingerprint: 'res_1', mutationSeq: 1, isFailure: false });
    stagDetector.record({ toolName: 'read_file', argsFingerprint: 'math.ts:1-10', resultFingerprint: 'res_1', mutationSeq: 1, isFailure: false });
    const checkStagnation = stagDetector.record({ toolName: 'read_file', argsFingerprint: 'math.ts:1-10', resultFingerprint: 'res_1', mutationSeq: 1, isFailure: false });
    assert(checkStagnation.stagnant === true, 'StagnationDetector flags stagnation after 3 consecutive identical operations');
    assert(checkStagnation.actionRequired === 'SWITCH_STRATEGY', 'Invariant 2.4: Requests strategy switch');

    const pingPongDetector = new StagnationDetector();
    pingPongDetector.record({ toolName: 'edit_A', argsFingerprint: 'A', resultFingerprint: 'out_A', mutationSeq: 1, isFailure: false });
    pingPongDetector.record({ toolName: 'edit_B', argsFingerprint: 'B', resultFingerprint: 'out_B', mutationSeq: 1, isFailure: false });
    pingPongDetector.record({ toolName: 'edit_A', argsFingerprint: 'A', resultFingerprint: 'out_A', mutationSeq: 1, isFailure: false });
    const checkPingPong = pingPongDetector.record({ toolName: 'edit_B', argsFingerprint: 'B', resultFingerprint: 'out_B', mutationSeq: 1, isFailure: false });
    assert(Boolean(checkPingPong.stagnant && /ping-pong/i.test(checkPingPong.reason || '')), 'Ping-pong alternating loop is detected');

    // ========================================
    // Scenario E: Green Checkpoint Promotion & Invariant Rollback
    // ========================================
    console.log('\n--- Scenario E: Green Checkpoint Promotion & Invariant Rollback ---');
    cp.promoteCandidate('Verified addition helper implementation');
    assert(Boolean(cp.getState().workspace.lastGreenCheckpoint), 'Candidate promoted to new green checkpoint');

    // Rollback candidate
    const rollbackResult = await cp.rollbackCandidate('Simulation of broken invariant rollback');
    assert(rollbackResult.success === true, 'Rollback engine successfully restores workspace to last green checkpoint');

    // ========================================
    // Scenario F: Parallel Hypothesis Search & Ranking
    // ========================================
    console.log('\n--- Scenario F: Parallel Hypothesis Search & Multi-Factor Ranking ---');
    const hRankGraph = new HypothesisGraph();
    const hRank1 = hRankGraph.formulate({
      statement: 'Implement fast bitwise addition',
      confidence: 0.9,
      estimatedExperimentCost: 1.0,
      predictedObservations: [{ description: 'Test pass', expectedOutcome: 'PASS', targetCommandOrTool: 'run_command' }],
    });
    const hRank2 = hRankGraph.formulate({
      statement: 'Refactor whole math engine to WebAssembly',
      confidence: 0.4,
      estimatedExperimentCost: 8.0,
      predictedObservations: [],
    });
    assert(hRank1.id.length > 0 && hRank2.id.length > 0, 'Candidate hypotheses formulated');

    const ranked = HypothesisRanker.rank([hRank1, hRank2]);
    assert(ranked[0].hypothesis.id === hRank1.id, 'Hypothesis with higher Information Gain / Cost is ranked #1');

    // ========================================
    // Scenario G: Easy Task Cost Control (Tier 0 / Tier 1 Strategy Policy)
    // ========================================
    console.log('\n--- Scenario G: Easy Task Adaptive Compute & Cost Control ---');
    const tier0 = STRATEGY_POLICIES[0];
    assert(tier0.strategy === 'DIRECT' && tier0.tokenBudget === 0, 'Tier 0 enforces DIRECT execution without hypothesis overhead');

    const tier3 = STRATEGY_POLICIES[3];
    assert(tier3.strategy === 'DEEP_CAUSAL' && tier3.tokenBudget === 16384, 'Tier 3 provides high compute budget for deep causal reasoning');

    // ========================================
    // Scenario H: High-Risk Refactor Blast Radius & Verified Completion Report
    // ========================================
    console.log('\n--- Scenario H: Blast Radius Analysis & Completion Audit Report ---');
    const impact = MutationImpactAnalyzer.analyze({
      changedFiles: ['src/kernel/kernel.ts'],
    });
    assert(impact.risk === 'CRITICAL' || impact.risk === 'HIGH_RISK', 'Core kernel mutation calculates elevated risk level');

    // Verified Completion Report Generation
    const completionReport = CompletionReportGenerator.generate(
      cp.getState(),
      [ev2],
    );

    assert(completionReport.finalWorkspaceDigest.length === 64, 'Completion report contains SHA-256 final digest');
    assert(completionReport.verificationEvidence.length >= 1, 'Completion report contains fresh verification evidence');
    assert(completionReport.auditTrail.includes('MINUS VERIFIED COMPLETION AUDIT TRAIL'), 'Markdown audit report formatted correctly');

    console.log(`\n========================================`);
    console.log(`EDCP SCENARIOS: ${passed} Passed, ${failed} Failed`);
    if (failureList.length > 0) {
      console.log('DANH SÁCH LỖI:');
      failureList.forEach((f, idx) => console.log(`  ${idx + 1}. ❌ ${f}`));
    }
    console.log(`========================================\n`);

    return { passed, failed };
  } finally {
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {}
  }
}
