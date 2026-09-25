/**
 * Explicit ellipsis resolution for short conversational follow-ups.
 *
 * Problem: the retrieval/classification pipeline only sees the current turn's
 * raw text (`turnUserRequest`). A follow-up such as "còn trang B thì sao"
 * carries no noun phrase of its own, so BM25/semantic retrieval anchored on
 * that text can miss the inherited topic ("các thành phần") — especially
 * after deep compaction removed the previous turn from visible history.
 *
 * This module is intentionally deterministic and side-effect free: it never
 * mutates the session, only produces an expanded query string used for
 * classification and retrieval. The user's original wording is preserved
 * everywhere else (plan goal, prompts, snapshots).
 */

export interface EllipsisAntecedent {
  userPrompt?: string;
  assistantSummary?: string;
  keyDecisions?: string[];
}

export interface EllipsisResolutionInput {
  current: string;
  /** Older user prompts, oldest-first, excluding the current turn. */
  previousUserPrompts?: string[];
  /** Archived (compacted) turns, newest-first. Fallback when history is pruned. */
  archivedTurns?: EllipsisAntecedent[];
}

export interface EllipsisResolution {
  applied: boolean;
  expandedQuery: string;
  inheritedTopic?: string;
}

/** Follow-ups longer than this are assumed self-contained. */
const MAX_ELLIPTICAL_WORDS = 25;
/** Antecedents shorter than this carry no usable topic. */
const MIN_ANTECEDENT_WORDS = 4;
/** Max previous prompts scanned for a contentful antecedent. */
const MAX_ANTECEDENT_LOOKBACK = 3;
/** Inherited topic is truncated to keep the expanded query bounded. */
const MAX_TOPIC_CHARS = 200;

const SYSTEM_TEXT = /^\s*(\[|👉|\/\w)/;
const VI_LEAD =
  /^(còn|thế còn|thế thì còn|vậy còn|vậy thì|vậy|thế|và)\b/iu;
const VI_TAIL = /(thì sao|thế nào|ra sao|như thế nào)\s*\??\s*$/iu;
const EN_LEAD = /^(what about|how about|and what about|and)\b/i;
const EN_TAIL = /\b(how about|what about)\b[^?]*\?\s*$/i;

function clean(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function isSystemText(text: string): boolean {
  return SYSTEM_TEXT.test(text);
}

/** True when the text itself is an elliptical follow-up (used to skip chains). */
function looksElliptical(text: string): boolean {
  if (!text || isSystemText(text)) return false;
  if (wordCount(text) > MAX_ELLIPTICAL_WORDS) return false;
  return (
    VI_LEAD.test(text) ||
    VI_TAIL.test(text) ||
    EN_LEAD.test(text) ||
    EN_TAIL.test(text)
  );
}

function extractTopic(text: string): string {
  return clean(text).slice(0, MAX_TOPIC_CHARS);
}

function findAntecedent(input: EllipsisResolutionInput): string | undefined {
  const previous = (input.previousUserPrompts || [])
    .slice(-MAX_ANTECEDENT_LOOKBACK)
    .reverse();
  for (const prompt of previous) {
    const cleaned = clean(prompt);
    if (!cleaned || isSystemText(cleaned)) continue;
    if (looksElliptical(cleaned)) continue;
    if (wordCount(cleaned) < MIN_ANTECEDENT_WORDS) continue;
    return extractTopic(cleaned);
  }
  for (const archived of input.archivedTurns || []) {
    const candidate = clean(
      archived.userPrompt ||
        archived.assistantSummary ||
        (archived.keyDecisions || []).join('; '),
    );
    if (!candidate || isSystemText(candidate)) continue;
    if (looksElliptical(candidate)) continue;
    if (wordCount(candidate) < MIN_ANTECEDENT_WORDS) continue;
    return extractTopic(candidate);
  }
  return undefined;
}

export function resolveEllipticalFollowUp(
  input: EllipsisResolutionInput,
): EllipsisResolution {
  const current = clean(input.current || '');
  if (!current || !looksElliptical(current)) {
    return { applied: false, expandedQuery: input.current ?? '' };
  }
  const topic = findAntecedent(input);
  if (!topic) {
    return { applied: false, expandedQuery: current };
  }
  return {
    applied: true,
    inheritedTopic: topic,
    expandedQuery: `${current}\n[ellipsis-resolved-topic: ${topic}]`,
  };
}
