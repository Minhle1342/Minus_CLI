import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassificationEngine } from './classification-engine.js';

test('prose alone defers to the model instead of inspecting words', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({ request: 'Fix null pointer bug in auth.ts' });
  assert.equal(decision.phase, 'implement');
  assert.ok(decision.requiredCapabilities.includes('edit'));
  assert.ok(decision.reasonCodes.includes('MODEL_DIRECTED_DEFAULT'));
});

test('a risk floor raises risk without inferring a task class', () => {
  const decision = new ClassificationEngine().classify({
    request: 'Refactor the authentication system architecture across all modules',
    minimumRisk: 'R3',
  });
  assert.equal(decision.risk, 'R3');
  assert.equal(decision.phase, 'implement');
  assert.ok(decision.reasonCodes.includes('HYPOTHESIS_BLAST_RADIUS_RISK_FLOOR'));
});

test('an explicit planning directive enters plan phase', () => {
  const decision = new ClassificationEngine().classify({
    request: '[PLANNING MODE REQUEST]: Create a plan to refactor the authentication system architecture.',
  });
  assert.equal(decision.phase, 'plan');
  assert.ok(decision.requiredCapabilities.includes('plan'));
  assert.ok(decision.reasonCodes.includes('EXPLICIT_PLANNING_INTENT'));
});

test('/plan enters plan phase', () => {
  const decision = new ClassificationEngine().classify({ request: '/plan migrate the auth module' });
  assert.equal(decision.phase, 'plan');
  assert.equal(decision.requiredCapabilities.includes('edit'), false);
});

test('an explicit read-only directive keeps the turn read-only', () => {
  const decision = new ClassificationEngine().classify({ request: 'read-only: explain the auth flow' });
  assert.equal(decision.phase, 'explore');
  assert.equal(decision.risk, 'R0');
  assert.equal(decision.requiredCapabilities.includes('edit'), false);
  assert.ok(decision.reasonCodes.includes('READ_ONLY_EXPLANATION_OR_PROPOSAL'));
});

test('an observed implement phase is sticky across steps', () => {
  const engine = new ClassificationEngine();
  const neutral = engine.classify({ request: 'Fix null pointer bug in auth.ts' });
  const decision = engine.classify({ request: 'Fix null pointer bug in auth.ts', previous: neutral });
  assert.equal(decision.phase, 'implement');
  assert.ok(decision.requiredCapabilities.includes('edit'));
  assert.ok(decision.reasonCodes.includes('OBSERVED_PHASE_CONTINUATION'));
});

test('pending mutations force the verify phase', () => {
  const decision = new ClassificationEngine().classify({ request: 'Continue', hasUnverifiedChanges: true });
  assert.equal(decision.phase, 'verify');
  assert.ok(decision.requiredCapabilities.includes('edit'));
  assert.ok(decision.reasonCodes.includes('UNVERIFIED_MUTATION_EXISTS'));
});
