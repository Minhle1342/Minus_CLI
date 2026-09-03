import type {
  ControlPlaneState,
  LifecycleStatus,
  ChangedFileState,
  DiagnosticSnapshot,
  VerificationContract,
  EvidenceRecord,
  HypothesisNode,
  MutationTransaction,
  GreenCheckpoint,
  CriticDecision,
  ReasoningTier,
  ReasoningStrategy,
  ProgressVector,
} from './control-plane-state.js';

export type ControlPlaneEvent =
  | { type: 'TaskAccepted'; payload: { taskId: string; userRequest: string; goal: string; riskLevel?: any } }
  | { type: 'BaselineCaptured'; payload: { workspaceDigest: string; gitHead?: string; fileHashes: Record<string, string>; checkpoint?: GreenCheckpoint } }
  | { type: 'LifecycleStatusChanged'; payload: { status: LifecycleStatus; reason?: string } }
  | { type: 'TurnStepAdvanced'; payload: { turn: number; step: number } }
  | { type: 'WorkspaceMutated'; payload: { files: ChangedFileState[]; mutationSeq: number; dirty: boolean; workspaceDigest: string } }
  | { type: 'DiagnosticsUpdated'; payload: { diagnostics: DiagnosticSnapshot } }
  | { type: 'VerificationContractSet'; payload: { contract: VerificationContract } }
  | { type: 'EvidenceRecorded'; payload: { record: EvidenceRecord } }
  | { type: 'EvidenceInvalidated'; payload: { evidenceIds: string[]; reason: string } }
  | { type: 'HypothesisFormulated'; payload: { hypothesis: HypothesisNode } }
  | { type: 'HypothesisStatusUpdated'; payload: { hypothesisId: string; status: HypothesisNode['status']; reason?: string; learning?: string } }
  | { type: 'TransactionOpened'; payload: { transaction: MutationTransaction } }
  | { type: 'TransactionCommitted'; payload: { transactionId: string; checkpoint: GreenCheckpoint } }
  | { type: 'TransactionRolledBack'; payload: { transactionId: string; rolledBackTo: string; reason: string } }
  | { type: 'ProgressEvaluated'; payload: { vector: ProgressVector; overallScore: number; actionFingerprint?: string; stagnationDetected: boolean; strategySwitch?: string } }
  | { type: 'ReasoningEscalated'; payload: { toTier: ReasoningTier; toStrategy: ReasoningStrategy; reason: string } }
  | { type: 'ReasoningDeescalated'; payload: { toTier: ReasoningTier; toStrategy: ReasoningStrategy; reason: string } }
  | { type: 'CriticEvaluated'; payload: { decision: CriticDecision; turn: number; step: number } }
  | { type: 'TaskCompleted'; payload: { terminationReason?: string } }
  | { type: 'TaskBlocked'; payload: { reason: string } };

