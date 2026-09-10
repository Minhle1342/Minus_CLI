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
    hasPlan: true,
  });
  assert.equal(planned.score, 1);
  assert.equal(planned.hasSufficientEvidence, false, 'a plan is context, not causal proof');

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
    hasPlan: true,
    supportedHypothesisCount: 1,
  });
  assert.equal(supportedHighRisk.score, 3);
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

test('classification explores under uncertainty and acts when evidence reaches the threshold', () => {
  const engine = new ClassificationEngine();
  const base = {
    request: 'Fix the parser bug',
    hasPlan: true,
    evidenceScore: 1,
    evidenceThreshold: 3,
  };
  const uncertain = engine.classify(base);
  assert.equal(uncertain.phase, 'explore');
  assert.equal(uncertain.requiredCapabilities.includes('edit'), false);
  assert.equal(uncertain.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'), true);

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
