import type {
  VerificationContract,
  EvidenceRecord,
  WorkspaceState,
  HypothesisNode,
} from '../control-plane-state.js';
import { VerificationContractEngine } from '../verification/verification-contract-engine.js';

export interface CompletionGateResult {
  canComplete: boolean;
  score: number;
  blockers: string[];
  staleEvidence: string[];
  missingEvidence: string[];
  reasons: string[];
}

export class CompletionGate {
  /**
   * Deterministically verifies if the task can legally transition to COMPLETED.
   */
  static evaluateCompletion(params: {
    contract: VerificationContract;
    workspace: WorkspaceState;
    freshEvidence: EvidenceRecord[];
    allEvidence: EvidenceRecord[];
    activeHypothesis?: HypothesisNode;
    hasSubmittedSolution?: boolean;
  }): CompletionGateResult {
    const { contract, workspace, freshEvidence, allEvidence, activeHypothesis, hasSubmittedSolution } = params;

    const blockers: string[] = [];
    const reasons: string[] = [];

    // If no files have been mutated and zero diagnostic errors exist (conversational / analysis task)
    if (!workspace.dirty && workspace.changedFiles.length === 0 && workspace.diagnostics.errors.length === 0) {
      return {
        canComplete: true,
        score: 100,
        blockers: [],
        staleEvidence: [],
        missingEvidence: [],
        reasons: ['Clean completion: Zero workspace mutations introduced and zero compiler errors.'],
      };
    }

    // 1. Evaluate contract compliance
    const contractResult = VerificationContractEngine.evaluate({
      contract,
      freshEvidence,
      allEvidence,
      diagnostics: workspace.diagnostics,
      hasSubmittedSolution,
    });

    if (!contractResult.satisfied) {
      blockers.push(...contractResult.hardBlockers);
      reasons.push(...contractResult.reasons);
    }

    // 2. Active hypothesis cannot remain in untested or failing state
    if (activeHypothesis && activeHypothesis.status === 'TESTING') {
      blockers.push(`Active hypothesis [${activeHypothesis.id}] remains in TESTING state without validation.`);
      reasons.push(`Hypothesis [${activeHypothesis.id}] is unresolved.`);
    }

    // 3. If workspace is dirty but no verification ran after latest mutation
    if (workspace.dirty && workspace.activeMutationSeq > workspace.lastVerifiedMutationSeq && !hasSubmittedSolution) {
      blockers.push(
        `Workspace has unverified mutations (seq #${workspace.activeMutationSeq} > lastVerified #${workspace.lastVerifiedMutationSeq}).`,
      );
      reasons.push('Empirical verification must run on current mutated workspace state before completion.');
    }

    const canComplete = blockers.length === 0 && contractResult.satisfied;

    return {
      canComplete,
      score: contractResult.score,
      blockers,
      staleEvidence: contractResult.staleChecks,
      missingEvidence: contractResult.pendingChecks,
      reasons,
    };
  }
}
