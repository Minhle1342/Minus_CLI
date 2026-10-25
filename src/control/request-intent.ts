/** Lowercase + strip diacritics so literal directives match regardless of casing. */
export function normalizeRequestIntentText(request: string): string {
  return request
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Explicit read-only directives only. A turn is read-only when the user wrote a
 * literal constraint ("read-only", "chỉ đọc", "do not edit"), never because the
 * prose looked like a question. Semantics are the model's job; the harness only
 * parses directives the user actually wrote.
 */
export function isReadOnlyRequest(request?: string | null): boolean {
  if (!request) return false;
  const text = normalizeRequestIntentText(request);
  // Literal commands whose contract is read-only.
  if (/(?:^|[\s,;])(?:\/read-?only|\/open-code-review|\/code-reviewer|\/bug-hunter|--read-only)(?=$|[\s,;])/i.test(text)) return true;
  return /\b(?:read[ -]only|chi doc|do not (?:edit|modify|change)|don['’]t (?:edit|modify|change))\b/.test(text);
}

/** Explicit ask to hand work to child agents (main LLM stays the orchestrator). */
export function hasDelegationIntent(request?: string | null): boolean {
  if (!request) return false;
  const text = normalizeRequestIntentText(request);
  return /\b(?:sub[\s-]?agents?|multi[\s-]?agents?|delegat\w*|orchestrat\w*|swarm|parallel\s+agents?|agents?\s+(?:team|pool|swarm)|(?:spawn|cho|dung|use|run|chay)\s+(?:\d+\s+)?agents?|agents?\s+(?:song song|parallel))\b|uy\s+thac|giao\s+(?:viec|task)|dieu\s+phoi|chia\s+(?:viec|task)|phan\s+(?:ra|chia)\s+(?:task|cong\s+viec)/.test(text);
}

/** Literal `/plan` command or the planning-mode marker; not a prose heuristic. */
export function hasExplicitPlanningDirective(request?: string | null): boolean {
  if (!request) return false;
  return /(?:^|\s)\/plan(?:\s|$)/i.test(request)
    || /\[planning mode request\]/i.test(request);
}
