import type { TaskPhase } from '../control/classification-types.js';
import type { Session } from '../session/session.js';
import type { Hypothesis } from './hypothesis-tracker.js';
import { getPhaseLifecycleState } from './phase-lifecycle.js';

export interface PhaseContextHandoff {
  sourceEventSeq: number;
  text: string;
}

function concise(value: unknown, limit = 160): string {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** A bounded, evidence-only handoff. Phase events stay in the durable log; this is a request-time projection. */
export function buildPhaseContextHandoff(
  session: Session,
  turn: number,
  phase: TaskPhase,
  hypothesis?: Hypothesis,
  pendingTests: string[] = [],
): PhaseContextHandoff | undefined {
  const state = getPhaseLifecycleState(session, turn);
  if (phase === 'implement' && state.exploreCompleted) {
    const event = state.exploreCompleted;
    const evidence = event.data.phaseTransition;
    if (!evidence) return undefined;
    const inspected = (evidence.inspectedFiles || []).slice(0, 5).map((file) => concise(file, 100));
    const supported = hypothesis && evidence.hypothesisId === hypothesis.id
      && ['supported', 'validated'].includes(hypothesis.status) ? hypothesis : undefined;
    return {
      sourceEventSeq: event.seq,
      text: [
        `[PHASE HANDOFF: explore → implement; session event #${event.seq}; evidence only]`,
        `Entry: ${evidence.reason === 'direct-mutation-intent' ? 'direct change request (no root cause asserted)' : 'exploration evidence accepted'}.`,
        inspected.length ? `Inspected: ${inspected.join(', ')}.` : '',
        supported ? `Supported hypothesis (${concise(supported.id, 24)}): ${concise(supported.statement, 180)}.` : '',
        supported?.proposedFix ? `Proposed change: ${concise(supported.proposedFix, 150)}.` : '',
        supported?.falsificationTest ? `Falsification test: ${concise(supported.falsificationTest, 120)}.` : '',
        !supported && evidence.reason !== 'direct-mutation-intent'
          ? 'No supported causal hypothesis is recorded in this phase event.' : '',
      ].filter(Boolean).join('\n'),
    };
  }
  if (phase === 'verify' && state.implementationCompleted) {
    const event = state.implementationCompleted;
    const evidence = event.data.phaseTransition;
    if (!evidence) return undefined;
    const verified = state.verificationCompleted?.data.phaseTransition;
    const files = (evidence.filesModified || []).slice(0, 5).map((file) => concise(file, 100));
    return {
      sourceEventSeq: event.seq,
      text: [
        `[PHASE HANDOFF: implement → verify; session event #${event.seq}; evidence only]`,
        `Observed mutation #${evidence.mutationSeq}. Files: ${files.join(', ') || 'not identified'}.`,
        verified ? `Verification passed: ${concise(verified.verificationCommand, 120)}.`
          : `Verification still required; last command: ${concise(evidence.verificationCommand, 120)}.`,
        pendingTests.length ? `Pending impacted tests: ${pendingTests.slice(0, 3).map((test) => concise(test, 100)).join(', ')}.` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  return undefined;
}
