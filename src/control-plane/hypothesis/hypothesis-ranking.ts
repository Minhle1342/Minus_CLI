import type { HypothesisNode } from '../control-plane-state.js';

export interface RankedHypothesis {
  hypothesis: HypothesisNode;
  score: number;
  rank: number;
}

export class HypothesisRanker {
  /**
   * Ranks candidate hypotheses by:
   * (Information Gain * Confidence) / (Cost * Safety Penalty)
   */
  static rank(hypotheses: HypothesisNode[]): RankedHypothesis[] {
    const candidates = hypotheses.filter(
      (h) => h.status === 'FORMULATED' || h.status === 'TESTING',
    );

    const scored = candidates.map((h) => {
      const confidence = h.confidence || 0.5;
      const infoGain = h.predictedObservations.length > 0 ? 1.0 : 0.6;
      const cost = Math.max(0.5, h.estimatedExperimentCost || 1);
      const safetyPenalty = h.blastRadius.risk === 'CRITICAL' ? 2.0 : h.blastRadius.risk === 'HIGH_RISK' ? 1.5 : 1.0;

      const score = (infoGain * confidence) / (cost * safetyPenalty);
      return { hypothesis: h, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.map((item, idx) => ({
      hypothesis: item.hypothesis,
      score: item.score,
      rank: idx + 1,
    }));
  }
}
