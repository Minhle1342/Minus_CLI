import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClassificationDecision } from '../control/classification-types.js';
import { Session } from '../session/session.js';
import { requestPhaseTransition } from './phase-lifecycle.js';

const largeTask: ClassificationDecision = {
  id: 'large-feature',
  version: 1,
  taskClass: 'feature',
  phase: 'explore',
  complexity: 'large',
  risk: 'R3',
  externality: 'local',
  reversibility: 'reversible',
  requiredCapabilities: ['inspect', 'search', 'plan'],
  confidence: 1,
  fastPath: false,
  reasonCodes: [],
  createdAt: new Date().toISOString(),
};

test('large work can transition from explore to implement without a plan', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  const transition = requestPhaseTransition(session, 1, largeTask, {
    targetPhase: 'implement',
    rationale: 'Inspected the relevant implementation and identified the required changes.',
    evidenceRefs: ['src/auth.ts:42'],
  }, { hasPlan: false, evidenceSufficient: true });

  assert.equal(transition.accepted, true);
  assert.equal(transition.phase, 'implement');
});

test('explicit plan phase can transition to implement without a persisted DAG', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('control/decision', {
    turn: 1,
    controlDecision: { classification: { phase: 'plan' } },
  });
  const transition = requestPhaseTransition(session, 1, { ...largeTask, phase: 'plan' }, {
    targetPhase: 'implement',
    rationale: 'Planning review is complete and implementation can begin.',
    evidenceRefs: ['src/auth.ts:42'],
  }, { hasPlan: false, evidenceSufficient: true });

  assert.equal(transition.accepted, true);
  assert.equal(transition.phase, 'implement');
});
