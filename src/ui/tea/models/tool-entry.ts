/** A short, user-facing projection of tool events for the viewport. */
import { CONCURRENT_READ_ONLY_TOOLS } from '../../../agent/tool-execution-scheduler.js';
const MAX_RESULT_CHARS = 2400;
const MAX_LIST_ITEMS = 8;
const MAX_RESULT_LINES = 5;
/** Read-only tools render as a single TUI line (call + result); mutations keep full detail. */
const MAX_COMPACT_SUMMARY_CHARS = 120;
const MAX_COMPACT_TARGET_CHARS = 100;

export function isReadOnlyTool(name: string): boolean {
  return CONCURRENT_READ_ONLY_TOOLS.has(name);
}

function preview(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}\n… (more output omitted)` : clean;
}

function resultPreview(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  const firstLines = lines.slice(0, MAX_RESULT_LINES).join('\n');
  const shown = preview(firstLines, MAX_RESULT_CHARS);
  return lines.length > MAX_RESULT_LINES
    ? `${shown}\n… (${lines.length - MAX_RESULT_LINES} lines omitted)`
    : shown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstText(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

/** Read text and common result collections without exposing transport metadata. */
export function visibleValue(value: unknown, depth = 0): string {
  if (depth > 3 || value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      if (trimmed.length >= 200_000) return 'Structured output omitted from viewport';
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return visibleValue(parsed, depth + 1);
      } catch { /* Plain text that resembles JSON remains readable text. */ }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_LIST_ITEMS).map(item => visibleValue(item, depth + 1)).filter(Boolean);
    if (value.length > MAX_LIST_ITEMS) items.push(`… and ${value.length - MAX_LIST_ITEMS} more`);
    return items.join('\n');
  }
  const data = record(value);
  if (!data) return '';

  const location = firstText(data, ['path', 'filePath', 'filename', 'uri', 'title', 'name']);
  const line = typeof data.line === 'number' ? `:${data.line}` : typeof data.lineNumber === 'number' ? `:${data.lineNumber}` : '';
  const snippet = firstText(data, ['snippet', 'preview', 'description']);
  if (location && snippet) return `${location}${line} · ${snippet}`;

  const parts: string[] = [];
  for (const key of ['error', 'message', 'summary', 'stdout', 'stderr', 'output', 'text', 'content', 'matches', 'files', 'items', 'entries', 'structuredContent', 'result', 'data']) {
    if (data[key] == null) continue;
    const text = visibleValue(data[key], depth + 1);
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join('\n') || (location ? `${location}${line}` : '');
}

function primaryTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'filePath', 'targetFile', 'query', 'search_query', 'pattern', 'symbol', 'target', 'url', 'cmd', 'command', 'subcommand']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return preview(value, MAX_COMPACT_TARGET_CHARS);
  }
  return undefined;
}

/** Coerce a line-bound arg (LLM may pass numeric strings) to a finite number. */
function lineNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Resolve a normalized `(startLine, endLine)` range for line-scoped read tools.
 * Prefers explicit args — `offset`/`limit` are normalized to the same two params
 * so raw scope aliases never surface — then falls back to the effective range
 * echoed in the result (e.g. `read_file` always returns its `startLine`/`endLine`).
 * Returns undefined when neither side carries line bounds.
 */
export function lineRangeSuffix(args: Record<string, unknown> | undefined, result: Record<string, unknown>): string | undefined {
  const a = args ?? {};
  let start = lineNumber(a.startLine) ?? lineNumber(a.offset);
  let end = lineNumber(a.endLine);
  if (start !== undefined && end === undefined) {
    const limit = lineNumber(a.limit);
    if (limit !== undefined) end = start + limit - 1;
  }
  if (start === undefined) start = lineNumber((result as Record<string, unknown> | undefined)?.startLine);
  if (end === undefined) end = lineNumber((result as Record<string, unknown> | undefined)?.endLine);
  if (start === undefined && end === undefined) return undefined;
  if (start !== undefined && end !== undefined) return ` (startLine: ${start}, endLine: ${end})`;
  return start !== undefined ? ` (startLine: ${start})` : ` (endLine: ${end})`;
}

export function toolCallEntry(name: string, args: Record<string, unknown>): string {
  if (name === 'submit_solution') return '● submit_solution';
  if (isReadOnlyTool(name)) {
    const target = primaryTarget(args);
    return target ? `› ${name} ${target}` : `› ${name}`;
  }
  const details = ['path', 'filePath', 'targetFile', 'query', 'search_query', 'pattern', 'symbol', 'target', 'url', 'cmd', 'command', 'subcommand']
    .flatMap(key => {
      const value = args?.[key];
      return typeof value === 'string' && value.trim() ? [`${key}: ${preview(value, 160)}`] : [];
    });
  return details.length ? `● ${name} · ${preview(details.join(' · '), 240)}` : `● ${name}`;
}

export function toolResultEntry(name: string, result: Record<string, unknown>, _durationMs?: number, args?: Record<string, unknown>): string {
  // P1: text badges ([OK]/[FAIL]/[DENIED]) so status never depends on color alone.
  const denied = result?.denied === true || result?.status === 'denied';
  const failed = !denied && Boolean(result?.error || result?.errorCode || result?.isError || result?.success === false ||
    (typeof result?.exitCode === 'number' && result.exitCode !== 0) ||
    (typeof result?.exit_code === 'number' && result.exit_code !== 0));
  const badge = denied ? '[DENIED]' : failed ? '[FAIL]' : '[OK]';
  // TUI: no duration in the heading — the event log never persists timing, so
  // hydrated tabs rendered "· 0ms" while live tabs showed real timings.
  const heading = `${denied ? '⊘' : failed ? '✖' : '✔'} ${name} ${badge}`;
  if (name === 'submit_solution' && !failed && !denied) {
    return `${heading}\nCâu trả lời đã được gửi.`;
  }
  // Deterministic repeat bị short-circuit (deduped:true): collapse thành 1 dòng,
  // không lặp lại full FAIL block — chi tiết xem ở lần block đầu tiên.
  if ((result as any)?.deduped === true) {
    return `${heading} · repeated block suppressed (see first occurrence)`;
  }

  // TUI: read-only success collapses to ONE line (no body) so the viewport
  // stays scannable. Line-scoped reads show their normalized range instead of
  // a content excerpt — raw scope params stay hidden.
  if (isReadOnlyTool(name) && !failed && !denied) {
    const range = lineRangeSuffix(args, result);
    if (range) return `${heading}${range}`;
    const firstLine = visibleValue(result).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
    const flat = firstLine.replace(/\s+/g, ' ');
    const brief = flat.length > MAX_COMPACT_SUMMARY_CHARS ? `${flat.slice(0, MAX_COMPACT_SUMMARY_CHARS - 1).trimEnd()}…` : flat;
    return brief ? `${heading} · ${brief}` : heading;
  }

  const details = visibleValue(result);
  const hasDiff = typeof result?.diff === 'string' || typeof result?.patch === 'string';
  // P1: failures point at the Diff view when there is a patch to inspect.
  const hint = (failed || denied) && hasDiff ? '\n→ Open Diff (Ctrl+X D) to review' : '';
  if (details) return `${heading}\n${resultPreview(details)}${hint}`;
  if (hasDiff) return `${heading}\nDiff available — open with Ctrl+X D`;
  return heading;
}

/**
 * Render a `tool:error` event (blocked/aborted calls with no `tool:after`).
 * Never `String()` an object — tool results carry `{ error, errorCode, ... }`
 * with no `.message`, which stringifies to `[object Object]`.
 */
export function toolErrorEntry(name: string, err: unknown): string {
  if (typeof err === 'string') {
    const text = err.trim();
    return text ? `✖ ${name}: ${resultPreview(text)}` : `✖ ${name}`;
  }
  if (err instanceof Error) {
    const text = (err.message || String(err)).trim();
    return text ? `✖ ${name}: ${resultPreview(text)}` : `✖ ${name}`;
  }
  const data = record(err);
  if (data) {
    const details = visibleValue(data);
    if (details) return `✖ ${name}: ${resultPreview(details)}`;
    // Last resort: compact JSON instead of "[object Object]".
    try {
      const json = JSON.stringify(data);
      if (json && json !== '{}') return `✖ ${name}: ${resultPreview(json)}`;
    } catch { /* fall through to bare heading */ }
    return `✖ ${name}`;
  }
  if (err == null) return `✖ ${name}`;
  return `✖ ${name}: ${resultPreview(String(err))}`;
}
