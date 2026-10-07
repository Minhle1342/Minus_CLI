export const CONCURRENT_READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_text',
  'inspect_symbol',
  'get_diagnostics',
  'query_call_graph',
  'get_route_map',
  'get_symbol_context_360',
  'get_architecture_topology',
  'find_references',
  'lsp_query',
  'read_url_content',
  'search_web',
  'codegraph_explore',
  'codegraph_search',
  'codegraph_impact',
  'search_codebase_fast',
  'read_compressed_code',
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

export const DEFAULT_MAX_CONCURRENT_READS = 6;

/**
 * Groups only consecutive, explicitly allow-listed reads. Any mutation,
 * command, network call, or unknown tool forms its own sequential barrier.
 * Large read batches are partitioned into bounded chunks (maxConcurrency)
 * to avoid resource exhaustion.
 */
export function partitionToolCalls(
  calls: ScheduledToolCall[],
  concurrentReadsEnabled: boolean,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENT_READS,
): ToolCallPartition[] {
  const partitions: ToolCallPartition[] = [];
  let pendingReads: ScheduledToolCall[] = [];

  const flushReads = (): void => {
    if (pendingReads.length === 0) return;
    if (concurrentReadsEnabled && pendingReads.length > 1) {
      for (let i = 0; i < pendingReads.length; i += maxConcurrency) {
        const chunk = pendingReads.slice(i, i + maxConcurrency);
        partitions.push({
          mode: chunk.length > 1 ? 'concurrent-read' : 'sequential-read',
          calls: chunk,
        });
      }
    } else {
      partitions.push({
        mode: 'sequential-read',
        calls: pendingReads,
      });
    }
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
