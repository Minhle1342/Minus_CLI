import type { ModelRequestEnvelope } from './context-budget-manager.js';

/** Both boundary compaction and request preparation use the same reserves. */
export function resolveRequestBudget(envelope: Pick<ModelRequestEnvelope,
  'maxInputTokens' | 'targetInputTokens' | 'outputReserveTokens'>) {
  const targetInputTokens = Math.min(envelope.maxInputTokens,
    Math.max(1, envelope.targetInputTokens ?? envelope.maxInputTokens));
  return {
    usableInputTokens: Math.max(0, envelope.maxInputTokens - envelope.outputReserveTokens),
    targetUsableInputTokens: Math.max(0, targetInputTokens - envelope.outputReserveTokens),
  };
}
