export interface CompletedTurnCompactionPolicy {
  triggerRatio: number;
  minTokensSaved: number;
  minSavingsRatio: number;
  /** Maximum number of uncompacted completed turns before triggering auto-compaction. */
  maxUncompactedTurns?: number;
  /** Maximum uncompressed characters in older observations before triggering auto-compaction. */
  maxUncompactedChars?: number;
}

export function resolveCompletedTurnCompactionPolicy(
  env: Record<string, string | undefined> = process.env,
): CompletedTurnCompactionPolicy {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  const policy: CompletedTurnCompactionPolicy = {
    triggerRatio: number('MINUS_COMPLETED_TURN_COMPACTION_RATIO', 0.6, 0.01, 1),
    minTokensSaved: number('MINUS_COMPLETED_TURN_MIN_TOKENS_SAVED', 512, 1, Number.MAX_SAFE_INTEGER),
    minSavingsRatio: number('MINUS_COMPLETED_TURN_MIN_SAVINGS_RATIO', 0.1, 0, 1),
  };
  if (env.MINUS_MAX_UNCOMPACTED_TURNS !== undefined) {
    policy.maxUncompactedTurns = number('MINUS_MAX_UNCOMPACTED_TURNS', 4, 1, 50);
  }
  if (env.MINUS_MAX_UNCOMPACTED_CHARS !== undefined) {
    policy.maxUncompactedChars = number('MINUS_MAX_UNCOMPACTED_CHARS', 40000, 1000, 1000000);
  }
  return policy;
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

/** Turn count and observation volume identify backlog; they only drive archive-only checkpoints. */
export function hasTurnCountPressure(
  completedTurnCount: number,
  preserveCount: number,
  policy: CompletedTurnCompactionPolicy,
): boolean {
  const maxAllowed = preserveCount + (policy.maxUncompactedTurns ?? 4);
  return Number.isFinite(completedTurnCount) && completedTurnCount >= maxAllowed;
}

/** Triggers archive-only checkpoints if older observation character volume is heavy. */
export function hasObservationVolumePressure(
  historyChars: number,
  policy: CompletedTurnCompactionPolicy,
): boolean {
  const limit = policy.maxUncompactedChars ?? 40000;
  return Number.isFinite(historyChars) && historyChars >= limit;
}

/** Shared predicate so every path applies the same 75% cache-materiality rule. */
export function isLargeHistoryPrefix(
  historyTokens: number,
  usableInputTokens: number,
): boolean {
  return Number.isFinite(historyTokens) && usableInputTokens > 0
    && historyTokens >= usableInputTokens * 0.75;
}

/**
 * A large prefix loses more cached input than a marginal rewrite returns, so
 * require a bigger share of tokens saved once history dominates the window.
 */
export function resolveEffectiveMinSavingsRatio(
  policy: CompletedTurnCompactionPolicy,
  historyTokens: number,
  usableInputTokens: number,
): number {
  return isLargeHistoryPrefix(historyTokens, usableInputTokens)
    ? Math.max(policy.minSavingsRatio, 0.2)
    : policy.minSavingsRatio;
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
