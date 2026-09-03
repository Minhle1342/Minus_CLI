import type { ProgressState, ProgressVector } from '../control-plane-state.js';
import { ProgressVectorCalculator } from './progress-vector.js';
import { StagnationDetector, type ObservationRecord } from './stagnation-detector.js';
import { StrategySwitcher } from './strategy-switcher.js';

export class ProgressController {
  private readonly stagnationDetector = new StagnationDetector();
  private currentVector: ProgressVector = {
    informationGain: 0,
    uncertaintyReduction: 0,
    hypothesisReduction: 0,
    goalCompletionDelta: 0,
    verificationCoverageDelta: 0,
    workspaceHealthDelta: 1,
  };
  private overallScore = 0;
  private consecutiveLowProgress = 0;
  private currentStrategy = 'TEXT_SEARCH';

  recordObservation(observation: ObservationRecord): {
    stagnationDetected: boolean;
    recommendedStrategy?: string;
    progressScore: number;
  } {
    const stagnation = this.stagnationDetector.record(observation);

    if (stagnation.stagnant) {
      this.consecutiveLowProgress++;
      this.currentStrategy = StrategySwitcher.recommendNextStrategy(
        this.currentStrategy,
        this.consecutiveLowProgress,
      );
      this.overallScore = 0;

      return {
        stagnationDetected: true,
        recommendedStrategy: this.currentStrategy,
        progressScore: 0,
      };
    }

    // Normal informative step
    this.consecutiveLowProgress = 0;
    this.overallScore = ProgressVectorCalculator.computeOverallScore(this.currentVector);

    return {
      stagnationDetected: false,
      progressScore: this.overallScore,
    };
  }

  updateProgressVector(delta: Partial<ProgressVector>): void {
    this.currentVector = {
      ...this.currentVector,
      ...delta,
    };
    this.overallScore = ProgressVectorCalculator.computeOverallScore(this.currentVector);
  }

  getState(): ProgressState {
    return {
      vector: { ...this.currentVector },
      overallScore: this.overallScore,
      consecutiveLowProgressSteps: this.consecutiveLowProgress,
      lastActionFingerprints: [],
      stagnationDetected: this.consecutiveLowProgress >= 3,
      recommendedStrategySwitch: this.consecutiveLowProgress >= 2 ? this.currentStrategy : undefined,
    };
  }

  reset(): void {
    this.stagnationDetector.reset();
    this.consecutiveLowProgress = 0;
    this.overallScore = 0;
  }
}
