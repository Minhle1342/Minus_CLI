import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Session } from '../session/session.js';
import type { VerificationPolicy } from '../skills/verification-policy.js';
import type { ClassificationDecision } from '../control/classification-types.js';
import { collectCompletionObservations, getTurnCompletionState } from './completion-observations.js';
import { classifyToolEvidence, CompletionEvidenceGate, extractCommandString, isUserExplicitlyExemptingTests } from './completion-evidence.js';
import { SolutionGroundingAuditor, type SubmitSolutionPayload } from './solution-grounding-auditor.js';

/** Fill only omitted metadata, never rewrite the answer or an explicit claim. */
export function withObservedSubmissionMetadata<T extends SubmitSolutionPayload>(payload: T, session?: Session, turn?: number): T & SubmitSolutionPayload {
  if (!session) return payload;
  const state = getTurnCompletionState(session, turn);
  const verification = collectCompletionObservations(session, turn).filter(item =>
    item.result.seq > state.latestMutationSeq && classifyToolEvidence(item.toolName, item.args, item.payload).includes('verification')).at(-1);
  const command = verification ? extractCommandString(verification.args, verification.payload)
    || verification.payload.commandCompletion?.command || verification.toolName : undefined;
  return {
    ...payload,
    filesModified: payload.filesModified ?? state.filesModified,
    resolutionType: payload.resolutionType ?? (state.hasMutations ? 'other' : 'investigation_only'),
    verificationEvidence: payload.verificationEvidence ?? command,
    verificationMethod: payload.verificationMethod ?? (verification
      ? verification.toolName === 'get_diagnostics' ? 'static_diagnostics_clean' : 'direct_validation'
      : state.hasMutations ? undefined : 'not_applicable'),
  };
}

export interface SubmissionCheckContext {
  session: Session;
  turn: number;
  userRequest: string;
  workspaceRoot: string;
  codeChangeRequired: boolean;
  taskClass?: ClassificationDecision['taskClass'];
  verificationPolicy: VerificationPolicy;
  evidenceGate: CompletionEvidenceGate;
  evidenceEnabled: boolean;
  measured?: Parameters<VerificationPolicy['canComplete']>[1];
}

/** Same deterministic checks for a candidate draft and a real submission. */
export function evaluateSubmission(payload: SubmitSolutionPayload, context: SubmissionCheckContext) {
  const normalized = withObservedSubmissionMetadata(payload, context.session, context.turn);
  const evidence = context.evidenceEnabled ? context.evidenceGate.evaluate(normalized.summary, context.session, {
    turn: context.turn, userRequest: context.userRequest, codeChangeRequired: context.codeChangeRequired,
    taskClass: context.taskClass, resolutionType: normalized.resolutionType,
  }) : undefined;
  const verification = context.verificationPolicy.canComplete([], context.measured, {
    userExemptsTesting: isUserExplicitlyExemptingTests(context.userRequest),
  });
  const audit = SolutionGroundingAuditor.audit(normalized, {
    session: context.session, turn: context.turn, userRequest: context.userRequest, workspaceRoot: context.workspaceRoot,
  });
  return { payload: normalized, evidence, verification, audit,
    allowed: verification.allowed && evidence?.allow !== false && audit.allowed };
}

export interface SubmissionSnapshot {
  session: Session;
  turn: number;
  workspaceRoot: string;
  userRequest: string;
  plan: unknown;
  planBlocker?: string;
  activeAgents: number;
}

/** No seq-wide invalidation: prompt/persistence/control events do not change evidence. */
export function submissionFingerprint(snapshot: SubmissionSnapshot): string | undefined {
  const { session, turn } = snapshot;
  const state = getTurnCompletionState(session, turn);
  let unreadableArtifact = false;
  const artifactDigests = state.filesModified.map(file => {
    try {
      return [file, createHash('sha256').update(fs.readFileSync(path.resolve(snapshot.workspaceRoot, file))).digest('hex')];
    } catch (error: any) {
      if (error?.code !== 'ENOENT') unreadableArtifact = true;
      return [file, 'absent'];
    }
  });
  if (unreadableArtifact) return undefined;
  const evidenceSeq = collectCompletionObservations(session, turn).map(item => [item.call.seq, item.result.seq]);
  const userSeq = session.getEvents().filter(event => event.type === 'user/message' && event.data.source !== 'system').at(-1)?.seq;
  return createHash('sha256').update(JSON.stringify({ sessionId: session.id, turn, userSeq,
    request: snapshot.userRequest, plan: snapshot.plan, evidenceSeq, artifactDigests })).digest('hex');
}

/** Turn-local, bounded ticket. A declaration of completion alone never arms it. */
export class SubmissionReadiness {
  private ticket?: { fingerprint: string; payload: SubmitSolutionPayload };

  clear(): void { this.ticket = undefined; }

  arm(payload: SubmitSolutionPayload, snapshot: SubmissionSnapshot, allowed: boolean): boolean {
    this.clear();
    if (!allowed || snapshot.planBlocker || snapshot.activeAgents > 0
      || snapshot.session.getPendingInputs().length > 0 || snapshot.session.getPendingToolCalls().length > 0) return false;
    const fingerprint = submissionFingerprint(snapshot);
    if (!fingerprint) return false;
    this.ticket = { fingerprint, payload };
    return true;
  }

  current(snapshot: SubmissionSnapshot, allowSubmissionCall = false): SubmitSolutionPayload | undefined {
    if (!this.ticket) return undefined;
    const pending = snapshot.session.getPendingToolCalls().filter(call =>
      !allowSubmissionCall || call.data.toolName !== 'submit_solution');
    if (snapshot.planBlocker || snapshot.activeAgents > 0 || snapshot.session.getPendingInputs().length > 0 || pending.length > 0
      || this.ticket.fingerprint !== submissionFingerprint(snapshot)) this.clear();
    return this.ticket?.payload;
  }
}
