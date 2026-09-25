import type {
  VerificationContract,
  WorkspaceState,
  MutationTransaction,
  EvidenceRecord,
  HypothesisNode,
  CriticDecision,
  ControlAction,
} from '../control-plane-state.js';
import { AcceptancePolicy } from './acceptance-policy.js';
import { VerificationContractEngine } from '../verification/verification-contract-engine.js';
import { CriticDecisionBuilder } from './critic-decision.js';
import { CompletionGate } from './completion-gate.js';

export interface CriticEngineInput {
  contract?: VerificationContract;
  workspace: WorkspaceState;
  transaction?: MutationTransaction;
  freshEvidence: EvidenceRecord[];
  allEvidence: EvidenceRecord[];
  activeHypothesis?: HypothesisNode;
  isCompletionRequest?: boolean;
  hasSubmittedSolution?: boolean;
  registeredFiles?: string[];
  finalAnswerText?: string;
}

export class CriticEngine {
  /**
   * Main evaluation entrypoint for the Critic / Acceptance role in EDCP.
   */
  static evaluate(input: CriticEngineInput): CriticDecision {
    const {
      contract,
      workspace,
      transaction,
      freshEvidence,
      allEvidence,
      activeHypothesis,
      isCompletionRequest = false,
      hasSubmittedSolution = false,
      registeredFiles = [],
      finalAnswerText,
    } = input;

    // 1. HARD INVARIANT CHECK
    const hardCheck = AcceptancePolicy.checkHardInvariants({
      diagnostics: workspace.diagnostics,
      changedFiles: workspace.changedFiles,
      registeredFiles,
      finalAnswerText: isCompletionRequest ? finalAnswerText : undefined,
    });

    if (!hardCheck.passed) {
      const authorizedActions: ControlAction[] = [
        {
          type: 'ROLLBACK',
          reason: 'Hard invariant broken (compiler/syntax error or out-of-scope mutation).',
        },
        {
          type: 'DIAGNOSE',
          reason: 'Investigate compiler diagnostics and missing imports.',
        },
      ];

      return CriticDecisionBuilder.build({
        verdict: 'REJECT_CANDIDATE',
        score: 0,
        approved: false,
        hardBlockers: hardCheck.violations,
        reasons: hardCheck.violations,
        authorizedNextActions: authorizedActions,
      });
    }

    // If no contract specified yet, evaluate basic diagnostic readiness
    if (!contract) {
      return CriticDecisionBuilder.build({
        verdict: 'NEED_MORE_EVIDENCE',
        score: 50,
        approved: false,
        reasons: ['No verification contract established yet.'],
        authorizedNextActions: [
          { type: 'INSPECT', reason: 'Derive verification contract from task specifications.' },
        ],
      });
    }

    // 2. If this is a completion request, run CompletionGate
    if (isCompletionRequest) {
      const completionResult = CompletionGate.evaluateCompletion({
        contract,
        workspace,
        freshEvidence,
        allEvidence,
        activeHypothesis,
        hasSubmittedSolution,
      });

      if (!completionResult.canComplete) {
        return CriticDecisionBuilder.build({
          verdict: 'BLOCK_COMPLETION',
          score: completionResult.score,
          approved: false,
          hardBlockers: completionResult.blockers,
          staleEvidence: completionResult.staleEvidence,
          missingEvidence: completionResult.missingEvidence,
          reasons: completionResult.reasons,
          authorizedNextActions: [
            { type: 'VERIFY', reason: 'Execute missing verification checks before completion.' },
          ],
        });
      }

      return CriticDecisionBuilder.build({
        verdict: 'ACCEPT_CANDIDATE',
        score: 100,
        approved: true,
        reasons: ['All verification contracts and invariants fully satisfied by fresh evidence.'],
        authorizedNextActions: [
          { type: 'FINALIZE', reason: 'Proceed to emit verified completion report and complete task.' },
        ],
      });
    }

    // 3. Regular candidate evaluation
    const contractResult = VerificationContractEngine.evaluate({
      contract,
      freshEvidence,
      allEvidence,
      diagnostics: workspace.diagnostics,
      hasSubmittedSolution,
    });

    if (contractResult.hardBlockers.length > 0) {
      return CriticDecisionBuilder.build({
        verdict: 'REJECT_CANDIDATE',
        score: contractResult.score,
        approved: false,
        hardBlockers: contractResult.hardBlockers,
        reasons: contractResult.reasons,
        authorizedNextActions: [
          { type: 'ROLLBACK', reason: 'Candidate mutation failed verification tests.' },
        ],
      });
    }

    if (contractResult.staleChecks.length > 0) {
      return CriticDecisionBuilder.build({
        verdict: 'NEED_MORE_EVIDENCE',
        score: contractResult.score,
        approved: false,
        staleEvidence: contractResult.staleChecks,
        reasons: contractResult.reasons,
        authorizedNextActions: [
          { type: 'VERIFY', reason: 'Re-run stale verification checks after recent mutation.' },
        ],
      });
    }

    if (contractResult.pendingChecks.length > 0) {
      return CriticDecisionBuilder.build({
        verdict: 'NEED_MORE_EVIDENCE',
        score: contractResult.score,
        approved: false,
        missingEvidence: contractResult.pendingChecks,
        reasons: contractResult.reasons,
        authorizedNextActions: [
          { type: 'VERIFY', reason: 'Execute pending verification checks to satisfy contract.' },
        ],
      });
    }

    // All checks passing!
    return CriticDecisionBuilder.build({
      verdict: 'ACCEPT_CANDIDATE',
      score: contractResult.score,
      approved: true,
      reasons: ['Candidate passed all required verification checks and preserved invariants.'],
      authorizedNextActions: [
        { type: 'PROMOTE_GREEN', reason: 'Promote verified candidate to new green baseline.' },
      ],
    });
  }
}
