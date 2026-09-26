import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationPolicy } from './verification-policy.js';

test('VerificationPolicy blocks mutation in bugfix mode when reproduction proof is missing and gate is enforced', () => {
  const policy = new VerificationPolicy();

  // In observe mode, mutation is allowed
  const observeCheck = policy.canMutate('bugfix', 'observe');
  assert.equal(observeCheck.allowed, true);

  // In enforce mode without reproduction test, mutation is blocked
  const enforceCheck = policy.canMutate('bugfix', 'enforce');
  assert.equal(enforceCheck.allowed, false);
  assert.match(enforceCheck.reason || '', /REPRODUCTION_GATE_BLOCKED/);

  // After recording a failed test execution (reproduction proof established)
  policy.recordReproductionAttempt('npm test -- --filter=auth', true);
  assert.equal(policy.hasReproduction(), true);
  assert.equal(policy.getReproductionCommand(), 'npm test -- --filter=auth');

  // Now mutation is allowed in enforce mode
  const afterReproductionCheck = policy.canMutate('bugfix', 'enforce');
  assert.equal(afterReproductionCheck.allowed, true);

  // Non-bugfix tasks are always allowed
  assert.equal(policy.canMutate('feature', 'enforce').allowed, true);
});

test('VerificationPolicy allows scratch and test reproduction file mutations unconditionally', () => {
  const policy = new VerificationPolicy();

  // Scratch files are allowed even in enforce mode without reproduction proof
  const scratchCheck1 = policy.canMutate('bugfix', 'enforce', { targetFilePath: 'scratch/reproduce_auth.py' });
  assert.equal(scratchCheck1.allowed, true);

  const scratchCheck2 = policy.canMutate('bugfix', 'enforce', { targetFilePath: 'temp/repro_test.ts', isScratchFile: true });
  assert.equal(scratchCheck2.allowed, true);

  // Production files remain blocked without reproduction proof (unknown risk = conservative)
  const prodCheck = policy.canMutate('bugfix', 'enforce', { targetFilePath: 'src/auth/service.ts' });
  assert.equal(prodCheck.allowed, false);

  // Low/medium risk downgrades to advisory: allowed, with guidance attached
  const lowRiskCheck = policy.canMutate('bugfix', 'enforce', {
    targetFilePath: 'src/auth/service.ts',
    riskLevel: 'R2',
  });
  assert.equal(lowRiskCheck.allowed, true);
  assert.ok(lowRiskCheck.advisory?.includes('REPRODUCTION_GATE_ADVISORY'));

  // HIGH/CRITICAL stays enforced
  const highRiskCheck = policy.canMutate('bugfix', 'enforce', {
    targetFilePath: 'src/auth/service.ts',
    riskLevel: 'R4',
  });
  assert.equal(highRiskCheck.allowed, false);
  assert.match(highRiskCheck.reason || '', /REPRODUCTION_GATE_BLOCKED/);

  // But allowed if criticApproved is true
  const criticApprovedCheck = policy.canMutate('bugfix', 'enforce', {
    targetFilePath: 'src/auth/service.ts',
    criticApproved: true,
  });
  assert.equal(criticApprovedCheck.allowed, true);
});

test('VerificationPolicy reset clears reproduction proof', () => {
  const policy = new VerificationPolicy();
  policy.recordReproductionAttempt('pytest tests/test_bug.py', true);
  assert.equal(policy.hasReproduction(), true);

  policy.reset();
  assert.equal(policy.hasReproduction(), false);
  assert.equal(policy.getReproductionCommand(), undefined);
});

test('Repair budget counts only same-signature repeats, resets on novelty', () => {
  const policy = new VerificationPolicy();
  assert.equal(policy.isRepairExhausted(), false);
  policy.recordRepairAttempt(1);
  assert.equal(policy.isRepairExhausted(), false);
  policy.recordRepairAttempt(2);
  assert.equal(policy.isRepairExhausted(), false);
  assert.equal(policy.getRepairCycles(), 2);
  // Novel failure signature resets the budget instead of consuming it
  policy.recordRepairAttempt(1);
  assert.equal(policy.isRepairExhausted(), false);
  assert.equal(policy.getRepairCycles(), 0);
  // Third consecutive identical failure exhausts the budget (LATS backtracking)
  policy.recordRepairAttempt(2);
  policy.recordRepairAttempt(3);
  assert.equal(policy.isRepairExhausted(), true);
});
