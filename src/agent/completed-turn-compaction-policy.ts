export interface CompletedTurnCompactionPolicy {
  triggerRatio: number;
  minTokensSaved: number;
  minSavingsRatio: number;
}

export function resolveCompletedTurnCompactionPolicy(
  env: Record<string, string | undefined> = process.env,
): CompletedTurnCompactionPolicy {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    triggerRatio: number('MINUS_COMPLETED_TURN_COMPACTION_RATIO', 0.6, 0.01, 1),
    minTokensSaved: number('MINUS_COMPLETED_TURN_MIN_TOKENS_SAVED', 512, 1, Number.MAX_SAFE_INTEGER),
    minSavingsRatio: number('MINUS_COMPLETED_TURN_MIN_SAVINGS_RATIO', 0.1, 0, 1),
  };
}

/** Turn count identifies old turns; pressure determines whether to consider pruning. */
export function hasCompletedTurnPressure(
  historyTokens: number,
  maxInputTokens: number,
  policy: CompletedTurnCompactionPolicy,
): boolean {
  return Number.isFinite(historyTokens) && historyTokens > 0
    && Number.isFinite(maxInputTokens) && maxInputTokens > 0
    && historyTokens >= maxInputTokens * policy.triggerRatio;
}

/** Never rewrite the KV prefix for a growing or marginally smaller synopsis. */
export function hasMaterialCompletedTurnSavings(
  originalTokens: number,
  compactedTokens: number,
  policy: CompletedTurnCompactionPolicy,
): boolean {
  const saved = originalTokens - compactedTokens;
  return Number.isFinite(originalTokens) && originalTokens > 0
    && Number.isFinite(compactedTokens) && compactedTokens >= 0
    && saved >= policy.minTokensSaved && saved / originalTokens >= policy.minSavingsRatio;
}
