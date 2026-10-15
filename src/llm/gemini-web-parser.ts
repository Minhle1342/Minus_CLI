export interface WebToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
}

const ARTIFACT_PATTERNS = [/Use code with caution/gi];

/** Bóc fenced toolcall-json, text còn lại strip rác UI web. */
export function parseGeminiWebResponse(raw: string): { text?: string; toolCalls: WebToolCall[] } {
  const toolCalls: WebToolCall[] = [];
  const blockRe = /```toolcall-json\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = blockRe.exec(raw)) !== null) {
    let parsed: any;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      throw new Error('Malformed toolcall-json block from Gemini Web');
    }
    if (!parsed?.name) throw new Error('Tool block missing name');
    toolCalls.push({ id: `call_${Date.now()}_${idx++}`, name: parsed.name, args: parsed.args ?? {} });
  }
  let text = raw.replace(blockRe, '').trim();
  for (const p of ARTIFACT_PATTERNS) text = text.replace(p, '').trim();
  return { text: text || undefined, toolCalls };
}
