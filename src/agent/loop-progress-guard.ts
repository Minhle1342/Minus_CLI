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
  'run_command',
  'create_worktree',
  'remove_worktree',
  'git_commit',
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

    if (result.error || result.errorCode) {
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
    const previous = this.seen.get(callFingerprint);
    const repetitionCount = previous?.resultFingerprint === resultFingerprint
      ? previous.repetitionCount + 1
      : 1;

    this.seen.set(callFingerprint, { resultFingerprint, repetitionCount });

    if (repetitionCount < 2) {
      return { repetitionCount, shouldStop: false };
    }

    const message = repetitionCount === 2
      ? `[SYSTEM LOOP GUARD]: The identical ${toolName} call returned the same result twice. Treat this observation as authoritative and do not call it again unless a workspace-changing action occurs. An empty workspace is a valid state; proceed by creating the requested project files.`
      : `[SYSTEM LOOP GUARD]: The identical ${toolName} call returned the same result ${repetitionCount} times without progress. This turn is being stopped to prevent an infinite tool loop.`;

    return {
      repetitionCount,
      message,
      shouldStop: repetitionCount >= 3,
    };
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
