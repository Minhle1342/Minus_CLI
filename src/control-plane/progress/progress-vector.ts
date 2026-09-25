import type { ProgressVector } from '../control-plane-state.js';

export interface ProgressVectorWeights {
  wInformationGain: number;
  wUncertaintyReduction: number;
  wHypothesisReduction: number;
  wGoalCompletion: number;
  wVerificationCoverage: number;
  wWorkspaceHealth: number;
}

export const DEFAULT_PROGRESS_WEIGHTS: ProgressVectorWeights = {
  wInformationGain: 0.2,
  wUncertaintyReduction: 0.15,
  wHypothesisReduction: 0.15,
  wGoalCompletion: 0.25,
  wVerificationCoverage: 0.15,
  wWorkspaceHealth: 0.1,
};

export class ProgressVectorCalculator {
  /**
   * Computes the weighted overall progress score from a ProgressVector.
   */
  static computeOverallScore(
    vector: ProgressVector,
    weights: ProgressVectorWeights = DEFAULT_PROGRESS_WEIGHTS,
  ): number {
    const raw =
      vector.informationGain * weights.wInformationGain +
      vector.uncertaintyReduction * weights.wUncertaintyReduction +
      vector.hypothesisReduction * weights.wHypothesisReduction +
      vector.goalCompletionDelta * weights.wGoalCompletion +
      vector.verificationCoverageDelta * weights.wVerificationCoverage +
      vector.workspaceHealthDelta * weights.wWorkspaceHealth;

    return Math.min(1.0, Math.max(0, raw));
  }
}
