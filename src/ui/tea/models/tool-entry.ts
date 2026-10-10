/** A short, user-facing projection of tool events for the viewport. */
const MAX_RESULT_CHARS = 2400;
const MAX_LIST_ITEMS = 8;
const MAX_RESULT_LINES = 5;

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
function visibleValue(value: unknown, depth = 0): string {
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

export function toolCallEntry(name: string, args: Record<string, unknown>): string {
  if (name === 'submit_solution') return '● submit_solution';
  const details = ['path', 'filePath', 'targetFile', 'query', 'search_query', 'pattern', 'symbol', 'target', 'url', 'cmd', 'command', 'subcommand']
    .flatMap(key => {
      const value = args?.[key];
      return typeof value === 'string' && value.trim() ? [`${key}: ${preview(value, 160)}`] : [];
    });
  return details.length ? `● ${name} · ${preview(details.join(' · '), 240)}` : `● ${name}`;
}

export function toolResultEntry(name: string, result: Record<string, unknown>, durationMs: number): string {
  // P1: text badges ([OK]/[FAIL]/[DENIED]) so status never depends on color alone.
  const denied = result?.denied === true || result?.status === 'denied';
  const failed = !denied && Boolean(result?.error || result?.errorCode || result?.isError || result?.success === false ||
    (typeof result?.exitCode === 'number' && result.exitCode !== 0) ||
    (typeof result?.exit_code === 'number' && result.exit_code !== 0));
  const badge = denied ? '[DENIED]' : failed ? '[FAIL]' : '[OK]';
  const heading = `${denied ? '⊘' : failed ? '✖' : '✔'} ${name} ${badge} · ${Math.max(0, Math.round(durationMs || 0))}ms`;
  if (name === 'submit_solution' && !failed && !denied) {
    return `${heading}\nCâu trả lời đã được gửi.`;
  }
  // Deterministic repeat bị short-circuit (deduped:true): collapse thành 1 dòng,
  // không lặp lại full FAIL block — chi tiết xem ở lần block đầu tiên.
  if ((result as any)?.deduped === true) {
    return `${heading} · repeated block suppressed (see first occurrence)`;
  }

  const details = visibleValue(result);
  const hasDiff = typeof result?.diff === 'string' || typeof result?.patch === 'string';
  // P1: failures point at the Diff view when there is a patch to inspect.
  const hint = (failed || denied) && hasDiff ? '\n→ Open Diff (Ctrl+X D) to review' : '';
  if (details) return `${heading}\n${resultPreview(details)}${hint}`;
  if (hasDiff) return `${heading}\nDiff available — open with Ctrl+X D`;
  return heading;
}
