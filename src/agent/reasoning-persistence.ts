export type ReasoningPersistKind = 'failure' | 'high-risk' | 'debug';

export interface ReasoningPersistContext {
  thought: string;
  /** A verification command failed, a gate rejected completion, or a hypothesis was falsified. */
  failure?: boolean;
  /** Why it failed, for the trigger field (e.g. 'verification-failed', gate reason). */
  failureTrigger?: string;
  /** Blast risk HIGH/CRITICAL, or a sensitive path was touched. */
  highRisk?: boolean;
  /** Why it is high-risk, for the trigger field. */
  highRiskTrigger?: string;
  /** MINUS_REASONING_LOG-style explicit audit mode. */
  debugLogEnabled?: boolean;
}

export interface ReasoningPersistDecision {
  persist: boolean;
  kind?: ReasoningPersistKind;
  trigger?: string;
}

/**
 * Decides whether a full model thought is worth persisting, and why.
 * Pure function over harness-measured signals — never LLM self-assessment.
 * Priority: failure > high-risk > debug. Empty thoughts never persist.
 * The cheap always-on intent line is handled separately by the caller via
 * the step summary, not through this gate.
 */
export function shouldPersistReasoning(ctx: ReasoningPersistContext): ReasoningPersistDecision {
  if (!ctx.thought || !ctx.thought.trim()) return { persist: false };
  if (ctx.failure) {
    return { persist: true, kind: 'failure', trigger: ctx.failureTrigger || 'failure' };
  }
  if (ctx.highRisk) {
    return { persist: true, kind: 'high-risk', trigger: ctx.highRiskTrigger || 'high-risk-mutation' };
  }
  if (ctx.debugLogEnabled) {
    return { persist: true, kind: 'debug', trigger: 'debug-audit-mode' };
  }
  return { persist: false };
}
