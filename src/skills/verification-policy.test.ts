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

test('VerificationPolicy reset clears reproduction proof', () => {
  const policy = new VerificationPolicy();
  policy.recordReproductionAttempt('pytest tests/test_bug.py', true);
  assert.equal(policy.hasReproduction(), true);

  policy.reset();
  assert.equal(policy.hasReproduction(), false);
  assert.equal(policy.getReproductionCommand(), undefined);
});
