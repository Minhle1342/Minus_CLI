import type { ClassificationDecision, Capability, TaskPhase } from '../control/classification-types.js';
import type { Session, SessionEvent } from '../session/session.js';
import { getTurnCompletionState } from './completion-observations.js';

export interface PhaseLifecycleState {
  exploreCompleted?: SessionEvent;
  implementationCompleted?: SessionEvent;
  verificationCompleted?: SessionEvent;
}

export interface PhaseAuthorityState {
  phase: TaskPhase;
  version: number;
}

export interface PhaseTransitionRequest {
  targetPhase: TaskPhase;
  rationale: string;
  evidenceRefs: string[];
}

export interface PhaseTransitionDecision {
  accepted: boolean;
  phase: TaskPhase;
  phaseVersion: number;
  errorCode?: string;
  reason: string;
}

const CODING_TASKS = new Set(['bugfix', 'feature', 'refactor', 'question', 'exploration']);

/** Produce actionable, model-facing recovery guidance for a rejected request. */
export function getPhaseTransitionRecoveryGuidance(errorCode: string | undefined, reason: string): string {
  switch (errorCode) {
    case 'INVALID_ARGS':
      return 'Reissue request_phase_transition with targetPhase "plan" or "implement", a non-empty rationale, and at least one string evidenceRefs entry naming an observed file, symbol, tool result, test output, or plan task.';
    case 'PHASE_TRANSITION_EVIDENCE_REQUIRED':
      return 'Inspect the relevant target or tool output first, then reissue request_phase_transition with a concrete rationale and at least one real evidenceRefs reference.';
    case 'PHASE_TRANSITION_NOT_APPLICABLE':
      return 'Do not request a workflow phase transition for this task class. Continue with the tools authorized for the current task instead.';
    case 'PLAN_REQUIRED':
      return 'Create and validate an execution plan before requesting the implement phase again.';
    case 'EXPLORATION_EVIDENCE_REQUIRED':
      return 'Gather fresh inspection or validated-hypothesis evidence for the exact target, then request implementation again.';
    case 'INVALID_PHASE_TRANSITION':
      return 'Check the current Harness-owned phase and request only a legal next transition: explore → plan, explore → implement, or plan → implement.';
    case 'PHASE_TRANSITION_REQUIRES_FRESH_MODEL_TURN':
      return 'Wait for the Harness to return the refreshed phase and tool set, then make the next tool call in a new model response.';
    default:
      return `Review the rejection reason, gather any missing evidence, and do not repeat the same request unchanged. Rejection: ${reason}`;
  }
}

function capabilitiesForPhase(classification: ClassificationDecision, phase: TaskPhase): Capability[] {
  const base: Capability[] = ['inspect', 'search', 'memory'];
  if (phase === 'explore') return base;
  if (phase === 'plan') return [...base, 'plan'];
  if (phase === 'implement') return [...base, 'plan', 'edit', 'execute', 'verify', 'git-read', 'complete'];
  if (phase === 'verify') return [...base, 'plan', 'edit', 'execute', 'verify', 'git-read', 'complete'];
  return classification.requiredCapabilities;
}

/** Resolve the durable Harness-owned phase before building an allowlist. */
export function getPhaseAuthorityState(
  session: Session,
  turn: number,
  fallback: TaskPhase,
): PhaseAuthorityState {
  let phase = fallback;
  let version = 0;
  const initialized = session.getEvents().find((event) => {
    const candidate = event.data.controlDecision?.classification?.phase;
    return event.data.turn === turn
      && event.type === 'control/decision'
      && (candidate === 'explore' || candidate === 'plan' || candidate === 'implement' || candidate === 'verify' || candidate === 'release');
  })?.data.controlDecision?.classification?.phase as TaskPhase | undefined;
  // Classification chooses only the initial phase. Once a turn has started,
  // this durable Harness observation prevents fresh evidence from silently
  // expanding the model's authority.
  if (initialized) phase = initialized;
  for (const event of session.getEvents()) {
    if (event.data.turn !== turn || event.type !== 'phase/transitionAccepted') continue;
    const target = event.data.phaseTransition?.targetPhase;
    if (target === 'explore' || target === 'plan' || target === 'implement' || target === 'verify' || target === 'release') {
      phase = target;
      version = Math.max(version, event.data.phaseTransition?.phaseVersion || version + 1);
    }
  }

  const lifecycle = getPhaseLifecycleState(session, turn);
  if (lifecycle.implementationCompleted) phase = 'verify';
  if (session.getEvents().some((event) => event.data.turn === turn && event.type === 'phase/verificationFailed')) phase = 'implement';
  return { phase, version };
}