export function reduceControlPlaneState(
  state: ControlPlaneState,
  event: ControlPlaneEvent,
): ControlPlaneState {
  const now = Date.now();

  switch (event.type) {
    case 'TaskAccepted': {
      return {
        ...state,
        task: {
          ...state.task,
          taskId: event.payload.taskId,
          userRequest: event.payload.userRequest,
          goal: event.payload.goal,
          riskLevel: event.payload.riskLevel || state.task.riskLevel,
        },
        lifecycle: {
          ...state.lifecycle,
          status: 'INTAKE',
        },
      };
    }

    case 'BaselineCaptured': {
      const g0 = event.payload.checkpoint;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          workspaceDigest: event.payload.workspaceDigest,
          gitHead: event.payload.gitHead,
          fileHashes: { ...event.payload.fileHashes },
          lastGreenCheckpoint: g0 ? {
            checkpointId: g0.checkpointId,
            workspaceDigest: g0.workspaceDigest,
            mutationSeq: g0.mutationSeq,
            timestamp: g0.createdAt,
            description: g0.description,
            gitCommitHash: g0.gitState,
          } : state.workspace.lastGreenCheckpoint,
        },
        transaction: {
          ...state.transaction,
          greenCheckpoints: g0 ? [g0] : state.transaction.greenCheckpoints,
        },
        lifecycle: {
          ...state.lifecycle,
          status: 'BASELINE',
        },
      };
    }

    case 'LifecycleStatusChanged': {
      return {
        ...state,
        lifecycle: {
          ...state.lifecycle,
          previousStatus: state.lifecycle.status,
          status: event.payload.status,
          terminationReason: event.payload.reason || state.lifecycle.terminationReason,
        },
      };
    }

    case 'TurnStepAdvanced': {
      return {
        ...state,
        lifecycle: {
          ...state.lifecycle,
          turn: event.payload.turn,
          step: event.payload.step,
        },
      };
    }

    case 'WorkspaceMutated': {
      const updatedFiles = [...state.workspace.changedFiles];
      for (const f of event.payload.files) {
        const idx = updatedFiles.findIndex((item) => item.path === f.path);
        if (idx >= 0) {
          updatedFiles[idx] = f;
        } else {
          updatedFiles.push(f);
        }
      }

      const updatedHashes = { ...state.workspace.fileHashes };
      for (const f of event.payload.files) {
        updatedHashes[f.path] = f.contentHash;
      }

      return {
        ...state,
        workspace: {
          ...state.workspace,
          dirty: event.payload.dirty,
          activeMutationSeq: event.payload.mutationSeq,
          workspaceDigest: event.payload.workspaceDigest,
          changedFiles: updatedFiles,
          fileHashes: updatedHashes,
        },
      };
    }

    case 'DiagnosticsUpdated': {
      return {
        ...state,
        workspace: {
          ...state.workspace,
          diagnostics: event.payload.diagnostics,
        },
      };
    }

    case 'VerificationContractSet': {
      return {
        ...state,
        verification: {
          ...state.verification,
          contract: event.payload.contract,
          pendingCheckIds: event.payload.contract.requiredChecks.map((c) => c.id),
          satisfiedCheckIds: [],
          failedCheckIds: [],
        },
      };
    }

    case 'EvidenceRecorded': {
      const rec = event.payload.record;
      const records = { ...state.evidence.records, [rec.evidenceId]: rec };
      const activeFresh = new Set(state.evidence.activeFreshEvidenceIds);
      const stale = new Set(state.evidence.staleEvidenceIds);

      if (rec.freshness === 'FRESH' && rec.status === 'PASS') {
        activeFresh.add(rec.evidenceId);
        stale.delete(rec.evidenceId);
      } else {
        activeFresh.delete(rec.evidenceId);
        if (rec.freshness === 'STALE') {
          stale.add(rec.evidenceId);
        }
      }

      // Update verification check satisfaction if matching check exists
      let satisfied = [...state.verification.satisfiedCheckIds];
      let pending = [...state.verification.pendingCheckIds];
      let failed = [...state.verification.failedCheckIds];

      if (state.verification.contract) {
        for (const check of state.verification.contract.requiredChecks) {
          if (rec.type === check.kind || (check.command && rec.command?.includes(check.command))) {
            if (rec.status === 'PASS' && rec.freshness === 'FRESH') {
              if (!satisfied.includes(check.id)) satisfied.push(check.id);
              pending = pending.filter((id) => id !== check.id);
              failed = failed.filter((id) => id !== check.id);
            } else if (rec.status === 'FAIL') {
              if (!failed.includes(check.id)) failed.push(check.id);
              satisfied = satisfied.filter((id) => id !== check.id);
              pending = pending.filter((id) => id !== check.id);
            }
          }
        }
      }

      const totalChecks = state.verification.contract?.requiredChecks.length || 1;
      const coverageScore = Math.round((satisfied.length / totalChecks) * 100);

      return {
        ...state,
        evidence: {
          records,
          activeFreshEvidenceIds: Array.from(activeFresh),
          staleEvidenceIds: Array.from(stale),
        },
        verification: {
          ...state.verification,
          satisfiedCheckIds: satisfied,
          pendingCheckIds: pending,
          failedCheckIds: failed,
          coverageScore,
          lastVerifiedAt: now,
        },
      };
    }

    case 'EvidenceInvalidated': {
      const records = { ...state.evidence.records };
      const activeFresh = new Set(state.evidence.activeFreshEvidenceIds);
      const stale = new Set(state.evidence.staleEvidenceIds);

      for (const id of event.payload.evidenceIds) {
        if (records[id]) {
          records[id] = {
            ...records[id],
            freshness: 'STALE',
            status: 'STALE',
          };
        }
        activeFresh.delete(id);
        stale.add(id);
      }

      return {
        ...state,
        evidence: {
          records,
          activeFreshEvidenceIds: Array.from(activeFresh),
          staleEvidenceIds: Array.from(stale),
        },
      };
    }

    case 'HypothesisFormulated': {
      const h = event.payload.hypothesis;
      return {
        ...state,
        hypotheses: {
          ...state.hypotheses,
          nodes: {
            ...state.hypotheses.nodes,
            [h.id]: h,
          },
          activeHypothesisId: h.id,
          hypothesisCounter: state.hypotheses.hypothesisCounter + 1,
        },
      };
    }

    case 'HypothesisStatusUpdated': {
      const { hypothesisId, status, reason, learning } = event.payload;
      const existing = state.hypotheses.nodes[hypothesisId];
      if (!existing) return state;

      const updatedNode: HypothesisNode = {
        ...existing,
        status,
        rejectionReason: reason || existing.rejectionReason,
        learning: learning || existing.learning,
        updatedAt: now,
      };

      const falsified = new Set(state.hypotheses.falsifiedHypothesisIds);
      const validated = new Set(state.hypotheses.validatedHypothesisIds);

      if (status === 'FALSIFIED') {
        falsified.add(hypothesisId);
        validated.delete(hypothesisId);
      } else if (status === 'VALIDATED') {
        validated.add(hypothesisId);
        falsified.delete(hypothesisId);
      }

      return {
        ...state,
        hypotheses: {
          ...state.hypotheses,
          nodes: {
            ...state.hypotheses.nodes,
            [hypothesisId]: updatedNode,
          },
          activeHypothesisId: status === 'FALSIFIED' || status === 'VALIDATED' || status === 'ABANDONED'
            ? undefined
            : state.hypotheses.activeHypothesisId,
          falsifiedHypothesisIds: Array.from(falsified),
          validatedHypothesisIds: Array.from(validated),
        },
      };
    }

    case 'TransactionOpened': {
      return {
        ...state,
        transaction: {
          ...state.transaction,
          activeTransaction: event.payload.transaction,
        },
      };
    }

    case 'TransactionCommitted': {
      const cp = event.payload.checkpoint;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          lastGreenCheckpoint: {
            checkpointId: cp.checkpointId,
            workspaceDigest: cp.workspaceDigest,
            mutationSeq: cp.mutationSeq,
            timestamp: cp.createdAt,
            description: cp.description,
            gitCommitHash: cp.gitState,
          },
          lastVerifiedMutationSeq: cp.mutationSeq,
        },
        transaction: {
          ...state.transaction,
          activeTransaction: undefined,
          greenCheckpoints: [...state.transaction.greenCheckpoints, cp],
        },
      };
    }

    case 'TransactionRolledBack': {
      return {
        ...state,
        transaction: {
          ...state.transaction,
          activeTransaction: undefined,
          rejectedCandidates: [
            ...state.transaction.rejectedCandidates,
            {
              transactionId: event.payload.transactionId,
              reason: event.payload.reason,
              rolledBackTo: event.payload.rolledBackTo,
              timestamp: now,
            },
          ],
        },
      };
    }

    case 'ProgressEvaluated': {
      const fingerprints = [...state.progress.lastActionFingerprints];
      if (event.payload.actionFingerprint) {
        fingerprints.push(event.payload.actionFingerprint);
        if (fingerprints.length > 10) fingerprints.shift();
      }

      const consecutiveLow = event.payload.overallScore < 0.2
        ? state.progress.consecutiveLowProgressSteps + 1
        : 0;

      return {
        ...state,
        progress: {
          vector: event.payload.vector,
          overallScore: event.payload.overallScore,
          consecutiveLowProgressSteps: consecutiveLow,
          lastActionFingerprints: fingerprints,
          stagnationDetected: event.payload.stagnationDetected || consecutiveLow >= 3,
          recommendedStrategySwitch: event.payload.strategySwitch,
        },
      };
    }

    case 'ReasoningEscalated': {
      const tokenBudgets: Record<ReasoningTier, number> = {
        0: 0,
        1: 2048,
        2: 8192,
        3: 16384,
        4: 32768,
      };

      return {
        ...state,
        reasoning: {
          ...state.reasoning,
          currentTier: event.payload.toTier,
          currentStrategy: event.payload.toStrategy,
          tokenBudget: tokenBudgets[event.payload.toTier] ?? 8192,
          transitions: [
            ...state.reasoning.transitions,
            {
              fromTier: state.reasoning.currentTier,
              toTier: event.payload.toTier,
              fromStrategy: state.reasoning.currentStrategy,
              toStrategy: event.payload.toStrategy,
              reason: event.payload.reason,
              timestamp: now,
            },
          ],
        },
      };
    }

    case 'ReasoningDeescalated': {
      const tokenBudgets: Record<ReasoningTier, number> = {
        0: 0,
        1: 2048,
        2: 8192,
        3: 16384,
        4: 32768,
      };

      return {
        ...state,
        reasoning: {
          ...state.reasoning,
          currentTier: event.payload.toTier,
          currentStrategy: event.payload.toStrategy,
          tokenBudget: tokenBudgets[event.payload.toTier] ?? 8192,
          transitions: [
            ...state.reasoning.transitions,
            {
              fromTier: state.reasoning.currentTier,
              toTier: event.payload.toTier,
              fromStrategy: state.reasoning.currentStrategy,
              toStrategy: event.payload.toStrategy,
              reason: event.payload.reason,
              timestamp: now,
            },
          ],
        },
      };
    }

    case 'CriticEvaluated': {
      return {
        ...state,
        critic: {
          lastDecision: event.payload.decision,
          evaluationsCount: state.critic.evaluationsCount + 1,
          approvalHistory: [
            ...state.critic.approvalHistory,
            {
              turn: event.payload.turn,
              step: event.payload.step,
              approved: event.payload.decision.approved,
              score: event.payload.decision.score,
              reasons: event.payload.decision.reasons,
              timestamp: now,
            },
          ],
        },
      };
    }

    case 'TaskCompleted': {
      return {
        ...state,
        lifecycle: {
          ...state.lifecycle,
          previousStatus: state.lifecycle.status,
          status: 'COMPLETED',
          completedAt: now,
          terminationReason: event.payload.terminationReason || 'Verified completion contract satisfied',
        },
      };
    }

    case 'TaskBlocked': {
      return {
        ...state,
        lifecycle: {
          ...state.lifecycle,
          previousStatus: state.lifecycle.status,
          status: 'BLOCKED',
          completedAt: now,
          terminationReason: event.payload.reason,
        },
      };
    }

    default:
      return state;
  }
}
