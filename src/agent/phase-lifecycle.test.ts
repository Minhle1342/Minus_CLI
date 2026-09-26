import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capability, ClassificationDecision } from '../control/classification-types.js';
import { Session } from '../session/session.js';
import {
  applyPhaseAuthority,
  applyPhaseLifecycle,
  getPhaseLifecycleState,
  invalidatePhaseOnMutation,
  recordExploreCompleted,
  recordImplementationCompleted,
  recordVerificationOutcome,
  requestPhaseTransition,
} from './phase-lifecycle.js';

const classification: ClassificationDecision = {
  id: 'class-test', version: 1, taskClass: 'bugfix', phase: 'implement',
  complexity: 'medium', externality: 'local', reversibility: 'reversible', risk: 'R2',
  requiredCapabilities: ['inspect', 'edit', 'execute', 'verify'], confidence: 0.9,
  fastPath: false, reasonCodes: [], createdAt: new Date().toISOString(),
};

function mutation(session: Session, id: string): void {
  session.append('tool/call', { turn: 1, step: 1, toolCallId: id, toolName: 'replace_text', args: { path: 'src/auth.ts' } });
  session.append('tool/result', { turn: 1, step: 1, toolCallId: id, toolName: 'replace_text', result: { success: true, path: 'src/auth.ts' } });
}

test('explicit lifecycle requires exploration evidence and records durable verified transitions', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  assert.equal(recordExploreCompleted(session, 1, classification, {
    score: 0, threshold: 3, inspectedFiles: [], sufficient: false, validatedHypothesis: false,
  }), false);
  assert.equal(recordExploreCompleted(session, 1, classification, {
    score: 3, threshold: 3, inspectedFiles: ['src/auth.ts'], sufficient: true, validatedHypothesis: false,
  }), true);
  assert.equal(recordExploreCompleted(session, 1, classification, {
    score: 3, threshold: 3, inspectedFiles: ['src/auth.ts'], sufficient: true, validatedHypothesis: false,
  }), false);
  mutation(session, 'edit-1');
  assert.equal(recordImplementationCompleted(session, 1, 'npm test'), true);
  assert.equal(applyPhaseLifecycle(classification, session, 1).phase, 'verify');
  assert.equal(recordVerificationOutcome(session, 1, 'npm test', true, false), false);
  assert.equal(recordVerificationOutcome(session, 1, 'npm test', true, true), true);
  assert.ok(getPhaseLifecycleState(session, 1).verificationCompleted);

  const restored = Session.fromSnapshot(session.toSnapshot());
  assert.ok(getPhaseLifecycleState(restored, 1).verificationCompleted);
  mutation(restored, 'edit-2');
  assert.equal(getPhaseLifecycleState(restored, 1).verificationCompleted, undefined);
  assert.equal(applyPhaseLifecycle(classification, restored, 1).phase, 'implement');
  assert.equal(invalidatePhaseOnMutation(restored, 1), true);
  assert.equal(restored.lastEvent?.type, 'phase/invalidated');
  assert.equal(recordImplementationCompleted(restored, 1, 'npm test'), true);
  assert.equal(recordVerificationOutcome(restored, 1, 'npm test', false, false), true);
  assert.equal(getPhaseLifecycleState(restored, 1).implementationCompleted, undefined);
  assert.equal(applyPhaseLifecycle(classification, restored, 1).phase, 'implement');
  restored.append('step/end', { turn: 1, step: 1 });
  restored.append('turn/end', { turn: 1 });
  assert.doesNotThrow(() => restored.assertRuntimeInvariants());
});

test('failed or unobserved mutation does not authorize implementation completion; turns are isolated', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('tool/call', { turn: 1, step: 1, toolCallId: 'failed', toolName: 'replace_text', args: { path: 'src/auth.ts' } });
  session.append('tool/result', { turn: 1, step: 1, toolCallId: 'failed', toolName: 'replace_text', result: { success: false } });
  assert.equal(recordImplementationCompleted(session, 1, 'npm test'), false);
  mutation(session, 'edit');
  recordImplementationCompleted(session, 1, 'npm test');
  assert.equal(getPhaseLifecycleState(session, 2).implementationCompleted, undefined);
});

test('Harness accepts only evidence-backed model phase requests and owns the durable phase', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  const explore = { ...classification, phase: 'explore' as const, requiredCapabilities: ['inspect', 'search', 'plan'] as Capability[] };

  const denied = requestPhaseTransition(session, 1, explore, {
    targetPhase: 'implement', rationale: 'The diagnosis is complete', evidenceRefs: [],
  }, { hasPlan: false, evidenceSufficient: false });
  assert.equal(denied.accepted, false);
  assert.equal(denied.errorCode, 'PHASE_TRANSITION_EVIDENCE_REQUIRED');

  const accepted = requestPhaseTransition(session, 1, explore, {
    targetPhase: 'implement', rationale: 'The inspected target and failing behavior identify the change', evidenceRefs: ['src/auth.ts:42', 'tool-result:read-1'],
  }, { hasPlan: false, evidenceSufficient: true });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.phaseVersion, 1);

  const authoritative = applyPhaseAuthority(explore, session, 1);
  assert.equal(authoritative.phase, 'implement');
  assert.equal(authoritative.phaseVersion, 1);
  assert.ok(authoritative.requiredCapabilities.includes('edit'));
  assert.deepEqual(session.getEvents().filter((event) => event.type.startsWith('phase/')).map((event) => event.type), [
    'phase/transitionRequested',
    'phase/transitionRejected',
    'phase/transitionRequested',
    'phase/transitionAccepted',
    'phase/exploreCompleted',
  ]);
});

test('a later classifier result cannot silently advance an initialized phase', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  session.append('control/decision', { turn: 1, controlDecision: { classification: { phase: 'explore' } } });
  const laterClassifierResult = { ...classification, phase: 'implement' as const };
  const authoritative = applyPhaseAuthority(laterClassifierResult, session, 1);
  assert.equal(authoritative.phase, 'explore');
  assert.equal(authoritative.requiredCapabilities.includes('edit'), false);
});

test('transitioning from R0 plan/explore to implement elevates risk floor to R1 and reversibility to reversible', () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  const r0Explore: ClassificationDecision = {
    ...classification,
    phase: 'explore',
    risk: 'R0',
    reversibility: 'read-only',
    requiredCapabilities: ['inspect', 'search', 'plan'],
  };
  session.append('control/decision', { turn: 1, controlDecision: { classification: r0Explore } });

  const accepted = requestPhaseTransition(session, 1, r0Explore, {
    targetPhase: 'implement',
    rationale: 'ready to create and edit files',
    evidenceRefs: ['index.html', 'tool-result:read-1'],
  }, { hasPlan: true, evidenceSufficient: true });
  assert.equal(accepted.accepted, true);

  const authoritative = applyPhaseAuthority(r0Explore, session, 1);
  assert.equal(authoritative.phase, 'implement');
  assert.equal(authoritative.risk, 'R1', 'risk floor must be elevated to at least R1 for implement');
  assert.equal(authoritative.reversibility, 'reversible', 'reversibility must be upgraded to reversible');
  assert.ok(authoritative.requiredCapabilities.includes('edit'));
});

