import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClassificationEngine } from '../control/classification-engine.js';
import { Session } from '../session/session.js';
import { createHypothesisTool } from '../tools/hypothesis-tool.js';
import { ToolUseGuardian } from '../tools/tool-use-guardian.js';
import { Workspace } from '../workspace/workspace.js';
import { HypothesisTracker } from './hypothesis-tracker.js';
import { CognitiveHarness } from './cognitive-harness.js';
import { assessParetoEvidence } from './pareto-evidence-policy.js';

function sessionWithObservations(observations: Array<{
  toolName: string;
  args?: Record<string, any>;
  result: Record<string, any>;
}>): Session {
  const session = new Session('pareto-test');
  session.append('turn/start', { turn: 1 });
  observations.forEach((observation, index) => {
    const toolCallId = `call-${index}`;
    session.append('tool/call', {
      turn: 1,
      toolCallId,
      toolName: observation.toolName,
      args: observation.args || {},
    });
    session.addToolResultWithId(observation.toolName, observation.result, toolCallId);
  });
  return session;
}

test('Pareto evidence thresholds scale with risk and observed feedback', () => {
  const empty = assessParetoEvidence({
    session: sessionWithObservations([]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R2',
  });
  assert.equal(empty.score, 0);
  assert.equal(empty.threshold, 3);
  assert.equal(empty.hasSufficientEvidence, false);

  const planned = assessParetoEvidence({
    session: sessionWithObservations([]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R2',
  });
  assert.equal(planned.score, 0, 'a plan is context, not causal proof, so it carries no score');
  assert.equal(planned.hasSufficientEvidence, false);

  const failingTest = assessParetoEvidence({
    session: sessionWithObservations([{
      toolName: 'run_command',
      args: { command: 'npm test -- parser' },
      result: { success: false, exitCode: 1, stderr: 'assertion failed' },
    }]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R2',
  });
  assert.equal(failingTest.hasFailureEvidence, true);
  assert.equal(failingTest.hasEmpiricalEvidence, true);
  assert.equal(failingTest.hasSufficientEvidence, true);

  const passingTest = assessParetoEvidence({
    session: sessionWithObservations([{
      toolName: 'run_command',
      args: { command: 'npm test -- parser' },
      result: { success: true, exitCode: 0 },
    }]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R2',
  });
  assert.equal(passingTest.hasEmpiricalEvidence, true);
  assert.equal(passingTest.score, failingTest.score, 'a green suite is evidence too: fixing a bug must not lower the score');
  assert.equal(passingTest.hasSufficientEvidence, true);

  const testDidNotStart = assessParetoEvidence({
    session: sessionWithObservations([{
      toolName: 'run_command',
      args: { command: 'npm test' },
      result: { success: false, exitCode: 1, errorCode: 'COMMAND_NOT_FOUND' },
    }]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R2',
  });
  assert.equal(testDidNotStart.hasEmpiricalEvidence, false);
  assert.equal(testDidNotStart.hasSufficientEvidence, false);

  const supportedHighRisk = assessParetoEvidence({
    session: sessionWithObservations([]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R3',
    supportedHypothesisCount: 1,
  });
  assert.equal(supportedHighRisk.score, 2);
  assert.equal(supportedHighRisk.threshold, 5);
  assert.equal(supportedHighRisk.hasSufficientEvidence, false);

  const validatedHighRisk = assessParetoEvidence({
    session: sessionWithObservations([]),
    turn: 1,
    taskClass: 'bugfix',
    risk: 'R3',
    validatedHypothesisCount: 1,
  });
  assert.equal(validatedHighRisk.hasSufficientEvidence, true);
  assert.equal(validatedHighRisk.hasEmpiricalEvidence, true);
});

test('ordinary file reads and code searches contribute one capped weak-evidence point', () => {
  const inspected = assessParetoEvidence({
    session: sessionWithObservations([
      { toolName: 'read_file', args: { path: 'src/auth.ts' }, result: { success: true, content: 'export {}' } },
      { toolName: 'search_codebase_fast', args: { query: 'auth' }, result: { success: true, results: ['src/auth.ts'] } },
    ]),
    turn: 1,
    risk: 'R3',
  });
  assert.equal(inspected.score, 1, 'multiple inspections remain weak evidence rather than stacking without limit');
  assert.ok(inspected.reasons.includes('WEAK_INSPECTION_EVIDENCE'));
});

test('blocked or unstarted tests are not empirical evidence; both executed test tools are', () => {
  const snapshot = (toolName: string, result: Record<string, any>) => assessParetoEvidence({
    session: sessionWithObservations([{ toolName, args: { command: 'npm test' }, result }]),
    turn: 1, taskClass: 'bugfix', risk: 'R2',
  });
  for (const result of [
    { success: true, commandOutcome: 'blocked_preflight', processStarted: false },
    { success: true, exitCode: 0, processStarted: false },
    { success: true },
    { errorCode: 'PERMISSION_DENIED' },
  ]) {
    assert.equal(snapshot('run_command', result).hasEmpiricalEvidence, false);
    assert.equal(snapshot('run_command', result).score, 0);
  }
  assert.equal(snapshot('run_command', { success: true, exitCode: 0 }).score, 3);
  assert.equal(snapshot('run_command', { success: false, exitCode: 1 }).hasFailureEvidence, true);
  assert.equal(snapshot('run_test_suite', { success: true, exitCode: 0, isPassed: true }).score, 3);
  assert.equal(snapshot('run_test_suite', { success: true, exitCode: 1, isPassed: false }).hasFailureEvidence, true);
  assert.equal(snapshot('run_test_suite', { errorCode: 'TEST_HARNESS_FAILURE' }).hasEmpiricalEvidence, false);
});

test('classification explores under uncertainty and acts when evidence reaches the threshold', () => {
  const engine = new ClassificationEngine();
  const base = {
    request: 'Fix the parser bug',
    hasPlan: true,
    evidenceScore: 1,
    evidenceThreshold: 3,
  };
  const uncertain = engine.classify(base);
  assert.equal(uncertain.phase, 'implement');
  assert.equal(uncertain.requiredCapabilities.includes('edit'), true);
  assert.equal(uncertain.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'), false);

  const largeUncertain = engine.classify({
    ...base,
    request: 'Fix the parser bug across the entire system architecture',
    hasPlan: false,
  });
  assert.equal(largeUncertain.risk, 'R3');
  assert.equal(largeUncertain.phase, 'plan');
  assert.equal(largeUncertain.requiredCapabilities.includes('edit'), false);
  assert.equal(largeUncertain.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'), false);

  const supported = engine.classify({
    ...base,
    hasDirectEvidence: true,
    evidenceScore: 3,
  });
  assert.equal(supported.phase, 'implement');
  assert.equal(supported.requiredCapabilities.includes('edit'), true);
  assert.equal(supported.reasonCodes.includes('PARETO_EVIDENCE_FAST_PATH'), true);

  const raisedRisk = engine.classify({
    ...base,
    hasDirectEvidence: true,
    evidenceScore: 5,
    evidenceThreshold: 5,
    minimumRisk: 'R3',
  });
  assert.equal(raisedRisk.risk, 'R3');
  assert.equal(raisedRisk.reasonCodes.includes('HYPOTHESIS_BLAST_RADIUS_RISK_FLOOR'), true);
});

test('guardian allows a small inspected edit but requires empirical evidence at high risk', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  const schema = {
    type: 'OBJECT',
    properties: {
      path: { type: 'STRING' },
      oldText: { type: 'STRING' },
      newText: { type: 'STRING' },
    },
  };

  guardian.setPreMutationGateContext({
    taskClass: 'bugfix',
    hasValidatedHypothesis: false,
    risk: 'R2',
    evidenceScore: 0,
    evidenceThreshold: 3,
    inspectedFiles: ['src/parser.ts'],
  });
  const fastPath = guardian.preCallValidate('replace_text', {
    path: 'src/parser.ts',
    oldText: 'return false;',
    newText: 'return true;',
  }, schema);
  assert.equal(fastPath.valid, true, 'small reversible edit on an inspected target should proceed');

  guardian.setPreMutationGateContext({
    taskClass: 'bugfix',
    hasValidatedHypothesis: false,
    risk: 'R3',
    evidenceScore: 5,
    evidenceThreshold: 5,
    inspectedFiles: ['src/parser.ts'],
    hasEmpiricalEvidence: false,
  });
  const highRiskBlocked = guardian.preCallValidate('write_file', {
    path: 'src/parser.ts',
    content: 'replacement',
  });
  assert.equal(highRiskBlocked.valid, false);
  assert.equal(highRiskBlocked.errorCode, 'UNVERIFIED_MUTATION_BLOCKED');
  assert.match(highRiskBlocked.error || '', /rủi ro cao/);

  guardian.setPreMutationGateContext({
    taskClass: 'bugfix',
    hasValidatedHypothesis: false,
    risk: 'R3',
    evidenceScore: 5,
    evidenceThreshold: 5,
    inspectedFiles: ['src/parser.ts'],
    hasEmpiricalEvidence: true,
  });
  const highRiskAllowed = guardian.preCallValidate('write_file', {
    path: 'src/parser.ts',
    content: 'replacement',
  });
  assert.equal(highRiskAllowed.valid, true);

  guardian.setPreMutationGateContext({
    taskClass: 'bugfix',
    hasValidatedHypothesis: true,
    validatedTargetFiles: ['src/parser.ts'],
    risk: 'R3',
    evidenceScore: 6,
    evidenceThreshold: 5,
    hasEmpiricalEvidence: true,
  });
  const unrelatedTarget = guardian.preCallValidate('write_file', {
    path: 'src/unrelated.ts',
    content: 'replacement',
  });
  assert.equal(unrelatedTarget.valid, false, 'empirical evidence for one target cannot authorize another file');
});

test('guardian allows an inspected R3 target with a plan, but keeps the same edit blocked without it', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  const args = { path: 'src/parser.ts', content: 'replacement' };
  const schema = { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } } };

  guardian.setPreMutationGateContext({
    taskClass: 'refactor', hasValidatedHypothesis: false, hasPlan: true, risk: 'R3',
    evidenceScore: 0, evidenceThreshold: 5, inspectedFiles: ['src/parser.ts'],
  });
  assert.equal(guardian.preCallValidate('write_file', args, schema).valid, true);

  guardian.setPreMutationGateContext({
    taskClass: 'refactor', hasValidatedHypothesis: false, hasPlan: false, risk: 'R3',
    evidenceScore: 0, evidenceThreshold: 5, inspectedFiles: ['src/parser.ts'],
  });
  assert.equal(guardian.preCallValidate('write_file', args, schema).errorCode, 'UNVERIFIED_MUTATION_BLOCKED');
});

test('patch evidence is checked for every parsed target, not the optional path', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  guardian.setPreMutationGateContext({
    taskClass: 'bugfix', hasValidatedHypothesis: false, risk: 'R2',
    evidenceScore: 1, evidenceThreshold: 3, inspectedFiles: ['src/parser.ts'],
  });
  const filePatch = (file: string) => `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-old\n+new`;
  assert.equal(guardian.preCallValidate('apply_patch', { patch: filePatch('src/parser.ts') }).valid, true);
  const mixed = guardian.preCallValidate('apply_patch', {
    path: 'src/parser.ts', patch: `${filePatch('src/parser.ts')}\n${filePatch('src/other.ts')}`,
  });
  assert.equal(mixed.errorCode, 'UNVERIFIED_MUTATION_BLOCKED');
  assert.match(mixed.error || '', /src\/other\.ts/);
  assert.equal(guardian.preCallValidate('apply_patch', {
    patch: `${filePatch('tests/parser.test.ts')}\n${filePatch('src/parser.ts')}`,
  }).valid, true);
  assert.equal(guardian.preCallValidate('apply_patch', {
    path: 'src/parser.ts', patch: '@@ -1,1 +1,1 @@\n-old\n+new',
  }).valid, true);
});

test('a plan alone cannot bypass R3 reproduction for bugfixes', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  guardian.setPreMutationGateContext({
    taskClass: 'bugfix', hasValidatedHypothesis: false, hasPlan: true, risk: 'R3',
    evidenceScore: 0, evidenceThreshold: 5, inspectedFiles: ['src/parser.ts'],
  });
  assert.equal(guardian.preCallValidate('write_file', {
    path: 'src/parser.ts', content: 'replacement',
  }).errorCode, 'UNVERIFIED_MUTATION_BLOCKED');
});

test('hypothesis tool distinguishes static support from empirical validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pareto-hypothesis-'));
  try {
    const workspace = new Workspace(root);
    const tracker = new HypothesisTracker();
    const tool = createHypothesisTool(tracker, workspace);
    const common = {
      statement: 'The parser rejects a documented delimiter.',
      falsificationTest: 'A focused input containing that delimiter is accepted.',
      targetFiles: ['src/parser.ts'],
      evidence: 'The branch returns false before normalization.',
      blastRadius: 'MEDIUM',
    };

    const staticResult = await tool.execute(common, workspace) as any;
    assert.equal(staticResult.success, true);
    assert.equal(staticResult.status, 'supported');
    assert.equal(tracker.getValidatedHypotheses().length, 0);
    assert.equal(tracker.getSupportedHypotheses().length, 1);

    const reproduced = await tool.execute({
      ...common,
      reproductionCommand: 'node -e "process.exit(1)"',
      expectedOutcome: 'fail',
    }, workspace) as any;
    assert.equal(reproduced.success, true);
    assert.equal(reproduced.status, 'validated');
    assert.equal(reproduced.reproductionResult.exitCode, 1);

    const passingCheck = await tool.execute({
      ...common,
      reproductionCommand: 'node -e "process.exit(0)"',
      expectedOutcome: 'pass',
    }, workspace) as any;
    assert.equal(passingCheck.success, true);
    assert.equal(passingCheck.status, 'validated');

    const mismatch = await tool.execute({
      ...common,
      reproductionCommand: 'node -e "process.exit(0)"',
      expectedOutcome: 'fail',
    }, workspace) as any;
    assert.equal(mismatch.success, false);
    assert.equal(mismatch.status, 'testing');
    assert.equal(mismatch.errorCode, 'REPRODUCTION_OUTCOME_MISMATCH');
    assert.equal(tracker.getFalsifiedHypotheses().length, 0, 'a bad reproduction command does not falsify causality');

    const commandFailure = await tool.execute({
      ...common,
      reproductionCommand: 'definitely_missing_minus_command_42',
      expectedOutcome: 'fail',
    }, workspace) as any;
    assert.equal(commandFailure.success, false);
    assert.equal(commandFailure.status, 'testing');
    assert.equal(commandFailure.errorCode, 'REPRODUCTION_EXECUTION_FAILED');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cognitive brake reacts to current repeated feedback, not old falsified hypotheses alone', () => {
  const harness = new CognitiveHarness();
  const historicalOnly = harness.evaluateCognitiveBrake({
    consecutiveFailures: 0,
    hypothesisFailedCount: 3,
    currentHypothesis: 'historical hypothesis',
  });
  assert.equal(historicalOnly.active, false);

  const repeatedFeedback = harness.evaluateCognitiveBrake({
    consecutiveFailures: 2,
    hypothesisFailedCount: 2,
    currentHypothesis: 'current weak hypothesis',
  });
  assert.equal(repeatedFeedback.active, true);
  assert.match(repeatedFeedback.recommendedPivot || '', /alternative/i);
});
