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

test('R3 bugfix without evidence stays in explore with the gate reason', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({ request: 'Refactor the authentication system architecture across all modules' });
  assert.equal(decision.taskClass, 'refactor');
  assert.equal(decision.risk, 'R3');
  assert.equal(decision.phase, 'explore');
  assert.ok(decision.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE'));
});

test('R3 bugfix with validated hypothesis takes the fast path', () => {
  const engine = new ClassificationEngine();
  const decision = engine.classify({
    request: 'Refactor the authentication system architecture across all modules',
    hasValidatedHypothesis: true,
    hasPlan: true,
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
