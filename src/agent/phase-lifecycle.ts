import type { ClassificationDecision } from '../control/classification-types.js';
import type { Session, SessionEvent } from '../session/session.js';
import { getTurnCompletionState } from './completion-observations.js';

export interface PhaseLifecycleState {
  exploreCompleted?: SessionEvent;
  implementationCompleted?: SessionEvent;
  verificationCompleted?: SessionEvent;
}

/** Project durable transitions for a single turn; evidence from an earlier mutation is never reusable. */
export function getPhaseLifecycleState(session: Session, turn: number): PhaseLifecycleState {
  const latestMutationSeq = getTurnCompletionState(session, turn).latestMutationSeq;
  const state: PhaseLifecycleState = {};
  for (const event of session.getEvents()) {
    if (event.data.turn !== turn) continue;
    if (event.type === 'phase/exploreCompleted') state.exploreCompleted = event;
    if (event.type === 'phase/invalidated' || event.type === 'phase/verificationFailed') {
      state.implementationCompleted = undefined;
      state.verificationCompleted = undefined;
    }
    if (event.type === 'phase/implementationCompleted') {
      state.implementationCompleted = event;
      state.verificationCompleted = undefined;
    }
    if (event.type === 'phase/verificationCompleted') state.verificationCompleted = event;
  }
  if (state.implementationCompleted?.data.phaseTransition?.mutationSeq !== latestMutationSeq) {
    state.implementationCompleted = undefined;
    state.verificationCompleted = undefined;
  } else if (state.verificationCompleted?.data.phaseTransition?.mutationSeq !== latestMutationSeq) {
    state.verificationCompleted = undefined;
  }
  return state;
}

/** An explicit completion is admitted only after the classifier's evidence gate has passed. */
export function recordExploreCompleted(
  session: Session,
  turn: number,
  classification: ClassificationDecision,
  evidence: { score: number; threshold: number; inspectedFiles: string[]; sufficient: boolean; validatedHypothesis: boolean; hypothesisId?: string },
): boolean {
  if (classification.phase !== 'implement' || getPhaseLifecycleState(session, turn).exploreCompleted) return false;
  const needsEvidence = classification.taskClass === 'bugfix' || classification.taskClass === 'refactor';
  if (needsEvidence && !evidence.sufficient && !evidence.validatedHypothesis && evidence.inspectedFiles.length === 0) return false;
  session.append('phase/exploreCompleted', {
    turn,
    phaseTransition: {
      classificationId: classification.id,
      ...(needsEvidence && evidence.hypothesisId ? { hypothesisId: evidence.hypothesisId } : {}),
      evidenceScore: evidence.score,
      evidenceThreshold: evidence.threshold,
      inspectedFiles: evidence.inspectedFiles,
      reason: needsEvidence ? 'evidence-admitted' : 'direct-mutation-intent',
    },
  });
  return true;
}

/** Verification of observed changes is the authoritative implement -> verify boundary. */
export function recordImplementationCompleted(
  session: Session,
  turn: number,
  command: string,
): boolean {
  const mutation = getTurnCompletionState(session, turn);
  if (!mutation.hasMutations || getPhaseLifecycleState(session, turn).implementationCompleted) return false;
  session.append('phase/implementationCompleted', {
    turn,
    phaseTransition: {
      mutationSeq: mutation.latestMutationSeq,
      filesModified: mutation.filesModified,
      verificationCommand: command,
      reason: 'verification-started-after-observed-mutation',
    },
  });
  return true;
}

export function recordVerificationOutcome(
  session: Session,
  turn: number,
  command: string,
  success: boolean,
  sufficient: boolean,
): boolean {
  const mutation = getTurnCompletionState(session, turn);
  if (!mutation.hasMutations) return false;
  if (!success) {
    session.append('phase/verificationFailed', {
      turn,
      phaseTransition: { mutationSeq: mutation.latestMutationSeq, verificationCommand: command, reason: 'verification-failed' },
    });
    return true;
  }
  if (!sufficient || !getPhaseLifecycleState(session, turn).implementationCompleted
    || getPhaseLifecycleState(session, turn).verificationCompleted) return false;
  session.append('phase/verificationCompleted', {
    turn,
    phaseTransition: {
      mutationSeq: mutation.latestMutationSeq,
      filesModified: mutation.filesModified,
      verificationCommand: command,
      reason: 'verification-policy-passed',
    },
  });
  return true;
}

export function invalidatePhaseOnMutation(session: Session, turn: number): boolean {
  const mutation = getTurnCompletionState(session, turn);
  const latestBoundary = session.getEvents().reverse().find((event) => event.data.turn === turn
    && ['phase/implementationCompleted', 'phase/verificationCompleted', 'phase/invalidated'].includes(event.type));
  if (!latestBoundary || latestBoundary.type === 'phase/invalidated'
    || latestBoundary.data.phaseTransition?.mutationSeq === mutation.latestMutationSeq) return false;
  session.append('phase/invalidated', {
    turn,
    phaseTransition: { mutationSeq: mutation.latestMutationSeq, filesModified: mutation.filesModified, reason: 'new-observed-mutation' },
  });
  return true;
}

/** Keep edit tools available after a failed check; expose completion tools after verification starts. */
export function applyPhaseLifecycle(
  classification: ClassificationDecision,
  session: Session,
  turn: number,
): ClassificationDecision {
  const state = getPhaseLifecycleState(session, turn);
  if (!state.implementationCompleted || classification.phase !== 'implement') return classification;
  return {
    ...classification,
    phase: 'verify',
    requiredCapabilities: [...new Set([...classification.requiredCapabilities, 'verify' as const, 'complete' as const])],
    reasonCodes: [...classification.reasonCodes, 'IMPLEMENTATION_COMPLETED_EVENT'],
  };
}
