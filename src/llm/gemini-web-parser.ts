export interface WebToolCall {
  id?: string;
  name: string;
  args: Record<string, any>;
}

let callSeq = 0;

const ARTIFACT_PATTERNS = [/Use code with caution/gi, /Copy code/gi, /Show reasoning/gi, /Đoạn mã/gi];

/** Quét object JSON cân bằng từ vị trí mở ngoặc (tôn trọng chuỗi/escape). */
function balancedJsonAt(src: string, openIdx: number): string | undefined {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return undefined;
}

/** Bắt tool-call JSON trần (code block đã render mất hàng rào ```), chỉ nhận tên trong allowlist. */
function extractBareCalls(text: string, allowedNames?: string[]): { calls: WebToolCall[]; stripped: string } {
  const calls: WebToolCall[] = [];
  const spans: Array<[number, number]> = [];
  const re = /\{\s*"name"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const openIdx = m.index;
    const candidate = balancedJsonAt(text, openIdx);
    if (!candidate) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed?.name !== 'string') continue;
    if (parsed.args !== undefined && (typeof parsed.args !== 'object' || parsed.args === null)) continue;
    if (allowedNames && !allowedNames.includes(parsed.name)) continue;
    if (!allowedNames && typeof parsed.args !== 'object') continue;
    calls.push({ id: `web_${++callSeq}`, name: parsed.name, args: parsed.args ?? {} });
    spans.push([openIdx, openIdx + candidate.length]);
    re.lastIndex = openIdx + candidate.length;
  }
  let stripped = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    stripped = stripped.slice(0, spans[i][0]) + stripped.slice(spans[i][1]);
  }
  return { calls, stripped };
}

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
  const withoutFences = raw.replace(blockRe, '');
  const bare = extractBareCalls(withoutFences, opts?.allowedNames);
  toolCalls.push(...bare.calls);
  const text = stripGeminiWebArtifacts(bare.stripped);
  return { text: text || undefined, toolCalls };
}
