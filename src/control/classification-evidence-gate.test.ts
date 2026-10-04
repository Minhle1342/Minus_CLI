import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassificationEngine } from './classification-engine.js';

test('R2 bugfix skips the evidence gate and goes straight to implement', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({ request: 'Fix null pointer bug in auth.ts' });
  assert.equal(decision.taskClass, 'bugfix');
  assert.equal(decision.phase, 'implement');
  assert.ok(!decision.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'));
});

test('R3 work without an explicit planning request goes to implement', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({ request: 'Refactor the authentication system architecture across all modules' });
  assert.equal(decision.taskClass, 'refactor');
  assert.equal(decision.risk, 'R3');
  assert.equal(decision.phase, 'implement');
  assert.ok(!decision.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'));
});

test('an explicit planning request enters plan phase', () => {
  const decision = new ClassificationEngine().classify({
    request: '[PLANNING MODE REQUEST]: Create a plan to refactor the authentication system architecture.',
  });
  assert.equal(decision.phase, 'plan');
  assert.ok(decision.requiredCapabilities.includes('plan'));
  assert.ok(decision.reasonCodes.includes('EXPLICIT_PLANNING_INTENT'));
});

test('a planning-only request enters plan phase without mutation language', () => {
  const decision = new ClassificationEngine().classify({ request: 'Make a plan for investigating the authentication flow.' });
  assert.equal(decision.phase, 'plan');
  assert.equal(decision.taskClass, 'feature');
});

test('R3 large refactor fast-paths to implement with an accepted plan', () => {
  const decision = new ClassificationEngine().classify({
    request: 'Refactor the authentication system architecture across all modules',
    hasPlan: true,
  });
  assert.equal(decision.risk, 'R3');
  assert.equal(decision.phase, 'implement');
});

test('R4 bugfix still requires evidence before implementation', () => {
  const decision = new ClassificationEngine().classify({
    request: 'Refactor the authentication system architecture across all modules',
    minimumRisk: 'R4',
  });
  assert.equal(decision.risk, 'R4');
  assert.equal(decision.phase, 'explore');
  assert.ok(decision.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'));
});

test('R3 bugfix with validated hypothesis takes the fast path', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({
    request: 'Refactor the authentication system architecture across all modules',
    hasValidatedHypothesis: true,
  });
  assert.equal(decision.phase, 'implement');
  assert.ok(decision.reasonCodes.includes('PARETO_EVIDENCE_FAST_PATH'));
});

test('ordinary R2 feature work is unaffected', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({ request: 'Add a login button to the header' });
  assert.equal(decision.taskClass, 'feature');
  assert.equal(decision.phase, 'implement');
});
