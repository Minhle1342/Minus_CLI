import { isCompletionStub } from './final-answer-guard.js';

export type CompletionRecovery = 'revise-answer' | 'inspect-evidence' | 'execute-task' | 'verify-changes';

export interface CompletionRecoveryOptions {
  reason?: string;
  recovery?: CompletionRecovery;
  hasSubmittedSolution?: boolean;
  /** Gate detail (e.g. the exact verification rejection) so the model can act on it. */
  detail?: string;
  priorAnswerSubstantive?: boolean;
}

/** A substantive latest answer wins, or synthesizes a concise delta on top of a prior substantive answer. */
export function selectFinalAnswer(
  text: string,
  report?: string,
  submission?: string,
  priorSubstantiveAnswer?: string,
): string {
  const latest = text.trim();
  if (latest && !isCompletionStub(latest)) {
    if (
      priorSubstantiveAnswer
      && priorSubstantiveAnswer.trim().length > 150
      && latest.length < priorSubstantiveAnswer.trim().length * 0.6
      && !latest.startsWith(priorSubstantiveAnswer.slice(0, 100))
    ) {
      return `${priorSubstantiveAnswer.trim()}\n\n---\n**Ghi chú bổ sung / Additional Notes:**\n${latest}`;
    }
    return latest;
  }
  return report?.trim() || submission?.trim() || latest;
}

export function buildCompletionRecoveryPrompt(options: CompletionRecoveryOptions): string {
  const recovery = options.hasSubmittedSolution ? 'revise-answer' : options.recovery || 'revise-answer';
  const instruction: Record<CompletionRecovery, string> = {
    'revise-answer': options.priorAnswerSubstantive
      ? 'Your previous substantive answer is recorded. Do NOT re-generate the entire answer or plan from scratch. Provide ONLY the concise correction, missing evidence/disclosure, or brief delta needed to complete the answer.'
      : 'Revise the answer using the evidence already available. Answer at the requested level of detail. No tool call is required to repair wording, length, or format.',
    'inspect-evidence': options.priorAnswerSubstantive
      ? 'Your previous substantive answer is recorded. Do NOT re-generate the entire answer from scratch. Correct the specific unsupported citation or provide only the concise missing details.'
      : 'Correct the specific unsupported reference from existing context, or inspect only the missing source needed for the answer. Label proposals and uncertainty explicitly; no code edit or test is required for a read-only answer.',
    'execute-task': 'Complete the user-authorized work that remains, or replace an inaccurate promise with the findings already established. Use tools only for work still needed; do not expand the task.',
    'verify-changes': 'Run verification appropriate to the actual changes. If verification is blocked, describe the observed failure and the remaining uncertainty honestly.',
  };
  return `[SYSTEM COMPLETION RECOVERY: ${recovery}]: ${options.reason || 'Incomplete answer'}.\n${instruction[recovery]}`
    + (options.detail ? `\n[BLOCKING DETAIL]: ${options.detail}` : '');
}
