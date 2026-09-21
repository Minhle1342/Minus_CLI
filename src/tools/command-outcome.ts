/** Semantic result contract for run_command. */
export type CommandOutcome =
  | 'succeeded'
  | 'no_match'
  | 'difference_detected'
  | 'expected_failure'
  | 'blocked_preflight'
  | 'failed_unexpected';

const SEARCH_COMMAND = /^(?:rg|ripgrep|grep|findstr|find|where|which)\b/i;
const GIT_DIFF_WITH_EXIT_CODE = /^git(?:\.exe)?\s+diff\b[^\n]*(?:--exit-code|--quiet)\b/i;

export function isCommandOutcomeBlocked(result: Record<string, any>): boolean {
  return result.commandOutcome === 'blocked_preflight';
}

export function isNonFailingCommandOutcome(result: Record<string, any>): boolean {
  return ['succeeded', 'no_match', 'difference_detected', 'expected_failure', 'blocked_preflight']
    .includes(String(result.commandOutcome || ''));
}

export function classifyCommandOutcome(command: string, result: Record<string, any>): CommandOutcome {
  const existing = String(result.commandOutcome || '');
  if (existing) return existing as CommandOutcome;
  if (result.processStarted === false) return 'blocked_preflight';
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;
  if (exitCode === 0) return 'succeeded';
  if (Array.isArray(result.expectedExitCodes) && exitCode !== undefined && result.expectedExitCodes.includes(exitCode)) {
    return 'expected_failure';
  }
  const normalized = (command || '').trim();
  if (exitCode === 1 && SEARCH_COMMAND.test(normalized)) return 'no_match';
  if (exitCode === 1 && GIT_DIFF_WITH_EXIT_CODE.test(normalized)) return 'difference_detected';
  return 'failed_unexpected';
}

export function annotateCommandResult<T extends Record<string, any>>(command: string, result: T): T & {
  commandOutcome: CommandOutcome;
  processStarted: boolean;
  success: boolean;
} {
  const commandOutcome = classifyCommandOutcome(command, result);
  return {
    ...result,
    commandOutcome,
    processStarted: result.processStarted !== false,
    success: isNonFailingCommandOutcome({ commandOutcome }),
  };
}

export function createPreflightBlockedResult(
  command: string,
  preflightCode: string,
  message: string,
  suggestion?: string,
): Record<string, any> {
  return annotateCommandResult(command, {
    command,
    commandOutcome: 'blocked_preflight',
    processStarted: false,
    preflightCode,
    message,
    ...(suggestion ? { suggestion } : {}),
  });
}
