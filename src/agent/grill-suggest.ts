import type { GrillOption } from '../ui/tea/types.js';
import { Session } from '../session/session.js';

export interface GrillSuggestContext {
  composeQuestion?: string;
  composePhase?: string;
  recentTranscript?: string[];
  /** Session id của tab đang route — phiên gợi ý ephemeral mang id này để trace. */
  sessionId?: string;
  /** Explicit options provided by MCP Elicitation / V2 Form */
  providedOptions?: Array<string | { label: string; detail?: string; text?: string }>;
}

/** Heuristic fallback khi LLM offline — luôn trả về ít nhất 2 phương án. */
export function heuristicGrillOptions(question: string, ctx: GrillSuggestContext = {}): GrillOption[] {
  const q = question.trim() || ctx.composeQuestion || 'Chọn hướng xử lý tiếp theo';
  const base: GrillOption[] = [
    { id: 'a', label: `Chấp nhận đề xuất mặc định cho: ${q.slice(0, 80)}`, detail: 'Nhanh, ít rủi ro, dễ revert', source: 'heuristic' },
    { id: 'b', label: 'Yêu cầu LLM giải thích thêm rồi mới quyết', detail: 'Thêm 1 vòng hỏi-đáp trước khi chốt', source: 'heuristic' },
    { id: 'c', label: 'Tự nhập đáp án riêng (Esc để nhập tay)', detail: 'Giữ toàn quyền quyết định cho user', source: 'user' },
  ];
  if (/test|kiểm thử|verify/i.test(q)) {
    base.unshift({ id: 't', label: 'Chạy npm test trước, chốt sau khi xanh', detail: 'Ưu tiên evidence', source: 'heuristic' });
  }
  return base.slice(0, 5);
}

function parseNumberedList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•\d]+[.)\]:}]*|(?:phương án|option)\s*\d+[:.)-]*)?\s*/i, '').trim())
    .map((line) => line.replace(/^["“”']+|["“”']+$/g, '').trim())
    .filter((line) => line.length >= 2 && line.length <= 220)
    .slice(0, 5);
}

export interface GrillLLM {
  generate?(...args: any[]): Promise<{ text?: string } | string>;
}

export interface GrillUI {
  grillChoose(question: string, options: GrillOption[], sessionId?: string): Promise<string | undefined>;
  setGrillOptions(question: string, options: GrillOption[], sessionId?: string): void;
  dismissGrill(): void;
}

/** Shared open-loading-then-fill flow for /grill-me and model-initiated ask_user / ask_question (MCP Elicitation). */
export async function runGrillFlow(
  ui: GrillUI,
  llm: GrillLLM | undefined,
  question: string,
  ctx: GrillSuggestContext = {},
  sessionId?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;

  // MCP Elicitation & V2 Form: If explicit options are provided, open modal immediately with options
  if (ctx.providedOptions && ctx.providedOptions.length > 0) {
    const directOptions: GrillOption[] = ctx.providedOptions.map((opt, i) => {
      const label = typeof opt === 'string' ? opt.trim() : String(opt?.label || opt?.text || '').trim();
      const detail = typeof opt === 'object' && opt?.detail ? String(opt.detail).trim() : undefined;
      return {
        id: `opt-${i + 1}`,
        label,
        detail,
        source: 'llm' as const,
      };
    }).filter((opt) => opt.label.length > 0);

    if (directOptions.length > 0) {
      const pickPromise = ui.grillChoose(question, directOptions, sessionId);
      const onAbort = () => ui.dismissGrill();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await pickPromise;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  const pickPromise = ui.grillChoose(question, [], sessionId);
  const onAbort = () => ui.dismissGrill();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { options } = await suggestGrillOptions(llm, question, ctx);
    ui.setGrillOptions(question, options, sessionId);
    return await pickPromise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Gọi LLM live để gợi ý 3-5 phương án ngắn gọn; lỗi/timeout → fallback heuristic. */
export async function suggestGrillOptions(
  llm: GrillLLM | undefined,
  question: string,
  ctx: GrillSuggestContext = {},
  timeoutMs = 15000,
): Promise<{ options: GrillOption[]; fromLLM: boolean }> {
  const fallback = () => ({ options: heuristicGrillOptions(question, ctx), fromLLM: false as const });
  if (!llm || typeof (llm as any).generate !== 'function' || !question.trim()) return fallback();
  try {
    const prompt = [
      `Câu hỏi cần quyết định: ${question.trim()}`,
      ctx.composeQuestion ? `Câu hỏi grill hiện tại: ${ctx.composeQuestion}` : '',
      ctx.composePhase ? `Phase Compose: ${ctx.composePhase}` : '',
      ctx.recentTranscript?.length ? `Ngữ cảnh gần nhất:\n${ctx.recentTranscript.slice(-3).join('\n').slice(0, 800)}` : '',
      'Hãy đề xuất 3-5 phương án trả lời ngắn gọn (mỗi dòng 1 phương án, mỗi phương án dưới 25 từ), chỉ liệt kê, không giải thích dài.',
    ]
      .filter(Boolean)
      .join('\n');
    // Session thật: provider generate() đọc history qua getHistory(),
    // object giả {messages} luôn throw → rơi về heuristic.
    const routedId = ctx.sessionId?.trim();
    const grillSession = routedId ? new Session(routedId) : new Session();
    grillSession.addUserMessage(prompt);
    const raw = await Promise.race([
      (llm as any).generate(grillSession, [], {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('grill-suggest-timeout')), timeoutMs)),
    ]);
    const text = typeof raw === 'string' ? raw : String((raw as any)?.text || '');
    const items = parseNumberedList(text);
    if (!items.length) return fallback();
    return {
      options: items.map((label, i) => ({ id: `llm-${i + 1}`, label, source: 'llm' as const })),
      fromLLM: true,
    };
  } catch {
    return fallback();
  }
}
