import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerificationPolicy } from '../skills/verification-policy.js';
import { SolutionGroundingAuditor } from './solution-grounding-auditor.js';
import { CriticGate } from './critic-gate.js';
import { Session } from '../session/session.js';

function record(session: Session, turn: number, toolName: string, args: Record<string, any>, result: Record<string, any>): void {
  const toolCallId = `call-${session.getEvents().length}`;
  session.append('tool/call', { turn, step: 1, toolCallId, toolName, args });
  session.append('tool/result', { turn, step: 1, toolCallId, toolName, result });
}

test('policy upgrades measured HIGH edits to full_test', () => {
  const policy = new VerificationPolicy();
  policy.setRequiredRisk('R2');
  policy.recordModification('src/a.ts');
  policy.recordModification('src/b.ts');
  policy.recordModification('src/c.ts');
  policy.recordVerification('get_diagnostics', true, undefined, 0);
  const blocked = policy.canComplete();
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.errorCode, 'VERIFICATION_TIER_REQUIRED');
  policy.recordVerification('npm test', true, undefined, 0);
  assert.equal(policy.canComplete().allowed, true);
});

test('policy escalates a single sensitive-path edit to CRITICAL', () => {
  const policy = new VerificationPolicy();
  policy.setRequiredRisk('R0');
  policy.recordModification('src/auth/session.ts');
  policy.recordVerification('get_diagnostics', true, undefined, 0);
  assert.equal(policy.canComplete().allowed, false);
  policy.recordVerification('npm test', true, undefined, 0);
  assert.equal(policy.canComplete().allowed, true);
});

test('auditor rejects weak verification methods for HIGH file counts', () => {
  const denied = SolutionGroundingAuditor.audit({
    summary: 'Fixed the login flow across three modules and updated handlers.',
    filesModified: ['a.ts', 'b.ts', 'c.ts'],
    verificationMethod: 'diff_visual_inspection',
    resolutionType: 'code_fix',
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.errorCode, 'VERIFICATION_TIER_MISMATCH');

  const allowed = SolutionGroundingAuditor.audit({
    summary: 'Fixed the login flow across three modules and updated handlers.',
    filesModified: ['a.ts', 'b.ts', 'c.ts'],
    verificationMethod: 'automated_test_pass',
    verificationEvidence: 'npm test',
    resolutionType: 'code_fix',
  });
  assert.equal(allowed.allowed, true);

  const investigation = SolutionGroundingAuditor.audit({
    summary: 'Investigated the outage and documented findings in detail below.',
    filesModified: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    verificationMethod: 'not_applicable',
    resolutionType: 'investigation_only',
  });
  assert.equal(investigation.allowed, true);
});

test('critic penalizes HIGH-impact changes without a passing test', () => {
  const session = new Session();
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['a.ts'] });
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['b.ts'] });
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['c.ts'] });
  const critic = new CriticGate();
  const decision = critic.evaluate({
    finalAnswer: 'Fixed all three modules.',
    session,
    workspace: {} as any,
    userRequest: 'Fix things',
    turn: 1,
    risk: 'R2',
  });
  assert.ok(decision.reasons.some((reason) => reason.includes('MEASURED HIGH-IMPACT')), decision.reasons.join('\n'));
});

test('critic clears the measured penalty after a passing test', () => {
  const session = new Session();
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['a.ts'] });
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['b.ts'] });
  record(session, 1, 'apply_patch', {}, { success: true, filesModified: ['c.ts'] });
  record(session, 1, 'run_command', { command: 'npm test' }, { exitCode: 0, stdout: '3 passed', stderr: '' });
  const critic = new CriticGate();
  const decision = critic.evaluate({
    finalAnswer: 'Fixed all three modules and verified with npm test: 3 passed.',
    session,
    workspace: {} as any,
    userRequest: 'Fix things',
    turn: 1,
    risk: 'R2',
  });
  assert.ok(!decision.reasons.some((reason) => reason.includes('MEASURED HIGH-IMPACT')), decision.reasons.join('\n'));
});
