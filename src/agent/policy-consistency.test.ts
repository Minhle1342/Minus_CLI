import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from '../session/session.js';
import { VerificationPolicy } from '../skills/verification-policy.js';
import { CompletionEvidenceGate } from './completion-evidence.js';
import { evaluateSubmission } from './submission-readiness.js';
import { PlanManager } from './plan-manager.js';
import { DomainIntentGuardian } from './domain-intent-guardian.js';
import { ReproductionVerificationManager, TestEngineeringHarness } from '../testing/test-engineering-harness.js';
import { HypothesisTracker } from './hypothesis-tracker.js';
import { AcceptancePolicy } from '../control-plane/critic/acceptance-policy.js';
import { CompletionGate } from '../control-plane/critic/completion-gate.js';
import { createInitialControlPlaneState } from '../control-plane/control-plane-state.js';
import { VerificationContractFactory } from '../control-plane/verification/verification-contract.js';

function context() {
  return { session: new Session(), turn: 1, userRequest: 'Read only: explain the status.', workspaceRoot: process.cwd(),
    codeChangeRequired: false, verificationPolicy: new VerificationPolicy(), evidenceGate: new CompletionEvidenceGate(), evidenceEnabled: true };
}
test('turn reset clears impacted verification obligations', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts', { impactedTestSuites: ['a.test.ts'] });
  policy.reset();
  assert.deepEqual(policy.getPendingTargetedTests(), []);
  assert.equal(policy.canComplete().allowed, true);
});
test('shared submission honors plan, active workers and critic verdict', () => {
  const payload = { summary: 'The workspace is ready for the next request.' };
  assert.equal(evaluateSubmission(payload, { ...context(), planBlocker: 'Unfinished acceptance criterion' }).allowed, false);
  assert.equal(evaluateSubmission(payload, { ...context(), activeAgents: 1 }).allowed, false);
  assert.equal(evaluateSubmission(payload, { ...context(), evaluateCritic: () => ({ approved: false, reasons: ['Syntax error'] }) }).allowed, false);
});
test('disabling evidence gate is respected by readonly grounding audit too', () => {
  const payload = { summary: 'I ran npm test and all tests passed.' };
  assert.equal(evaluateSubmission(payload, context()).allowed, false);
  assert.equal(evaluateSubmission(payload, { ...context(), evidenceEnabled: false }).allowed, true);
});
test('remaining impacted suites cannot be satisfied by a pass for only one suite or build', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts', { impactedTestSuites: ['a.test.ts', 'b.test.ts'] });
  policy.recordVerification('vitest run a.test.ts', true, undefined, 0, { tier: 'targeted_test' });
  assert.equal(policy.canComplete().errorCode, 'IMPACTED_TESTS_REQUIRED');
  policy.recordVerification('npm run build', true, undefined, 0, { tier: 'build' });
  assert.equal(policy.canComplete().errorCode, 'IMPACTED_TESTS_REQUIRED');
  policy.recordVerification('vitest run b.test.ts', true, undefined, 0, { tier: 'targeted_test' });
  assert.equal(policy.canComplete().allowed, true);
});
test('plan task completion cannot reuse unrelated evidence or git status as commit evidence', () => {
  const plan = new PlanManager();
  plan.beginTurn(1, 'Inspect Git status, then commit');
  plan.createPlan([{ title: 'Inspect git status' }, { title: 'Commit changes' }]);
  plan.recordToolEvidence('run_command', { command: 'git status' }, { success: true, exitCode: 0 });
  plan.updateTask(1, 'COMPLETED');
  assert.throws(() => plan.updateTask(2, 'COMPLETED'), /successful.*evidence/);
  plan.recordToolEvidence('run_command', { command: 'git status' }, { success: true, exitCode: 0 });
  assert.throws(() => plan.updateTask(2, 'COMPLETED'), /successful.*evidence/);
  plan.recordToolEvidence('run_command', { command: 'git commit -m fix' }, { success: true, exitCode: 0 });
  assert.equal(plan.updateTask(2, 'COMPLETED')?.status, 'COMPLETED');
});
test('test modification negations beat positive keywords and patch targets are checked', () => {
  const guardian = new DomainIntentGuardian();
  guardian.extractAndFreezeContract('Fix the issue; do not update tests, run unit tests.');
  assert.equal(guardian.getContract()?.allowTestFileModification, false);
  assert.equal(guardian.observeToolCall({ toolName: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: src/a.test.ts\n@@\n*** End Patch' } })?.severity, 'BLOCKING');
  assert.equal(guardian.observeToolCall({ toolName: 'create_file', args: { path: 'src/new.test.ts' } })?.severity, 'BLOCKING');
});
test('reproduction requires same command, hypothesis, order and mutation version', () => {
  const repro = new ReproductionVerificationManager();
  repro.recordAttempt('test A', 1, 'failure', false, { hypothesisId: 'H1', mutationSeq: 0 });
  repro.recordAttempt('test B', 0, 'pass', true, { hypothesisId: 'H1', mutationSeq: 1 });
  assert.equal(repro.hasVerifiedFix(), false);
  repro.recordAttempt('test A', 0, 'pass', true, { hypothesisId: 'H1', mutationSeq: 1 });
  assert.equal(repro.hasVerifiedFix(), true);
  repro.recordAttempt('test A', 1, 'later fail', true, { hypothesisId: 'H1', mutationSeq: 2 });
  assert.equal(repro.hasVerifiedFix(), false);
  const reversed = new ReproductionVerificationManager();
  reversed.recordAttempt('test A', 0, 'pass', true);
  reversed.recordAttempt('test A', 1, 'fail', false);
  assert.equal(reversed.hasVerifiedFix(), false);
});
test('expected failing reproduction validates hypothesis instead of triggering rollback', async () => {
  const tracker = new HypothesisTracker();
  const hypothesis = tracker.formulate({ statement: 'The test reproduces the fault.', falsificationTest: 'test should fail' });
  const harness = new TestEngineeringHarness({ workspaceRoot: process.cwd(), hypothesisTracker: tracker,
    substrate: { exec: async () => ({ stdout: 'FAIL example.test.ts\nTests: 1 failed, 1 total\nTest Suites: 1 failed, 1 total', stderr: '', exitCode: 1, durationMs: 1 }) } as any });
  await harness.runTests({ testCommand: 'npm test', hypothesisId: hypothesis.id, expectedOutcome: 'fail' });
  assert.equal(tracker.getLatestHypothesis()?.status, 'validated');
});
test('latent EDCP readonly completion still requires submission and resolved testing hypothesis', () => {
  const workspace = createInitialControlPlaneState({ workspaceRoot: process.cwd() }).workspace;
  const contract = VerificationContractFactory.createContract({ taskId: 'readonly', taskGoal: 'Explain the status' });
  const params = { workspace, contract, freshEvidence: [], allEvidence: [] };
  assert.equal(CompletionGate.evaluateCompletion(params).canComplete, false);
  assert.equal(CompletionGate.evaluateCompletion({ ...params, hasSubmittedSolution: true }).canComplete, true);
  assert.equal(CompletionGate.evaluateCompletion({ ...params, hasSubmittedSolution: true, activeHypothesis: { id: 'H1', status: 'TESTING' } as any }).canComplete, false);
});
test('latent EDCP acceptance diagnostics are scoped to changed files', () => {
  const diagnostics = { errors: [{ file: 'unrelated.ts', line: 1, message: 'old error', category: 'error' as const }], syntaxErrors: [], unresolvedImports: [], warnings: [], timestamp: Date.now() };
  assert.equal(AcceptancePolicy.checkHardInvariants({ diagnostics, changedFiles: [] }).passed, true);
  assert.equal(AcceptancePolicy.checkHardInvariants({ diagnostics, changedFiles: [{ path: 'unrelated.ts' } as any] }).passed, false);
});
test('Provenance-aware: Agent-created test files are allowed to be modified while human base files are guarded', () => {
  const guardian = new DomainIntentGuardian();
  guardian.extractAndFreezeContract('Fix logic error in src/calculator.ts');
  assert.equal(guardian.getContract()?.allowTestFileModification, false);

  // File do Agent tạo ra trong phiên làm việc
  guardian.recordAgentCreatedFile('src/tests/agent-new.test.ts');
  const agentFileEdit = guardian.observeToolCall({
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'src/tests/agent-new.test.ts',
      TargetContent: 'expect(a).toBe(1)',
      ReplacementContent: '// commented out',
    },
  });
  assert.equal(agentFileEdit, null, 'Agent được toàn quyền sửa file test do chính Agent sinh ra trong phiên làm việc');

  // File test gốc của con người bị chặn khi comment out assert
  const humanFileTamper = guardian.observeToolCall({
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'src/tests/human-origin.test.ts',
      TargetContent: 'expect(a).toBe(1)',
      ReplacementContent: '// expect(a).toBe(1)',
    },
  });
  assert.equal(humanFileTamper?.severity, 'BLOCKING', 'File test gốc của con người bị chặn khi Agent cố tình comment out assert');
});
test('Assertion Strength Check: Allows adding/maintaining assert count, blocks commenting out or deleting asserts', () => {
  const guardian = new DomainIntentGuardian();
  guardian.extractAndFreezeContract('Fix calculateTax function in src/tax.ts');

  // 1. Tăng số lượng assert (1 -> 2): CHO PHÉP
  const addAssert = guardian.observeToolCall({
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'src/tests/tax.test.ts',
      TargetContent: 'assert.equal(tax, 10);',
      ReplacementContent: 'assert.equal(tax, 10);\nassert.equal(total, 110);',
    },
  });
  assert.equal(addAssert, null, 'Cho phép sửa nếu số lượng assert tăng lên');

  // 2. Giữ nguyên số lượng assert (1 -> 1): CHO PHÉP
  const keepAssert = guardian.observeToolCall({
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'src/tests/tax.test.ts',
      TargetContent: 'assert.equal(tax, 10);',
      ReplacementContent: 'assert.strictEqual(tax, 10);',
    },
  });
  assert.equal(keepAssert, null, 'Cho phép sửa nếu số lượng assert tương đương');

  // 3. Comment out assert: CHẶN
  const commentOut = guardian.observeToolCall({
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'src/tests/tax.test.ts',
      TargetContent: 'assert.equal(tax, 10);',
      ReplacementContent: '// assert.equal(tax, 10);',
    },
  });
  assert.equal(commentOut?.type, 'TEST_TAMPERING');
  assert.equal(commentOut?.severity, 'BLOCKING');

  // 4. Xóa bớt assert (2 -> 1): CHẶN
  const deleteAssert = guardian.observeToolCall({
    toolName: 'replace_file_content',
    args: {
      TargetFile: 'src/tests/tax.test.ts',
      TargetContent: 'assert.equal(tax, 10);\nassert.equal(rate, 0.1);',
      ReplacementContent: 'assert.equal(tax, 10);',
    },
  });
  assert.equal(deleteAssert?.type, 'TEST_TAMPERING');
  assert.equal(deleteAssert?.severity, 'BLOCKING');
});

