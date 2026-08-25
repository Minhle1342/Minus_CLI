export const CONCURRENT_READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_text',
  'inspect_symbol',
  'get_diagnostics',
]);

export interface ScheduledToolCall {
  index: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallPartition {
  mode: 'concurrent-read' | 'sequential-read' | 'sequential';
  calls: ScheduledToolCall[];
}

export function isConcurrentReadOnlyTool(name: string): boolean {
  return CONCURRENT_READ_ONLY_TOOLS.has(name);
}

/**
 * Groups only consecutive, explicitly allow-listed reads. Any mutation,
 * command, network call, or unknown tool forms its own sequential barrier.
 */
export function partitionToolCalls(
  calls: ScheduledToolCall[],
  concurrentReadsEnabled: boolean,
): ToolCallPartition[] {
  const partitions: ToolCallPartition[] = [];
  let pendingReads: ScheduledToolCall[] = [];

  const flushReads = (): void => {
    if (pendingReads.length === 0) return;
    partitions.push({
      mode: concurrentReadsEnabled && pendingReads.length > 1 ? 'concurrent-read' : 'sequential-read',
      calls: pendingReads,
    });
    pendingReads = [];
  };

  for (const call of calls) {
    if (isConcurrentReadOnlyTool(call.name)) {
      pendingReads.push(call);
      continue;
    }
    flushReads();
    partitions.push({ mode: 'sequential', calls: [call] });
  }
  flushReads();
  return partitions;
}
