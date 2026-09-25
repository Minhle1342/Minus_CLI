import type {
  ReasoningTier,
  ReasoningStrategy,
  ReasoningPressure,
  ReasoningState,
  ReasoningTransition,
} from '../control-plane-state.js';
import { StrategyPolicyEvaluator, STRATEGY_POLICIES } from './strategy-policy.js';

export interface EscalationDecision {
  action: 'ESCALATE' | 'DEESCALATE' | 'MAINTAIN';
  newTier: ReasoningTier;
  newStrategy: ReasoningStrategy;
  tokenBudget: number;
  reason: string;
}

export class AdaptiveComputeController {
  private currentTier: ReasoningTier;
  private defaultTier: ReasoningTier;
  private rejectionCount = 0;
  private transitions: ReasoningTransition[] = [];

  constructor(defaultTier: ReasoningTier = 1) {
    this.defaultTier = defaultTier;
    this.currentTier = defaultTier;
  }

  getCurrentTier(): ReasoningTier {
    return this.currentTier;
  }

  getCurrentStrategy(): ReasoningStrategy {
    return StrategyPolicyEvaluator.selectStrategy(this.currentTier);
  }

  getTokenBudget(): number {
    return StrategyPolicyEvaluator.getTierConfig(this.currentTier).tokenBudget;
  }

  getRejectionCount(): number {
    return this.rejectionCount;
  }

  /**
   * Evaluates if reasoning should escalate or de-escalate based on live pressure.
   */
  evaluatePressure(pressure: ReasoningPressure): EscalationDecision {
    // Check escalation criteria
    const highPressure =
      pressure.failureCount >= 2 ||
      pressure.stagnationScore >= 0.6 ||
      pressure.verificationFailures >= 2 ||
      pressure.taskRisk >= 0.75 ||
      pressure.hypothesisEntropy >= 0.5;

    if (highPressure && this.currentTier < 4) {
      const nextTier = (this.currentTier + 1) as ReasoningTier;
      const nextStrategy = StrategyPolicyEvaluator.selectStrategy(nextTier);
      const reason = `Escalated from Tier ${this.currentTier} to Tier ${nextTier} due to high reasoning pressure (failures=${pressure.failureCount}, stagnation=${pressure.stagnationScore.toFixed(2)}, risk=${pressure.taskRisk.toFixed(2)}).`;

      this.recordTransition(this.currentTier, nextTier, reason);
      this.currentTier = nextTier;

      return {
        action: 'ESCALATE',
        newTier: nextTier,
        newStrategy: nextStrategy,
        tokenBudget: STRATEGY_POLICIES[nextTier].tokenBudget,
        reason,
      };
    }

    // Check de-escalation criteria (stable validation, zero failures, low stagnation)
    const lowPressure =
      pressure.failureCount === 0 &&
      pressure.stagnationScore === 0 &&
      pressure.verificationFailures === 0 &&
      this.currentTier > this.defaultTier;

    if (lowPressure) {
      const prevTier = (this.currentTier - 1) as ReasoningTier;
      const prevStrategy = StrategyPolicyEvaluator.selectStrategy(prevTier);
      const reason = `De-escalated from Tier ${this.currentTier} to Tier ${prevTier} after stable verification.`;

      this.recordTransition(this.currentTier, prevTier, reason);
      this.currentTier = prevTier;

      return {
        action: 'DEESCALATE',
        newTier: prevTier,
        newStrategy: prevStrategy,
        tokenBudget: STRATEGY_POLICIES[prevTier].tokenBudget,
        reason,
      };
    }

    return {
      action: 'MAINTAIN',
      newTier: this.currentTier,
      newStrategy: this.getCurrentStrategy(),
      tokenBudget: this.getTokenBudget(),
      reason: 'Reasoning tier maintained at current baseline.',
    };
  }

  escalateExplicit(reason: string): EscalationDecision {
    this.rejectionCount++;
    if (this.currentTier < 4) {
      const nextTier = (this.currentTier + 1) as ReasoningTier;
      this.recordTransition(this.currentTier, nextTier, reason);
      this.currentTier = nextTier;
    }
    const strategy = this.getCurrentStrategy();
    return {
      action: 'ESCALATE',
      newTier: this.currentTier,
      newStrategy: strategy,
      tokenBudget: this.getTokenBudget(),
      reason,
    };
  }

  reset(): void {
    this.currentTier = this.defaultTier;
    this.rejectionCount = 0;
  }

  getState(): ReasoningState {
    return {
      pressure: {
        taskRisk: 0.4,
        uncertainty: 0.5,
        blastRadius: 0.3,
        failureCount: this.rejectionCount,
        stagnationScore: 0,
        hypothesisEntropy: 0,
        verificationFailures: this.rejectionCount,
      },
      currentTier: this.currentTier,
      currentStrategy: this.getCurrentStrategy(),
      tokenBudget: this.getTokenBudget(),
      transitions: [...this.transitions],
    };
  }

  private recordTransition(fromTier: ReasoningTier, toTier: ReasoningTier, reason: string): void {
    this.transitions.push({
      fromTier,
      toTier,
      fromStrategy: StrategyPolicyEvaluator.selectStrategy(fromTier),
      toStrategy: StrategyPolicyEvaluator.selectStrategy(toTier),
      reason,
      timestamp: Date.now(),
    });
  }
}
