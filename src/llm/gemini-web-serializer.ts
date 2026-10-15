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

function getSuffix(stepSuffixes: WebPayloadInput['stepSuffixes'], s: number): string | undefined {
  const v = stepSuffixes instanceof Map ? stepSuffixes.get(s) : (stepSuffixes as Record<number, string>)?.[s];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function sortedSuffixSteps(stepSuffixes: WebPayloadInput['stepSuffixes']): number[] {
  const keys: number[] = stepSuffixes instanceof Map
    ? [...stepSuffixes.keys()]
    : Object.keys(stepSuffixes ?? {}).map(Number).filter((n) => Number.isFinite(n));
  return [...new Set(keys)].sort((a, b) => a - b);
}

/**
 * Render Session/tools/context thành text khối cố định cho tab web.
 * Suffix bám đúng anchor như prepareContents: S1 vào user mở đầu, S2+ vào tool-result cuối mỗi step.
 * shortcut: payload >8000 ký tự chưa upload file ở v1, gọi chia nhỏ phía bridge.
 */
export function serializeGeminiWebPayload(input: WebPayloadInput): string {
  const sections: string[] = [`SYSTEM\n${input.systemPrompt ?? ''}`];
  const sorted = [...(input.tools ?? [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const toolsJson = JSON.stringify(
    sorted.map((t) => ({ name: t.name, description: (t as any).description, parameters: (t as any).parameters })),
  );
  sections.push(`TOOLS_JSON\n${toolsJson}`);

  const steps = sortedSuffixSteps(input.stepSuffixes);
  const s1 = steps.includes(1) ? getSuffix(input.stepSuffixes, 1) : undefined;
  const later = steps.filter((s) => s !== 1).map((s) => getSuffix(input.stepSuffixes, s)).filter(Boolean) as string[];

  const lines: string[] = [];
  let firstUser = true;
  const history = input.history ?? [];
  let lastToolResultIdx = -1;
  history.forEach((item) => {
    (item.parts ?? []).forEach((p: any) => {
      if (typeof p?.text === 'string' && p.text) {
        const role = item.role === 'model' ? 'model' : 'user';
        const t = String(p.text).replace(/^\[(user|model)[^\]]*\]\s*/gim, '>$1 ');
        lines.push(`[${role}] ${t}`);
        if (role === 'user' && firstUser && s1) {
          lines.push(`[step:1] ${s1}`);
          firstUser = false;
        }
      } else if (p?.functionCall) {
        lines.push(`[model/tool-call:${p.functionCall.name}] ${JSON.stringify(p.functionCall.args ?? {})}`);
      } else if (p?.functionResponse) {
        lines.push(`[user/tool-result:${p.functionResponse.name ?? 'result'}] ${JSON.stringify(p.functionResponse.response ?? {})}`);
        lastToolResultIdx = lines.length - 1;
      }
    });
  });
  for (const [i, s] of later.entries()) {
    const tag = `[step:${steps.filter((x) => x !== 1)[i]}] ${s}`;
    if (lastToolResultIdx >= 0) lines.splice(lastToolResultIdx + 1 + i, 0, tag);
    else lines.push(tag);
  }
  sections.push(`HISTORY\n${lines.join('\n')}`);

  if (input.dynamicContext?.trim()) sections.push(`DYNAMIC_CONTEXT\n${input.dynamicContext.trim()}`);
  sections.push(`OUTPUT_CONTRACT\n${GEMINI_WEB_OUTPUT_CONTRACT}`);
  return sections.join('\n\n');
}