/** Apply durable authority without letting a fresh classifier silently change phase. */
export function applyPhaseAuthority(
  classification: ClassificationDecision,
  session: Session,
  turn: number,
): ClassificationDecision & { phaseVersion: number } {
  const authority = getPhaseAuthorityState(session, turn, classification.phase);
  const effectiveRisk = (authority.phase === 'implement' || authority.phase === 'verify') && classification.risk === 'R0'
    ? 'R1'
    : classification.risk;
  const effectiveReversibility = (authority.phase === 'implement' || authority.phase === 'verify') && classification.reversibility === 'read-only'
    ? 'reversible'
    : classification.reversibility;

  if (authority.phase === classification.phase) {
    return {
      ...classification,
      risk: effectiveRisk,
      reversibility: effectiveReversibility,
      phaseVersion: authority.version,
    };
  }
  return {
    ...classification,
    phase: authority.phase,
    risk: effectiveRisk,
    reversibility: effectiveReversibility,
    requiredCapabilities: capabilitiesForPhase(classification, authority.phase),
    reasonCodes: [...(classification.reasonCodes || []), 'HARNESS_PHASE_AUTHORITY'],
    phaseVersion: authority.version,
  };
}

/** Evaluate and durably record a model request. Only this function admits a phase change. */
export function requestPhaseTransition(
  session: Session,
  turn: number,
  classification: ClassificationDecision,
  request: Partial<PhaseTransitionRequest>,
  options: { hasPlan: boolean; evidenceSufficient: boolean },
): PhaseTransitionDecision {
  const current = getPhaseAuthorityState(session, turn, classification.phase);
  const targetPhase = request.targetPhase;
  const rationale = String(request.rationale || '').trim();
  const evidenceRefs = Array.isArray(request.evidenceRefs)
    ? request.evidenceRefs.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const reject = (errorCode: string, reason: string): PhaseTransitionDecision => {
    session.append('phase/transitionRejected', {
      turn,
      phaseTransition: { fromPhase: current.phase, targetPhase, phaseVersion: current.version, evidenceRefs, reason },
    });
    return { accepted: false, phase: current.phase, phaseVersion: current.version, errorCode, reason };
  };

  session.append('phase/transitionRequested', {
    turn,
    phaseTransition: { fromPhase: current.phase, targetPhase, phaseVersion: current.version, evidenceRefs, reason: rationale || 'missing rationale' },
  });
  if (!rationale || evidenceRefs.length === 0) return reject('PHASE_TRANSITION_EVIDENCE_REQUIRED', 'A rationale and at least one evidence reference are required.');
  if (!CODING_TASKS.has(classification.taskClass)) return reject('PHASE_TRANSITION_NOT_APPLICABLE', 'Only coding tasks can request a phase transition.');
  if (current.phase === 'explore' && targetPhase === 'plan') {
    // Planning is a non-mutating continuation, so evidence references establish auditability rather than proof of a fix.
  } else if (current.phase === 'explore' && targetPhase === 'implement') {
    if (!options.evidenceSufficient) return reject('EXPLORATION_EVIDENCE_REQUIRED', 'Observed inspection or validated-hypothesis evidence is required before implementation.');
  } else if (current.phase === 'plan' && targetPhase === 'implement') {
    // Planning is opt-in. An explicit /plan request may create a plan, but an
    // absent plan must not block an evidence-backed implementation transition.
  } else {
    return reject('INVALID_PHASE_TRANSITION', `The Harness does not allow ${current.phase} -> ${String(targetPhase)} from a model request.`);
  }

  const phaseVersion = current.version + 1;
  session.append('phase/transitionAccepted', {
    turn,
    phaseTransition: { fromPhase: current.phase, targetPhase, phaseVersion, evidenceRefs, reason: rationale },
  });
  if (current.phase === 'explore' && targetPhase === 'implement') {
    session.append('phase/exploreCompleted', {
      turn,
      phaseTransition: {
        classificationId: classification.id,
        evidenceRefs,
        evidenceScore: options.evidenceSufficient ? 1 : 0,
        evidenceThreshold: 1,
        inspectedFiles: evidenceRefs,
        reason: 'phase-transition-request-accepted',
      },
    });
  }
  return { accepted: true, phase: targetPhase, phaseVersion, reason: 'Harness accepted the evidence-backed phase transition.' };
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
