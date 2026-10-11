/**
 * Request Analysis Module
 * Parses and extracts [REQUEST ANALYSIS] blocks from reasoning streams.
 */

export interface RequestAnalysisFields {
  goal?: string;
  scope?: string;
  ambiguities?: string;
  plan?: string;
  risk?: string;
}

/**
 * Extract the [REQUEST ANALYSIS] block the model opens its reasoning with
 * (goal, scope, ambiguities, plan, risk — see CORE_SYSTEM_PROMPT §3). Returns undefined
 * when the model did not include one.
 */
export function extractRequestAnalysis(reasoning: string | undefined | null): string | undefined {
  if (!reasoning) return undefined;
  const match = /\[REQUEST ANALYSIS\]([\s\S]*?)(?:\[\/REQUEST ANALYSIS\]|$)/i.exec(reasoning);
  if (!match) return undefined;
  const block = match[1].trim();
  return block ? block : undefined;
}

/**
 * Parses a [REQUEST ANALYSIS] block into structured fields.
 * Backward compatible: old 3-field blocks (goal/scope/ambiguities) still parse;
 * missing plan/risk simply stay undefined.
 */
export function parseRequestAnalysisFields(block: string | undefined | null): RequestAnalysisFields {
  if (!block?.trim()) return {};
  const fields: RequestAnalysisFields = {};
  let current: keyof RequestAnalysisFields | undefined;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    const m = /^(goal|scope|ambiguit(?:y|ies)|plan|risk)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const value = (m[2] ?? '').trim();
      if (key.startsWith('goal')) { current = 'goal'; fields.goal = value; }
      else if (key.startsWith('scope')) { current = 'scope'; fields.scope = value; }
      else if (key.startsWith('ambig')) { current = 'ambiguities'; fields.ambiguities = value; }
      else if (key.startsWith('plan')) { current = 'plan'; fields.plan = value; }
      else if (key.startsWith('risk')) { current = 'risk'; fields.risk = value; }
    } else if (current && line) {
      fields[current] = ((fields[current] ?? '') + '\n' + line).trim();
    }
  }
  for (const k of Object.keys(fields) as Array<keyof RequestAnalysisFields>) {
    if (!fields[k]?.trim()) delete fields[k];
  }
  return fields;
}
