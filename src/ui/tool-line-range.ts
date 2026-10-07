import { CONCURRENT_READ_ONLY_TOOLS } from '../agent/tool-execution-scheduler.js';

/** Read-only summaries show source coordinates rather than execution latency. */
export function formatToolCompletionMetadata(
  toolName: string,
  args: Record<string, any>,
  result: Record<string, any>,
  durationMs: number,
): string {
  if (!CONCURRENT_READ_ONLY_TOOLS.has(toolName)) {
    return durationMs > 0 ? ` (${durationMs}ms)` : '';
  }
  const starts: number[] = [];
  const ends: number[] = [];
  const add = (item: any) => {
    if (!item || typeof item !== 'object') return;
    const start = item.startLine ?? item.StartLine ?? item.line ?? item.lineNumber;
    const end = item.endLine ?? item.EndLine ?? start;
    if (Number.isInteger(start) && start > 0) starts.push(start);
    if (Number.isInteger(end) && end > 0) ends.push(end);
  };
  add(result);
  for (const item of [...(Array.isArray(result.matches) ? result.matches : []), ...(Array.isArray(result.hits) ? result.hits : [])]) {
    add(item);
    if (Array.isArray(item?.lines)) item.lines.forEach(add);
  }
  if (!starts.length && !ends.length) {
    add({
      startLine: args.startLine ?? args.StartLine ?? args.offset,
      endLine: args.endLine ?? args.EndLine,
    });
  }
  return starts.length || ends.length
    ? ` (startLine: ${starts.length ? Math.min(...starts) : '?'}, endLine: ${ends.length ? Math.max(...ends) : '?'})`
    : '';
}
