import type { ReasoningTier, ReasoningStrategy } from '../control-plane-state.js';

export interface TierConfig {
  tier: ReasoningTier;
  strategy: ReasoningStrategy;
  tokenBudget: number;
  description: string;
  allowParallelSearch: boolean;
  requireExplicitHypothesis: boolean;
  requireDeepCausalAnalysis: boolean;
}

export const STRATEGY_POLICIES: Record<ReasoningTier, TierConfig> = {
  0: {
    tier: 0,
    strategy: 'DIRECT',
    tokenBudget: 0,
    description: 'Tier 0: Direct inspection and straightforward mutation for trivial tasks.',
    allowParallelSearch: false,
    requireExplicitHypothesis: false,
    requireDeepCausalAnalysis: false,
  },
  1: {
    tier: 1,
    strategy: 'STRUCTURED',
    tokenBudget: 2048,
    description: 'Tier 1: Structured mini-plan with targeted diagnostics and verification.',
    allowParallelSearch: false,
    requireExplicitHypothesis: false,
    requireDeepCausalAnalysis: false,
  },
  2: {
    tier: 2,
    strategy: 'HYPOTHESIS_TEST',
    tokenBudget: 8192,
    description: 'Tier 2: Explicit hypothesis formulation, predicted observations, and falsification test.',
    allowParallelSearch: false,
    requireExplicitHypothesis: true,
    requireDeepCausalAnalysis: false,
  },
  3: {
    tier: 3,
    strategy: 'DEEP_CAUSAL',
    tokenBudget: 16384,
    description: 'Tier 3: Deep causal dependency analysis, call graph inspection, multiple competing hypotheses.',
    allowParallelSearch: false,
    requireExplicitHypothesis: true,
    requireDeepCausalAnalysis: true,
  },
  4: {
    tier: 4,
    strategy: 'SPECULATIVE_SEARCH',
    tokenBudget: 32768,
    description: 'Tier 4: Parallel hypothesis branches with isolated speculative worktrees and expanded verification.',
    allowParallelSearch: true,
    requireExplicitHypothesis: true,
    requireDeepCausalAnalysis: true,
  },
};

export class StrategyPolicyEvaluator {
  static getTierConfig(tier: ReasoningTier): TierConfig {
    return STRATEGY_POLICIES[tier] || STRATEGY_POLICIES[1];
  }

  static selectStrategy(tier: ReasoningTier): ReasoningStrategy {
    return this.getTierConfig(tier).strategy;
  }
}
