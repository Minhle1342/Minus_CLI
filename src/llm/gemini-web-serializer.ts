import type { FunctionDeclaration } from '@google/genai';

export const GEMINI_WEB_OUTPUT_CONTRACT = [
  'When you need a local tool, emit exactly one fenced block per call:',
  '```toolcall-json',
  '{"name":"<tool>","args":{...}}',
  '```',
  'No other tool syntax. Plain text goes outside blocks.',
].join('\n');

export interface WebPayloadInput {
  systemPrompt: string;
  history: Array<{ role: string; parts?: any[] }>;
  tools: FunctionDeclaration[];
  dynamicContext?: string;
  stepSuffixes?: Map<number, string> | Record<number, string>;
}

/**
 * Render Session/tools/context thành text khối cố định cho tab web.
 * shortcut: payload >8000 ký tự chưa upload file ở v1, gọi chia nhỏ phía bridge.
 */
export function serializeGeminiWebPayload(input: WebPayloadInput): string {
  const sections: string[] = [`SYSTEM\n${input.systemPrompt ?? ''}`];
  const toolsJson = JSON.stringify(
    (input.tools ?? []).map((t) => ({ name: t.name, description: (t as any).description, parameters: (t as any).parameters })),
  );
  sections.push(`TOOLS_JSON\n${toolsJson}`);

  const lines: string[] = [];
  for (const item of input.history ?? []) {
    const role = item.role === 'model' ? 'model' : item.role === 'user' ? 'user' : item.role;
    for (const p of item.parts ?? []) {
      if (typeof p?.text === 'string' && p.text) lines.push(`[${role}] ${p.text}`);
      else if (p?.functionCall) lines.push(`[tool:${p.functionCall.name}] call ${JSON.stringify(p.functionCall.args ?? {})}`);
      else if (p?.functionResponse) lines.push(`[tool:${p.functionResponse.name ?? 'result'}] result ${JSON.stringify(p.functionResponse.response ?? {})}`);
    }
  }
  sections.push(`HISTORY\n${lines.join('\n')}`);

  if (input.dynamicContext?.trim()) sections.push(`DYNAMIC_CONTEXT\n${input.dynamicContext.trim()}`);

  const getSuffix = (s: number) =>
    input.stepSuffixes instanceof Map ? input.stepSuffixes.get(s) : (input.stepSuffixes as Record<number, string>)?.[s];
  const suffixes: string[] = [];
  let step = 1;
  for (;;) {
    const s = getSuffix(step);
    if (s === undefined) break;
    if (String(s).trim()) suffixes.push(`[step:${step}] ${String(s).trim()}`);
    step++;
    if (step > 50) break;
  }
  if (suffixes.length > 0) sections.push(`STEP_SUFFIXES\n${suffixes.join('\n')}`);
  sections.push(`OUTPUT_CONTRACT\n${GEMINI_WEB_OUTPUT_CONTRACT}`);
  return sections.join('\n\n');
}
