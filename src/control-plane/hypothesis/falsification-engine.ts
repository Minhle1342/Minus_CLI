import type { HypothesisNode, EvidenceRecord } from '../control-plane-state.js';

export interface FalsificationEvaluationResult {
  hypothesisId: string;
  outcome: 'VALIDATED' | 'FALSIFIED' | 'WEAKENED' | 'SUPPORTED' | 'INCONCLUSIVE';
  reason: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
}

export class FalsificationEngine {
  /**
   * Evaluates verification evidence against a hypothesis's predictions.
   */
  static evaluate(params: {
    hypothesis: HypothesisNode;
    freshEvidence: EvidenceRecord[];
  }): FalsificationEvaluationResult {
    const { hypothesis, freshEvidence } = params;

    const supporting: string[] = [];
    const contradicting: string[] = [];

    for (const ev of freshEvidence) {
      if (ev.status === 'FAIL') {
        contradicting.push(ev.evidenceId);
      } else if (ev.status === 'PASS') {
        supporting.push(ev.evidenceId);
      }
    }

    // Check specific falsification criteria
    if (contradicting.length > 0) {
      return {
        hypothesisId: hypothesis.id,
        outcome: 'FALSIFIED',
        reason: `Empirical verification failed for ${contradicting.length} check(s).`,
        supportingEvidence: supporting,
        contradictingEvidence: contradicting,
      };
    }

    if (supporting.length > 0) {
      return {
        hypothesisId: hypothesis.id,
        outcome: 'VALIDATED',
        reason: `All ${supporting.length} verification check(s) passed successfully without regression.`,
        supportingEvidence: supporting,
        contradictingEvidence: [],
      };
    }

    return {
      hypothesisId: hypothesis.id,
      outcome: 'INCONCLUSIVE',
      reason: 'No fresh matching verification evidence observed yet.',
      supportingEvidence: [],
      contradictingEvidence: [],
    };
  }
}
