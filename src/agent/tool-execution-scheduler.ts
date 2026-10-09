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

/**
 * Detects whether a tool call is an evidence sink that should be executed
 * AFTER other tools in the same turn/batch.
 *
 * `update_plan_task` with status='COMPLETED' is an evidence sink:
 * it requires observable evidence from prior inspection/mutation/verification
 * tools. If the model invokes it alongside evidence-generating tools in the
 * same turn, reordering it to the end ensures those tools record evidence
 * first, preventing premature gate rejections.
 */
export function isEvidenceSinkTool(call: { name?: string; args?: Record<string, any> }): boolean {
  if (call.name === 'update_plan_task') {
    const status = String(call.args?.status || '').toUpperCase();
    return status === 'COMPLETED';
  }
  return false;
}

/**
 * Reorders tool calls so that evidence sink tools (e.g. update_plan_task with status='COMPLETED')
 * execute after non-sink tools (e.g. read_file, replace_text, run_command).
 *
 * Preserves the stable relative order of non-sink tools and sink tools.
 */
export function reorderScheduledToolCalls<T extends { name?: string; args?: Record<string, any> }>(
  calls: T[],
): T[] {
  if (calls.length <= 1) return calls;
  const hasSink = calls.some(isEvidenceSinkTool);
  const hasNonSink = calls.some((c) => !isEvidenceSinkTool(c));
  if (!hasSink || !hasNonSink) return calls;

  const nonSinks: T[] = [];
  const sinks: T[] = [];
  for (const call of calls) {
    if (isEvidenceSinkTool(call)) {
      sinks.push(call);
    } else {
      nonSinks.push(call);
    }
  }

  return [...nonSinks, ...sinks];
}
