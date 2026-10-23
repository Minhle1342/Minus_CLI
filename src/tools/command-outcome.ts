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
    // Blocked results never succeeded, even though blockers stay neutral in
    // failure counters (isNonFailingCommandOutcome still includes them).
    success: commandOutcome === 'blocked_preflight' ? false : isNonFailingCommandOutcome({ commandOutcome }),
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

/**
 * Global runtime state indicating whether Docker isolation is disabled.
 * When disabled, run_command permits all non-destructive commands to run freely on host
 * without being blocked by ISOLATED_SANDBOX_REQUIRED.
 */
let _dockerIsolationDisabled = false;

const SYSTEM_DESTRUCTIVE_PATTERNS = [
  /\brm\s+(?:-[a-z]*r[a-z]*f*|-[a-z]*f[a-z]*r)\s+(?:\/|[a-z]:[\\/])/i,
  /\brmdir\s+\/s\s+\/q\s+[a-z]:[\\/]/i,
  /\b(?:remove-item|ri)\b[^\r\n]*(?:-recurse|-r)[^\r\n]*(?:[a-z]:[\\/]|\\\\)/i,
  /\bformat\s+[a-z]:/i,
  /\b(?:mkfs\.|dd\s+if=.*\bof=[\\/]dev)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

/** Check if command contains system-destructive operations (e.g. format C:, rm -rf /). */
export function isSystemDestructiveCommand(command: string): boolean {
  const normalized = (command || '').trim();
  return SYSTEM_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Check if Docker isolation is currently disabled via runtime state or environment variables. */
export function isDockerIsolationDisabled(): boolean {
  if (_dockerIsolationDisabled) return true;
  const envVal = process.env.MINUS_DISABLE_DOCKER_ISOLATION
    ?? process.env.MINUS_ALLOW_HOST_FALLBACK
    ?? process.env.DOCKER_ISOLATION_DISABLED;
  return envVal === 'true' || envVal === '1';
}

/**
 * Configure whether Docker isolation is disabled.
 * Setting to true allows LLM to run all safe commands freely on host.
 */
export function setDockerIsolationDisabled(disabled: boolean): void {
  _dockerIsolationDisabled = disabled;
  process.env.MINUS_DISABLE_DOCKER_ISOLATION = disabled ? 'true' : 'false';
  process.env.MINUS_ALLOW_HOST_FALLBACK = disabled ? 'true' : 'false';
}

/** Toggle Docker isolation state and return new state. */
export function toggleDockerIsolation(disabled?: boolean): boolean {
  const next = typeof disabled === 'boolean' ? disabled : !isDockerIsolationDisabled();
  setDockerIsolationDisabled(next);
  return next;
}

/**
 * Determines whether a command can bypass Docker container isolation.
 * Returns true if Docker isolation is disabled and command is non-destructive.
 */
export function canBypassDockerIsolation(command: string): boolean {
  if (!isDockerIsolationDisabled()) return false;
  return !isSystemDestructiveCommand(command);
}

