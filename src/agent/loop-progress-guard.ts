export interface ToolProgressObservation {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
}

export interface ToolProgressDecision {
  repetitionCount: number;
  message?: string;
  shouldStop: boolean;
}

interface SeenObservation {
  resultFingerprint: string;
  repetitionCount: number;
}

const WORKSPACE_MUTATING_TOOLS = new Set([
  'write_file',
  'replace_text',
  'apply_patch',
  'run_command',
  'create_worktree',
  'remove_worktree',
  'git_commit',
  'git_add',
  'git_push',
  'git_command',
]);

const GUARDED_INSPECTION_TOOLS = new Set([
  'list_files',
  'read_file',
  'search_text',
  'search_codebase_fast',
  'web_search',
  'read_compressed_code',
  'pack_codebase',
  'read_memory',
  'git_status',
  'list_worktrees',
]);

/**
 * Detects successful tool calls that repeatedly return the same observation.
 * State is intentionally scoped to one live turn and reset before each run.
 */
export class LoopProgressGuard {
  private readonly seen = new Map<string, SeenObservation>();

  reset(): void {
    this.seen.clear();
  }

  observe(observation: ToolProgressObservation): ToolProgressDecision {
    const { toolName, args, result } = observation;
    const isFailure = Boolean(
      result.error
      || result.errorCode
      || result.success === false
      || (typeof result.exitCode === 'number' && result.exitCode !== 0),
    );

    if (isFailure && toolName === 'run_command') {
      const groupedEnvironmentFailure = (
        (result.errorCode === 'COMMAND_NOT_FOUND' && result.missingExecutable)
        || (['NATIVE_DEPENDENCY_MISSING', 'PACKAGE_DEPENDENCY_MISSING'].includes(result.errorCode) && result.missingDependency)
      );
      const callFingerprint = stableStringify(groupedEnvironmentFailure
        ? {
            toolName,
            errorCode: result.errorCode,
            missingExecutable: result.missingExecutable,
            missingDependency: result.missingDependency,
          }
        : { toolName, args });
      const resultFingerprint = stableStringify({
        error: result.error,
        errorCode: result.errorCode,
        missingExecutable: result.missingExecutable,
        missingDependency: result.missingDependency,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return this.recordObservation(callFingerprint, resultFingerprint, toolName, true);
    }

    if (isFailure) {
      return { repetitionCount: 0, shouldStop: false };
    }

    if (WORKSPACE_MUTATING_TOOLS.has(toolName)) {
      this.reset();
      return { repetitionCount: 0, shouldStop: false };
    }

    if (!GUARDED_INSPECTION_TOOLS.has(toolName)) {
      return { repetitionCount: 0, shouldStop: false };
    }

    const callFingerprint = stableStringify({ toolName, args });
    const resultFingerprint = stableStringify(result);
    return this.recordObservation(callFingerprint, resultFingerprint, toolName, false);
  }

  private recordObservation(
    callFingerprint: string,
    resultFingerprint: string,
    toolName: string,
    failed: boolean,
  ): ToolProgressDecision {
    const previous = this.seen.get(callFingerprint);
    const repetitionCount = previous?.resultFingerprint === resultFingerprint ? previous.repetitionCount + 1 : 1;
    this.seen.set(callFingerprint, { resultFingerprint, repetitionCount });
    if (repetitionCount < 2) return { repetitionCount, shouldStop: false };

    const message = failed
      ? repetitionCount === 2
        ? `[SYSTEM LOOP GUARD]: The same run_command failure class occurred twice. Treat the environment diagnostic as authoritative; change runtime, image, dependencies, permissions, or command strategy before calling run_command again.`
        : `[SYSTEM LOOP GUARD]: The same run_command failure persisted ${repetitionCount} times. Change strategy now; repeated failure to change strategy will end the turn with an explicit blocker report.`
      : repetitionCount === 2
        ? `[SYSTEM LOOP GUARD]: The identical ${toolName} call returned the same result twice. Treat this observation as authoritative and do not call it again unless a workspace-changing action occurs. An empty workspace is a valid state; proceed by creating the requested project files.`
        : `[SYSTEM LOOP GUARD]: The identical ${toolName} call returned the same result ${repetitionCount} times without progress. Change strategy now; repeated failure to change strategy will end the turn with an explicit blocker report.`;

    return { repetitionCount, message, shouldStop: repetitionCount >= 3 };
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
