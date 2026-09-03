import type {
  ControlPlaneState,
  EvidenceRecord,
} from './control-plane-state.js';

export interface VerifiedCompletionReport {
  goal: string;
  finalWorkspaceDigest: string;
  acceptedCheckpoint?: string;
  satisfiedCriteria: string[];
  verificationEvidence: Array<{
    type: string;
    summary: string;
    mutationSeq: number;
    status: string;
  }>;
  changedFiles: string[];
  rejectedHypotheses: string[];
  acceptedHypotheses: string[];
  rollbackCount: number;
  reasoningEscalationsCount: number;
  auditTrail: string;
}

export class CompletionReportGenerator {
  static generate(state: ControlPlaneState, freshEvidence: EvidenceRecord[]): VerifiedCompletionReport {
    const satisfiedCriteria = state.verification.satisfiedCheckIds;
    const changedFiles = state.workspace.changedFiles.map((f) => f.path);
    const rejectedHypotheses = state.hypotheses.falsifiedHypothesisIds;
    const acceptedHypotheses = state.hypotheses.validatedHypothesisIds;
    const rollbackCount = state.transaction.rejectedCandidates.length;
    const reasoningEscalationsCount = state.reasoning.transitions.length;

    const verificationEvidence = freshEvidence.map((e) => ({
      type: e.type,
      summary: e.summary,
      mutationSeq: e.mutationSeq,
      status: e.status,
    }));

    const auditLines: string[] = [
      `=======================================================`,
      `       MINUS VERIFIED COMPLETION AUDIT TRAIL           `,
      `=======================================================`,
      `Goal: ${state.task.goal}`,
      `Final Workspace Digest: ${state.workspace.workspaceDigest}`,
      `Last Green Checkpoint: ${state.workspace.lastGreenCheckpoint?.checkpointId || 'None'}`,
      `Changed Files (${changedFiles.length}): ${changedFiles.join(', ') || 'None'}`,
      `Rollbacks Triggered: ${rollbackCount}`,
      `Reasoning Escalations: ${reasoningEscalationsCount}`,
      ``,
      `--- Empirical Verification Evidence (${verificationEvidence.length}) ---`,
    ];

    for (const ev of verificationEvidence) {
      auditLines.push(`  ✓ [${ev.type.toUpperCase()}] (Seq #${ev.mutationSeq}) ${ev.summary} -> ${ev.status}`);
    }

    if (rejectedHypotheses.length > 0) {
      auditLines.push(``, `--- Falsified / Rejected Hypotheses (${rejectedHypotheses.length}) ---`);
      for (const hId of rejectedHypotheses) {
        const h = state.hypotheses.nodes[hId];
        auditLines.push(`  ❌ [${hId}] ${h?.statement || 'Unknown'} (Reason: ${h?.rejectionReason || 'Falsified'})`);
      }
    }

    if (acceptedHypotheses.length > 0) {
      auditLines.push(``, `--- Validated Hypotheses (${acceptedHypotheses.length}) ---`);
      for (const hId of acceptedHypotheses) {
        const h = state.hypotheses.nodes[hId];
        auditLines.push(`  ✅ [${hId}] ${h?.statement || 'Unknown'}`);
      }
    }

    auditLines.push(`=======================================================`);

    return {
      goal: state.task.goal,
      finalWorkspaceDigest: state.workspace.workspaceDigest,
      acceptedCheckpoint: state.workspace.lastGreenCheckpoint?.checkpointId,
      satisfiedCriteria,
      verificationEvidence,
      changedFiles,
      rejectedHypotheses,
      acceptedHypotheses,
      rollbackCount,
      reasoningEscalationsCount,
      auditTrail: auditLines.join('\n'),
    };
  }
}
