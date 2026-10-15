export interface WebToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
}

let callSeq = 0;

const ARTIFACT_PATTERNS = [/Use code with caution/gi, /Copy code/gi, /Show reasoning/gi];

export function stripGeminiWebArtifacts(raw: string): string {
  let text = raw;
  for (const p of ARTIFACT_PATTERNS) text = text.replace(p, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** Bóc fenced toolcall-json (kể cả 1 dòng), text còn lại strip rác UI web. */
export function parseGeminiWebResponse(
  raw: string,
  opts?: { allowedNames?: string[] },
): { text?: string; toolCalls: WebToolCall[] } {
  const toolCalls: WebToolCall[] = [];
  const blockRe = /```toolcall-json\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(raw)) !== null) {
    let parsed: any;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      throw new Error('Malformed toolcall-json block from Gemini Web');
    }
    if (!parsed?.name || typeof parsed.name !== 'string') throw new Error('Tool block missing name');
    if (opts?.allowedNames && !opts.allowedNames.includes(parsed.name)) {
      throw new Error(`Unknown tool from Gemini Web: ${parsed.name}`);
    }
    if (parsed.args !== undefined && (typeof parsed.args !== 'object' || parsed.args === null)) {
      throw new Error(`Tool args must be an object: ${parsed.name}`);
    }
    toolCalls.push({ id: `web_${++callSeq}`, name: parsed.name, args: parsed.args ?? {} });
  }
  const text = stripGeminiWebArtifacts(raw.replace(blockRe, ''));
  return { text: text || undefined, toolCalls };
}
