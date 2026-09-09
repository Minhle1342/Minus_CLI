import { isCompletionStub } from './final-answer-guard.js';

export type CompletionRecovery = 'revise-answer' | 'inspect-evidence' | 'execute-task' | 'verify-changes';

/** A substantive latest answer wins, even when an earlier report is longer. */
export function selectFinalAnswer(text: string, report?: string, submission?: string): string {
  const latest = text.trim();
  if (latest && !isCompletionStub(latest)) return latest;
  return report?.trim() || submission?.trim() || latest;
}

export function buildCompletionRecoveryPrompt(options: {
  reason?: string;
  recovery?: CompletionRecovery;
  hasSubmittedSolution?: boolean;
}): string {
  const recovery = options.hasSubmittedSolution ? 'revise-answer' : options.recovery || 'revise-answer';
  const instruction: Record<CompletionRecovery, string> = {
    'revise-answer': 'Revise the answer using the evidence already available. Answer at the requested level of detail. No tool call is required to repair wording, length, or format.',
    'inspect-evidence': 'Correct the specific unsupported reference from existing context, or inspect only the missing source needed for the answer. Label proposals and uncertainty explicitly; no code edit or test is required for a read-only answer.',
    'execute-task': 'Complete the user-authorized work that remains, or replace an inaccurate promise with the findings already established. Use tools only for work still needed; do not expand the task.',
    'verify-changes': 'Run verification appropriate to the actual changes. If verification is blocked, describe the observed failure and the remaining uncertainty honestly.',
  };
  return `[SYSTEM COMPLETION RECOVERY: ${recovery}]: ${options.reason || 'Incomplete answer'}.\n${instruction[recovery]}`;
}
