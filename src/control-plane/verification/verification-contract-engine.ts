import type {
  VerificationContract,
  EvidenceRecord,
  DiagnosticSnapshot,
  VerificationState,
} from '../control-plane-state.js';

export interface ContractEvaluationResult {
  satisfied: boolean;
  score: number; // 0 - 100
  satisfiedChecks: string[];
  pendingChecks: string[];
  failedChecks: string[];
  staleChecks: string[];
  hardBlockers: string[];
  reasons: string[];
}

export class VerificationContractEngine {
  /**
   * Deterministically evaluates if a VerificationContract is satisfied by current fresh evidence.
   */
  static evaluate(params: {
    contract: VerificationContract;
    freshEvidence: EvidenceRecord[];
    allEvidence: EvidenceRecord[];
    diagnostics: DiagnosticSnapshot;
    hasSubmittedSolution?: boolean;
  }): ContractEvaluationResult {
    const { contract, freshEvidence, allEvidence, diagnostics, hasSubmittedSolution } = params;

    const satisfiedChecks: string[] = [];
    const pendingChecks: string[] = [];
    const failedChecks: string[] = [];
    const staleChecks: string[] = [];
    const hardBlockers: string[] = [];
    const reasons: string[] = [];

    // 1. HARD INVARIANT: Zero compiler / syntax errors
    if (diagnostics.errors.length > 0) {
      const errCount = diagnostics.errors.length;
      hardBlockers.push(`Workspace has ${errCount} unresolved compiler / syntax error(s).`);
      reasons.push(`[HARD INVARIANT VIOLATION]: Workspace has ${errCount} unresolved error(s). Score is 0.`);
    }

    if (diagnostics.syntaxErrors.length > 0) {
      hardBlockers.push(`Workspace has ${diagnostics.syntaxErrors.length} syntax error(s).`);
    }

    // If submit_solution is certified and no compiler errors exist
    if (hasSubmittedSolution && diagnostics.errors.length === 0) {
      return {
        satisfied: true,
        score: 100,
        satisfiedChecks: contract.requiredChecks.map((c) => c.id),
        pendingChecks: [],
        failedChecks: [],
        staleChecks: [],
        hardBlockers: [],
        reasons: ['Explicit solution submitted and zero diagnostic errors.'],
      };
    }

    // 2. Evaluate each required check against FRESH evidence
    for (const check of contract.requiredChecks) {
      if (check.kind === 'diagnostic') {
        if (diagnostics.errors.length === 0) {
          satisfiedChecks.push(check.id);
        } else {
          failedChecks.push(check.id);
        }
        continue;
      }

      // Find matching fresh evidence
      const matchingFresh = freshEvidence.filter((e) => {
        if (check.kind === 'test' && (e.type === 'test' || e.type === 'runtime')) return true;
        if (check.kind === 'diff' && (e.type === 'diff' || e.type === 'static-analysis')) return true;
        if (check.kind === 'build' && e.type === 'build') return true;
        if (check.command && e.command?.includes(check.command)) return true;
        return false;
      });

      const passingFresh = matchingFresh.find((e) => e.status === 'PASS');
      const failingFresh = matchingFresh.find((e) => e.status === 'FAIL');

      if (passingFresh) {
        satisfiedChecks.push(check.id);
      } else if (failingFresh) {
        failedChecks.push(check.id);
        hardBlockers.push(`Check [${check.name}] failed in recent verification run.`);
        reasons.push(`Verification check [${check.name}] failed: ${failingFresh.summary}`);
      } else {
        // Check if there is stale evidence that used to pass
        const matchingStale = allEvidence.filter((e) =>
          (e.freshness === 'STALE' || e.status === 'STALE') &&
          (e.type === check.kind || (check.command && e.command?.includes(check.command))),
        );

        if (matchingStale.length > 0) {
          staleChecks.push(check.id);
          reasons.push(
            `Verification check [${check.name}] has only STALE evidence (mutations occurred after test ran). Must re-run verification.`,
          );
        } else {
          pendingChecks.push(check.id);
          reasons.push(`Verification check [${check.name}] is missing empirical evidence.`);
        }
      }
    }

    const totalRequired = contract.requiredChecks.length || 1;
    let score = Math.round((satisfiedChecks.length / totalRequired) * 100);

    if (hardBlockers.length > 0 || diagnostics.errors.length > 0) {
      score = 0;
    }

    const satisfied = hardBlockers.length === 0 && pendingChecks.length === 0 && staleChecks.length === 0 && score >= 80;

    return {
      satisfied,
      score,
      satisfiedChecks,
      pendingChecks,
      failedChecks,
      staleChecks,
      hardBlockers,
      reasons,
    };
  }
}
