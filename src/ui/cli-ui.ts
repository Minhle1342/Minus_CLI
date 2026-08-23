import path from 'node:path';

// ANSI escape codes for styling without external dependencies
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strikethrough: '\x1b[9m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m',
  brightRed: '\x1b[91m',
  brightBlue: '\x1b[94m',

  // Codex signature palette tokens
  emerald: '\x1b[38;5;48m',
  teal: '\x1b[38;5;50m',
  slate: '\x1b[38;5;244m',
  amber: '\x1b[38;5;214m',
  crimson: '\x1b[38;5;196m',
  purple: '\x1b[38;5;141m',
  indigo: '\x1b[38;5;75m',

  // Background colors
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgBlack: '\x1b[40m',
  bgDarkGray: '\x1b[100m',
  bgGreenDark: '\x1b[48;5;22m',
  bgRedDark: '\x1b[48;5;52m',
};

const c = colors;

const BASE_TYPEWRITER_DELAY_MS = 8;
export const FINAL_ANSWER_CHARACTER_DELAY_MS = BASE_TYPEWRITER_DELAY_MS / 2;

export interface SlashCommandDefinition {
  command: string;
  usage?: string;
  description: string;
  category?: string;
  aliases?: string[];
}

export interface SlashCommandSuggestion extends SlashCommandDefinition {
  matchedBy: 'exact' | 'prefix' | 'contains' | 'fuzzy';
  score: number;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { command: '/model', usage: '/model [id|name]', description: 'Chọn mô hình LLM', category: 'Model & Routing', aliases: ['/modal'] },
  { command: '/workspace', usage: '/workspace [path]', description: 'Xem hoặc đổi workspace', category: 'Workspace', aliases: ['/cd'] },
  { command: '/session', description: 'Xem cấu hình session hiện tại', category: 'Session' },
  { command: '/sessions', usage: '/sessions [open|new|inspect]', description: 'Quản lý các session đã lưu', category: 'Session' },
  { command: '/new-session', description: 'Tạo session hội thoại mới', category: 'Session' },
  { command: '/fork-session', usage: '/fork-session [seq]', description: 'Fork session tại event boundary', category: 'Session' },
  { command: '/sandbox', description: 'Xem trạng thái sandbox', category: 'Execution' },
  { command: '/tasks', description: 'Xem background tasks', category: 'Execution' },
  { command: '/plan', description: 'Xem cây kế hoạch hiện tại', category: 'Planning' },
  { command: '/memory', description: 'Xem bộ nhớ dự án', category: 'Memory' },
  { command: '/tools', description: 'Liệt kê tool đã đăng ký', category: 'Tools' },
  { command: '/status', description: 'Xem trạng thái phiên làm việc', category: 'Telemetry' },
  { command: '/agents', usage: '/agents [resume|stop] [id]', description: 'Xem hoặc điều khiển subagent', category: 'Subagents' },
  { command: '/goal', usage: '/goal [on|off|status|resume|objective]', description: 'Điều khiển Goal Mode', category: 'Goal Mode' },
  { command: '/skills', usage: '/skills [inspect] [id]', description: 'Xem Superpowers skills', category: 'Superpowers' },
  { command: '/capabilities', usage: '/capabilities [category|name|inspect]', description: 'Xem capability catalog', category: 'Superpowers' },
  { command: '/approvals', usage: '/approvals [approve|reject] [id]', description: 'Xử lý yêu cầu phê duyệt', category: 'Security' },
  { command: '/permissions', usage: '/permissions [mode|reset]', description: 'Cấu hình quyền duyệt sửa file/lệnh (always_ask, ask_sensitive, auto_approve, read_only)', category: 'Security', aliases: ['/permission', '/perm'] },
  { command: '/undo', description: 'Hoàn tác checkpoint gần nhất', category: 'Shadow Git', aliases: ['/rollback'] },
  { command: '/checkpoints', description: 'Xem lịch sử checkpoint', category: 'Shadow Git' },
  { command: '/clear', description: 'Xoá màn hình terminal', category: 'General' },
  { command: '/help', description: 'Hiển thị hướng dẫn', category: 'General', aliases: ['/?'] },
  { command: '/exit', description: 'Thoát chương trình', category: 'General', aliases: ['/quit'] },
] as const;

/** Rank prefix and typo-tolerant slash-command suggestions without matching command arguments. */
export function getSlashCommandSuggestions(input: string, limit = 5): SlashCommandSuggestion[] {
  const normalized = input.trimStart().toLowerCase();
  if (!normalized.startsWith('/') || /\s/.test(normalized)) return [];
  const query = normalized;
  if (query === '/') {
    return SLASH_COMMANDS.slice(0, Math.max(0, limit)).map((definition, index) => ({
      ...definition,
      matchedBy: 'prefix',
      score: index,
    }));
  }
  const suggestions = SLASH_COMMANDS.flatMap((definition, catalogIndex) => {
    let best: Pick<SlashCommandSuggestion, 'matchedBy' | 'score'> | undefined;
    for (const candidate of [definition.command, ...(definition.aliases || [])]) {
      const value = candidate.toLowerCase();
      let ranked: Pick<SlashCommandSuggestion, 'matchedBy' | 'score'> | undefined;
      if (value === query) {
        ranked = { matchedBy: 'exact', score: catalogIndex / 1000 };
      } else if (value.startsWith(query)) {
        ranked = { matchedBy: 'prefix', score: 10 + value.length - query.length + catalogIndex / 1000 };
      } else if (query.length > 1 && value.includes(query.slice(1))) {
        ranked = { matchedBy: 'contains', score: 30 + value.indexOf(query.slice(1)) + catalogIndex / 1000 };
      } else if (query.length >= 3) {
        const distance = levenshteinDistance(query, value);
        const maxDistance = query.length <= 5 ? 2 : 3;
        if (distance <= maxDistance) ranked = { matchedBy: 'fuzzy', score: 50 + distance * 5 + catalogIndex / 1000 };
      }
      if (ranked && (!best || ranked.score < best.score)) best = ranked;
    }
    return best ? [{ ...definition, ...best }] : [];
  });
  const ranked = suggestions.sort((left, right) => left.score - right.score);
  const exact = ranked.filter((suggestion) => suggestion.matchedBy === 'exact');
  return (exact.length > 0 ? exact : ranked).slice(0, Math.max(0, limit));
}

export function completeSlashCommand(line: string): [string[], string] {
  const best = getSlashCommandSuggestions(line, 1)[0];
  if (best && line.trimStart().toLowerCase() === best.command.toLowerCase()) return [[], line];
  return [best ? [best.command] : [], line];
}

export interface SlashHintTerminal {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

/** Renders transient hints below readline's active input while preserving its cursor position. */
export class RealtimeSlashCommandHints {
  private static readonly RESERVED_ROWS = 7;
  private visible = false;
  private renderKey?: string;

  constructor(private readonly terminal: SlashHintTerminal) {}

  update(line: string, cursorColumn = line.length + 2): void {
    if (!this.terminal.isTTY) return;
    const suggestions = getSlashCommandSuggestions(line);
    if (suggestions.length === 0) {
      this.clear();
      return;
    }

    const width = Math.max(40, this.terminal.columns || 80);
    const nextRenderKey = `${line}\u0000${width}\u0000${suggestions.map((item) => item.command).join(',')}`;
    if (this.visible && this.renderKey === nextRenderKey) return;
    const commandWidth = Math.min(
      Math.max(12, Math.floor(width * 0.45)),
      Math.max(...suggestions.map((item) => (item.usage || item.command).length)),
    );
    const rows = suggestions.map((item, index) => {
      const label = truncateDisplayText(item.usage || item.command, commandWidth).padEnd(commandWidth);
      const alias = item.aliases?.length ? ` (${item.aliases.join(', ')})` : '';
      const availableDescriptionWidth = Math.max(10, width - commandWidth - 6);
      const description = truncateDisplayText(`${item.description}${alias}`, availableDescriptionWidth);
      const marker = index === 0 ? '›' : ' ';
      return `${c.cyan}${marker}${c.reset} ${c.brightCyan}${c.bold}${label}${c.reset} ${c.dim}${description}${c.reset}`;
    });
    const footer = `${c.gray}  Tab: hoàn thành • Enter: thực thi${c.reset}`;
    this.renderBelowInput(
      [`${c.gray}Gợi ý slash command gần nhất:${c.reset}`, ...rows, footer],
      this.visible ? 0 : RealtimeSlashCommandHints.RESERVED_ROWS,
      cursorColumn,
    );
    this.visible = true;
    this.renderKey = nextRenderKey;
  }

  clear(): void {
    if (!this.terminal.isTTY || !this.visible) return;
    this.renderBelowInput([]);
    this.visible = false;
    this.renderKey = undefined;
  }

  dispose(): void {
    this.clear();
  }

  private renderBelowInput(lines: string[], reserveRows = 0, cursorColumn = 0): void {
    const body = lines.length > 0 ? lines.join('\r\n') : '';
    const reservation = reserveRows > 0
      ? `${'\n'.repeat(reserveRows)}\x1b[${reserveRows}A\r${cursorColumn > 0 ? `\x1b[${cursorColumn}C` : ''}`
      : '';
    this.terminal.write(`\x1b[?25l${reservation}\x1b[s\x1b[1E\x1b[0J${body}\x1b[u\x1b[?25h`);
  }
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index < current.length; index++) previous[index] = current[index];
  }
  return previous[right.length];
}

function truncateDisplayText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

export interface TypewriterOptions {
  delayMs?: number;
  write?: (character: string) => void;
  wait?: (delayMs: number) => Promise<void>;
}

/** Render text one Unicode grapheme at a time so Vietnamese marks and emoji stay intact. */
export async function writeTypewriterText(text: string, options: TypewriterOptions = {}): Promise<void> {
  const delayMs = Math.max(0, options.delayMs ?? FINAL_ANSWER_CHARACTER_DELAY_MS);
  const write = options.write ?? ((character: string) => process.stdout.write(character));
  const wait = options.wait ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const characters = Array.from(segmenter.segment(text), (entry) => entry.segment);

  for (let index = 0; index < characters.length; index++) {
    write(characters[index]);
    if (delayMs > 0 && index < characters.length - 1) await wait(delayMs);
  }
}

export function isToolResultFailure(result: Record<string, any>): boolean {
  return Boolean(
    result.error
    || result.errorCode
    || result.success === false
    || (typeof result.exitCode === 'number' && result.exitCode !== 0),
  );
}

/** Keep tool-call logs readable without implying that the actual argument was truncated. */
export function formatToolArgumentPreview(value: unknown, maxLength = 180): string {
  const serialized = JSON.stringify(value);
  const printable = serialized ?? String(value);
  if (printable.length <= maxLength) return printable;
  const headLength = Math.max(20, Math.floor((maxLength - 1) * 0.65));
  const tailLength = Math.max(12, maxLength - headLength - 1);
  const lineCount = typeof value === 'string' ? value.split(/\r?\n/).length : undefined;
  const metadata = typeof value === 'string'
    ? ` [preview only; full argument sent: ${value.length} chars, ${lineCount} lines]`
    : ` [preview only; full argument sent: ${printable.length} chars]`;
  return `${printable.slice(0, headLength)}…${printable.slice(-tailLength)}${metadata}`;
}

export interface BannerOptions {
  modelName: string;
  workspaceRoot: string;
  maxSteps: number;
  tools: string[];
  sandboxStatus?: string;
  activeBranch?: string;
}

export interface StatusOptions {
  modelName: string;
  workspaceRoot: string;
  maxSteps: number;
  sessionTurns: number;
  sessionFile?: string;
  isGoalMode?: boolean;
  sandboxStatus?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  desc: string;
  recommended?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  // 0. Smart 3-Tier Fallback Router & 9Router Gateway
  {
    id: '0',
    name: 'auto-fallback',
    provider: '3-Tier Smart Router (Chống Rate-Limit)',
    desc: 'Tự động luân chuyển: Gemini ➔ Groq ➔ Cerebras ➔ SambaNova ➔ Pollinations khi bị 429',
    recommended: true,
  },
  {
    id: '9r',
    name: '9router/auto',
    provider: '9Router Gateway (Local Proxy)',
    desc: 'Định tuyến qua 9Router Proxy (localhost:20128/v1) với RTK Token Saver & 40+ providers',
  },

  // 1. Google AI Studio
  {
    id: '1',
    name: 'gemini-3.7-flash',
    provider: 'Google AI Studio',
    desc: 'Model thế hệ mới nhất 2026, tối ưu Coding & Agentic workflow siêu tốc',
    recommended: true,
  },
  {
    id: '2',
    name: 'gemini-3.6-flash',
    provider: 'Google AI Studio',
    desc: 'Bản nâng cấp ổn định, phản hồi nhanh và gọi công cụ chuẩn xác',
  },
  {
    id: '3',
    name: 'gemini-3.5-flash',
    provider: 'Google AI Studio',
    desc: 'Cân bằng hoàn hảo giữa tốc độ, độ thông minh và hiệu năng thực thi',
  },
  {
    id: '4',
    name: 'gemini-3.5-flash-lite',
    provider: 'Google AI Studio',
    desc: 'Bản Lite thế hệ 3.5 siêu nhanh, độ trễ thấp (thay thế 2.5-flash-lite)',
  },
  {
    id: '5',
    name: 'gemini-3.1-flash-lite-preview',
    provider: 'Google AI Studio',
    desc: 'Phản hồi cực nhanh, gọi tool chuẩn xác, siêu nhẹ và tiết kiệm',
  },
  {
    id: '6',
    name: 'gemini-3.1-flash-lite',
    provider: 'Google AI Studio',
    desc: 'Bản Flash Lite chính thức thế hệ 3.1, ổn định và tối ưu tài nguyên',
  },
  {
    id: '7',
    name: 'gemini-flash-latest',
    provider: 'Google AI Studio',
    desc: 'Alias tự động trỏ đến mô hình Gemini Flash mới nhất của Google',
  },

  // 2. Groq Cloud (Free Tier: Siêu tốc độ LPU >500 tokens/s)
  {
    id: '8',
    name: 'groq/llama-3.3-70b-versatile',
    provider: 'Groq Cloud (Free)',
    desc: 'Llama 3.3 70B chạy trên chip LPU siêu tốc ~300 tok/s, rất thông minh',
    recommended: true,
  },
  {
    id: '9',
    name: 'groq/deepseek-r1-distill-llama-70b',
    provider: 'Groq Cloud (Free)',
    desc: 'DeepSeek R1 reasoning suy luận từng bước siêu tốc trên Groq',
  },
  {
    id: '10',
    name: 'groq/llama-3.1-8b-instant',
    provider: 'Groq Cloud (Free)',
    desc: 'Llama 3.1 8B phản hồi tức thì ~600 tokens/s, cực kỳ nhẹ',
  },
  {
    id: '11',
    name: 'groq/gemma2-9b-it',
    provider: 'Groq Cloud (Free)',
    desc: 'Google Gemma 2 9B chạy trên Groq LPU',
  },

  // 3. Cerebras Cloud
  {
    id: '12',
    name: 'cerebras/llama-3.3-70b',
    provider: 'Cerebras Cloud (Free)',
    desc: 'Llama 3.3 70B, tốc độ kỷ lục ~1.800 tok/s, hạn mức 1M tokens/ngày',
  },
  {
    id: '13',
    name: 'cerebras/llama3.1-8b',
    provider: 'Cerebras Cloud (Free)',
    desc: 'Llama 3.1 8B siêu tốc ~2.000 tok/s, 1M tokens/ngày',
  },

  // 4. SambaNova Cloud
  {
    id: '14',
    name: 'sambanova/Meta-Llama-3.1-405B-Instruct',
    provider: 'SambaNova Cloud (Free)',
    desc: 'Model Llama 405B khổng lồ chạy miễn phí cho Developer',
  },
  {
    id: '15',
    name: 'sambanova/Meta-Llama-3.3-70B-Instruct',
    provider: 'SambaNova Cloud (Free)',
    desc: 'Llama 3.3 70B trên kiến trúc chip SN40L cực mạnh',
  },
  {
    id: '16',
    name: 'sambanova/DeepSeek-R1-Distill-Llama-70B',
    provider: 'SambaNova Cloud (Free)',
    desc: 'DeepSeek R1 70B reasoning trên hạ tầng SambaNova',
  },

  // 5. GitHub Models
  {
    id: '17',
    name: 'github/gpt-4o',
    provider: 'GitHub Models (Free)',
    desc: 'GPT-4o chính thức miễn phí qua GitHub Token / Azure endpoint',
  },
  {
    id: '18',
    name: 'github/gpt-4o-mini',
    provider: 'GitHub Models (Free)',
    desc: 'GPT-4o Mini tốc độ cao qua GitHub Token',
  },
  {
    id: '19',
    name: 'github/Mistral-large-2407',
    provider: 'GitHub Models (Free)',
    desc: 'Mistral Large 128k context qua GitHub Models',
  },

  // 6. SiliconFlow
  {
    id: '20',
    name: 'siliconflow/deepseek-ai/DeepSeek-V3',
    provider: 'SiliconFlow (Free)',
    desc: 'DeepSeek V3 671B qua hạ tầng SiliconFlow',
  },
  {
    id: '21',
    name: 'siliconflow/deepseek-ai/DeepSeek-R1',
    provider: 'SiliconFlow (Free)',
    desc: 'DeepSeek R1 suy luận chuyên sâu',
  },
  {
    id: '22',
    name: 'siliconflow/Qwen/Qwen2.5-Coder-32B-Instruct',
    provider: 'SiliconFlow (Free)',
    desc: 'Qwen 2.5 Coder 32B chuyên gia lập trình hàng đầu',
  },

  // 7. Mistral AI
  {
    id: '23',
    name: 'mistral/codestral-latest',
    provider: 'Mistral AI (Free)',
    desc: 'Codestral chuyên gia lập trình của Mistral (Free dev key)',
  },
  {
    id: '24',
    name: 'mistral/mistral-large-latest',
    provider: 'Mistral AI (Free)',
    desc: 'Mistral Large mô hình mạnh nhất của Mistral',
  },

  // 8. OpenRouter
  {
    id: '25',
    name: 'openrouter/free',
    provider: 'OpenRouter (Free)',
    desc: 'Tự động định tuyến sang model miễn phí tốt nhất trên OpenRouter',
  },
  {
    id: '26',
    name: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
    provider: 'OpenRouter (Free)',
    desc: 'Llama 3.3 70B miễn phí qua OpenRouter',
  },
  {
    id: '27',
    name: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'OpenRouter (Free)',
    desc: 'DeepSeek R1 miễn phí qua OpenRouter',
  },
  {
    id: '28',
    name: 'openrouter/google/gemini-2.0-flash-exp:free',
    provider: 'OpenRouter (Free)',
    desc: 'Gemini 2.0 Flash Experimental miễn phí qua OpenRouter',
  },

  // 9. Pollinations AI
  {
    id: '29',
    name: 'pollinations/openai',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'GPT-4o-mini miễn phí 100%, không cần đăng ký tài khoản hay API key',
  },
  {
    id: '30',
    name: 'pollinations/mistral',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'Mistral miễn phí 100%, không cần đăng ký tài khoản hay API key',
  },

  // 10. DeepSeek Direct
  {
    id: '31',
    name: 'deepseek-chat',
    provider: 'DeepSeek Direct',
    desc: 'DeepSeek V3 chính thức (cần key platform.deepseek.com)',
  },
  {
    id: '32',
    name: 'deepseek-reasoner',
    provider: 'DeepSeek Direct',
    desc: 'DeepSeek R1 reasoning chính thức (cần key platform.deepseek.com)',
  },

  // 11. OpenAI Codex CLI Models
  {
    id: 'cs',
    name: 'codex/gpt-5.6-sol',
    provider: 'OpenAI Codex (ChatGPT Plus / API)',
    desc: '☀️ GPT-5.6 Sol: Đỉnh cao suy luận, quy hoạch logic phức tạp & hoàn thiện code tối đa',
    recommended: true,
  },
  {
    id: 'ct',
    name: 'codex/gpt-5.6-terra',
    provider: 'OpenAI Codex (ChatGPT Plus / API)',
    desc: '🌍 GPT-5.6 Terra: Mô hình chủ lực cân bằng tốc độ & chất lượng cho coding hàng ngày',
  },
  {
    id: 'cl',
    name: 'codex/gpt-5.6-luna',
    provider: 'OpenAI Codex (ChatGPT Plus / API)',
    desc: '🌙 GPT-5.6 Luna: Siêu tốc độ, nhẹ, tối ưu cho tác vụ rõ ràng & lặp lại nhanh',
  },
  {
    id: 'c4',
    name: 'codex/o4-mini',
    provider: 'OpenAI Codex (ChatGPT Plus / API)',
    desc: 'o4-mini: Reasoning code thế hệ mới tối ưu cho coding agent',
  },
  {
    id: 'c3',
    name: 'codex/o3-mini',
    provider: 'OpenAI Codex (ChatGPT Plus / API)',
    desc: 'o3-mini: Suy luận chuyên sâu lập trình và giải quyết thuật toán hóc búa',
  },
  {
    id: 'cg',
    name: 'codex/gpt-4o',
    provider: 'OpenAI Codex (ChatGPT Plus / API)',
    desc: 'GPT-4o: Đa năng, xử lý ngữ cảnh lớn & sinh mã ổn định',
  },
];

/**
 * Lớp điều khiển hiển thị Terminal UI/UX chuẩn 100% phong cách OpenAI Codex CLI.
 */
export class CLI {
  /**
   * Hiển thị Banner mở đầu phong cách OpenAI Codex CLI
   */
  static renderBanner(opts: BannerOptions): void {
    console.log(`\n${c.cyan}${c.bold}╭────────────────────────────────────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.emerald}${c.bold}⚡ OPENAI CODEX CLI AGENT${c.reset} ${c.slate}v2.5 (Autonomous Pair Programmer)${c.reset}     ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.dim}Evidence-First • Unified Patch Engine • Closed-Loop Verification${c.reset}       ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}├────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.magenta}🤖 Model:${c.reset}      ${c.bold}${opts.modelName}${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.blue}📂 Workspace:${c.reset}  ${c.dim}${opts.workspaceRoot}${c.reset}`);
    if (opts.activeBranch) {
      console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.indigo}🌿 Branch:${c.reset}     ${c.brightCyan}${opts.activeBranch}${c.reset}`);
    }
    if (opts.sandboxStatus) {
      console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.emerald}🛡️  Sandbox:${c.reset}    ${opts.sandboxStatus}`);
    }
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.yellow}⚡ Max Steps:${c.reset}  ${c.bold}${opts.maxSteps}${c.reset} steps per turn budget`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.green}🛠️  Tools (${opts.tools.length}):${c.reset}  ${c.dim}${opts.tools.slice(0, 10).join(', ')}${opts.tools.length > 10 ? ` ... (+${opts.tools.length - 10} tools)` : ''}${c.reset}`);
    console.log(`${c.cyan}${c.bold}├────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.gray}Nhập ${c.brightCyan}/${c.gray} hoặc ${c.brightCyan}/help${c.gray} để xem menu lệnh nhanh, ${c.brightCyan}/model${c.gray} để đổi LLM model.${c.reset}      ${c.cyan}${c.bold}│${c.reset}`);
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thanh gợi ý lệnh nhanh
   */
  static renderQuickCommands(): void {
    console.log(`\n${c.cyan}${c.bold}╭── ⚡ CODEX SLASH COMMAND PALETTE ──────────────────────────────────────────╮${c.reset}`);
    for (const cmd of SLASH_COMMANDS) {
      const aliasStr = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : '';
      const usageStr = (cmd.usage || cmd.command).padEnd(26);
      console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}${usageStr}${c.reset} ${c.gray}${cmd.description}${aliasStr}${c.reset}`);
    }
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các model có sẵn để người dùng chọn
   */
  static renderModelSelector(currentModel: string): void {
    console.log(`\n${c.magenta}${c.bold}╭── 🤖 DANH SÁCH MÔ HÌNH KHẢ DỤNG (SELECT MODEL) ───────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}                                                                            ${c.magenta}${c.bold}│${c.reset}`);
    
    let lastProvider = '';
    for (const m of AVAILABLE_MODELS) {
      if (m.provider !== lastProvider) {
        lastProvider = m.provider;
        console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}❖ ${m.provider.toUpperCase()}${c.reset}`);
      }

      const isCurrent = m.name === currentModel;
      const marker = isCurrent ? ` ${c.brightGreen}${c.bold}* [ACTIVE]${c.reset}` : '';
      const recBadge = m.recommended ? ` ${c.brightYellow}(Recommended)${c.reset}` : '';
      
      console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightCyan}${c.bold}[${m.id.padStart(2, ' ')}]${c.reset} ${c.bold}${m.name}${c.reset}${recBadge}${marker}`);
      console.log(`${c.magenta}${c.bold}│${c.reset}         ${c.dim}${m.desc}${c.reset}`);
      console.log(`${c.magenta}${c.bold}│${c.reset}`);
    }

    console.log(`${c.magenta}${c.bold}├────────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.gray}👉 Nhập số thứ tự ${c.brightCyan}[1-${AVAILABLE_MODELS.length}]${c.gray} hoặc ${c.brightCyan}tên model bất kỳ${c.gray} để đổi mô hình:${c.reset}         ${c.magenta}${c.bold}│${c.reset}`);
    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị bảng trợ giúp
   */
  static renderHelp(): void {
    console.log(`\n${c.cyan}${c.bold}╭── 📖 OPENAI CODEX CLI COMMAND CATALOG & GUIDE ─────────────────────────────╮${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}                                                                            ${c.cyan}${c.bold}│${c.reset}`);
    
    const byCategory = new Map<string, SlashCommandDefinition[]>();
    for (const cmd of SLASH_COMMANDS) {
      const cat = cmd.category || 'General';
      const list = byCategory.get(cat) || [];
      list.push(cmd);
      byCategory.set(cat, list);
    }

    for (const [category, cmds] of byCategory.entries()) {
      console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}${category.toUpperCase()}:${c.reset}`);
      for (const item of cmds) {
        const usage = (item.usage || item.command).padEnd(28);
        console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.brightCyan}${usage}${c.reset} ${item.description}`);
      }
      console.log(`${c.cyan}${c.bold}│${c.reset}`);
    }

    console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}VÍ DỤ TÁC VỤ THỰC TẾ:${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Tìm trong src xem class AgentLoop ở file nào${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Đọc package.json và giải thích các scripts${c.reset}`);
    console.log(`${c.cyan}${c.bold}│${c.reset}    ${c.gray}> Sửa lỗi trong src/tools/read-file.ts và chạy npm test để kiểm chứng${c.reset}`);
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Liệt kê danh mục Tool
   */
  static renderTools(toolList: Array<{ name: string; description: string }>): void {
    console.log(`\n${c.green}${c.bold}╭── 🛠️  REGISTERED TOOL CATALOG (${toolList.length} Tools) ──────────────────────────╮${c.reset}`);
    for (const tool of toolList) {
      console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}${tool.name.padEnd(24)}${c.reset} ${c.dim}${tool.description.slice(0, 70)}${c.reset}`);
    }
    console.log(`${c.green}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông tin workspace hiện tại
   */
  static renderWorkspaceInfo(workspaceRoot: string): void {
    console.log(`\n${c.blue}${c.bold}╭── 📂 ACTIVE WORKSPACE ─────────────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.bold}Đường dẫn:${c.reset} ${c.brightCyan}${workspaceRoot}${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.gray}Để đổi thư mục, dùng: ${c.cyan}/workspace <đường_dẫn_mới>${c.gray} hoặc ${c.cyan}/cd <path>${c.reset}`);
    console.log(`${c.blue}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông báo khi thay đổi workspace thành công
   */
  static renderWorkspaceChanged(oldPath: string, newPath: string): void {
    console.log(`\n${c.green}${c.bold}╭── 📂 ĐỔI WORKSPACE THÀNH CÔNG ─────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.gray}Thư mục cũ:${c.reset} ${c.dim}${oldPath}${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightGreen}${c.bold}Thư mục mới:${c.reset} ${c.brightCyan}${c.bold}${newPath}${c.reset}`);
    console.log(`${c.green}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các Shadow Git Checkpoints đã lưu
   */
  static renderCheckpoints(checkpoints: Array<{ index: number; timestamp: string; description: string }>): void {
    console.log(`\n${c.yellow}${c.bold}╭── 🛡️  SHADOW GIT CHECKPOINTS HISTORY (${checkpoints.length} Snapshots) ────────────────╮${c.reset}`);
    if (checkpoints.length === 0) {
      console.log(`${c.yellow}${c.bold}│${c.reset}  ${c.dim}Chưa có checkpoint nào được tạo trong phiên làm việc này.${c.reset}`);
    } else {
      for (const cp of checkpoints) {
        console.log(`${c.yellow}${c.bold}│${c.reset}  ${c.brightCyan}#${cp.index}${c.reset} [${c.gray}${cp.timestamp}${c.reset}] ${c.bold}${cp.description}${c.reset}`);
      }
    }
    console.log(`${c.yellow}${c.bold}│${c.reset}`);
    console.log(`${c.yellow}${c.bold}│${c.reset}  ${c.gray}Dùng lệnh ${c.brightCyan}/undo${c.gray} để hoàn tác về checkpoint gần nhất.${c.reset}`);
    console.log(`${c.yellow}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị Cây kế hoạch động với Progress Bar chuẩn Codex CLI
   */
  static renderPlan(tasks: Array<{
    id: number;
    title: string;
    acceptanceCriteria?: string;
    status: string;
    notes?: string;
    evidence?: Array<{ toolName: string; outcome: string }>;
  }>): void {
    if (tasks.length === 0) return;

    const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
    const total = tasks.length;
    const percent = Math.round((completed / total) * 100);
    const barWidth = 20;
    const filledWidth = Math.round((percent / 100) * barWidth);
    const progressBar = `${c.emerald}${'█'.repeat(filledWidth)}${c.slate}${'░'.repeat(barWidth - filledWidth)}${c.reset}`;

    console.log(`\n${c.brightCyan}${c.bold}╭── 📋 DYNAMIC PLAN PROGRESS [${progressBar}] ${c.emerald}${percent}%${c.brightCyan} (${completed}/${total} Steps) ──────╮${c.reset}`);
    console.log(`${c.brightCyan}${c.bold}│${c.reset}`);
    
    for (const t of tasks) {
      let icon = `${c.dim}[ ]${c.reset}`;
      let titleStyle = c.dim;

      if (t.status === 'COMPLETED') {
        icon = `${c.emerald}${c.bold}[✔]${c.reset}`;
        titleStyle = `${c.green}${c.bold}`;
      } else if (t.status === 'IN_PROGRESS') {
        icon = `${c.amber}${c.bold}[⚡]${c.reset}`;
        titleStyle = `${c.brightYellow}${c.bold}`;
      } else if (t.status === 'FAILED') {
        icon = `${c.crimson}${c.bold}[✖]${c.reset}`;
        titleStyle = `${c.red}${c.bold}`;
      } else if (t.status === 'SKIPPED') {
        icon = `${c.slate}[⊘]${c.reset}`;
        titleStyle = `${c.slate}${c.strikethrough}`;
      }

      console.log(`${c.brightCyan}${c.bold}│${c.reset}  ${icon} ${c.bold}${t.id}.${c.reset} ${titleStyle}${t.title}${c.reset}`);
      if (t.status === 'IN_PROGRESS' && t.acceptanceCriteria) {
        console.log(`${c.brightCyan}${c.bold}│${c.reset}      ${c.amber}↳ Criteria:${c.reset} ${c.dim}${t.acceptanceCriteria}${c.reset}`);
      }
      if (t.evidence?.length) {
        const evidence = t.evidence.map((item) => `${c.cyan}${item.toolName}${c.reset}:${c.emerald}${item.outcome}${c.reset}`).join(', ');
        console.log(`${c.brightCyan}${c.bold}│${c.reset}      ${c.slate}↳ Evidence:${c.reset} ${evidence}`);
      }
      if (t.notes) {
        console.log(`${c.brightCyan}${c.bold}│${c.reset}      ${c.dim}↳ ${t.notes}${c.reset}`);
      }
    }

    console.log(`${c.brightCyan}${c.bold}│${c.reset}`);
    console.log(`${c.brightCyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị Unified Diff Highlighted Renderer chuẩn Codex CLI
   */
  static renderDiff(diffText: string, options: { filePath?: string; status?: 'MODIFIED' | 'CREATED' | 'DELETED' } = {}): void {
    const lines = diffText.trim().split('\n');
    const headerTitle = options.filePath ? `📝 ${options.status || 'MODIFIED'}: ${options.filePath}` : '📝 UNIFIED DIFF PATCH';
    
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}${c.bold}╭── ${headerTitle} ─────────────────────────────╮${c.reset}`);
    
    for (const line of lines.slice(0, 30)) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.slate}${line}${c.reset}`);
      } else if (line.startsWith('@@')) {
        console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.brightCyan}${line}${c.reset}`);
      } else if (line.startsWith('+')) {
        console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.emerald}+ ${line.slice(1)}${c.reset}`);
      } else if (line.startsWith('-')) {
        console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.crimson}- ${line.slice(1)}${c.reset}`);
      } else {
        console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.dim}  ${line}${c.reset}`);
      }
    }

    if (lines.length > 30) {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.slate}... (+${lines.length - 30} lines diff)${c.reset}`);
    }
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.teal}╰────────────────────────────────────────────────────────╯${c.reset}`);
  }

  /**
   * Hiển thị cảnh báo Self-Reflection & Debugging Protocol
   */
  static renderReflectionAlert(failures: number, advice?: string): void {
    if (failures < 3) {
      return;
    }
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.amber}${c.bold}⚠️ [Self-Correction Protocol Activated (Consecutive Failures: ${failures})]${c.reset}`);
    if (advice) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}↳ ${advice}${c.reset}`);
    }
  }

  /**
   * Hiển thị Bộ nhớ dài hạn của dự án
   */
  static renderMemory(data: any): void {
    console.log(`\n${c.magenta}${c.bold}╭── 🧠 PROJECT KNOWLEDGE BASE (.codingagent/project-memory.json) ───────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Dự án:${c.reset}       ${c.brightCyan}${data.projectName}${c.reset} (${c.dim}${data.projectType}${c.reset})`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Package Mgr:${c.reset} ${c.yellow}${data.packageManager}${c.reset}`);
    
    const scriptKeys = Object.keys(data.scripts || {});
    if (scriptKeys.length > 0) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Scripts:${c.reset}     ${c.dim}${scriptKeys.map((k: string) => `${k} (npm run ${k})`).slice(0, 4).join(', ')}${c.reset}`);
    }

    const insights = data.learnedInsights || [];
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Kinh nghiệm:${c.reset} ${c.brightGreen}${insights.length} quy ước đã ghi nhớ${c.reset}`);
    if (insights.length > 0) {
      for (const item of insights.slice(-4)) {
        console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightYellow}◆ [${item.key}]${c.reset} ${c.dim}${item.insight}${c.reset}`);
      }
    }

    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị trạng thái môi trường Sandbox
   */
  static renderSandbox(status: any): void {
    console.log(`\n${c.green}${c.bold}╭── 🛡️  EXECUTION SANDBOX STATUS ───────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Provider:${c.reset}        ${c.brightCyan}${status.activeProvider}${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Chế độ:${c.reset}          ${c.yellow}${status.mode.toUpperCase()}${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Cách ly (Isolated):${c.reset} ${status.isIsolated ? `${c.brightGreen}✔ CÔ LẬP HOÀN TOÀN (Docker)` : `${c.yellow}⚠ HOST OS (Có bộ lọc Allowlist)`}${c.reset}`);
    if (status.containerId) {
      console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Container ID:${c.reset}    ${c.dim}${status.containerId}${c.reset}`);
      console.log(`${c.green}${c.bold}│${c.reset}  ${c.bold}Docker Image:${c.reset}    ${c.dim}${status.image}${c.reset}`);
    }
    console.log(`${c.green}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách các Background Tasks đang chạy
   */
  static renderTasks(tasks: Array<{ id: string; command: string; status: string; startedAt: string; pid?: number }>): void {
    console.log(`\n${c.cyan}${c.bold}╭── ⚙️  BACKGROUND PROCESSES & TASKS (${tasks.length}) ────────────────────────╮${c.reset}`);
    if (tasks.length === 0) {
      console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.dim}Không có background task nào đang chạy.${c.reset}`);
    } else {
      for (const t of tasks) {
        const statusBadge = t.status === 'running'
          ? `${c.brightGreen}RUNNING (PID: ${t.pid || 'N/A'})${c.reset}`
          : `${c.gray}STOPPED${c.reset}`;
        console.log(`${c.cyan}${c.bold}│${c.reset}  ${c.bold}[${t.id}]${c.reset} ${c.brightCyan}${t.command}${c.reset} ── ${statusBadge} ${c.dim}(Khởi chạy lúc: ${t.startedAt})${c.reset}`);
      }
    }
    console.log(`${c.cyan}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị trạng thái hiện tại
   */
  static renderStatus(opts: StatusOptions): void {
    const goalStatus = opts.isGoalMode
      ? `${c.brightGreen}${c.bold}ON (Unlimited steps ∞)${c.reset}`
      : `${c.yellow}OFF (${opts.maxSteps} steps)${c.reset}`;

    console.log(`\n${c.magenta}${c.bold}╭── 📊 SESSION TELEMETRY & STATUS ───────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Model:${c.reset}         ${c.brightCyan}${opts.modelName}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Workspace:${c.reset}     ${c.dim}${opts.workspaceRoot}${c.reset}`);
    if (opts.sandboxStatus) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Sandbox:${c.reset}       ${opts.sandboxStatus}`);
    }
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Goal Mode:${c.reset}     ${goalStatus}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Max Steps:${c.reset}     ${c.yellow}${opts.maxSteps} steps${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Session Turns:${c.reset} ${c.green}${opts.sessionTurns} completed${c.reset}`);
    if (opts.sessionFile) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Persisted in:${c.reset}  ${c.dim}${opts.sessionFile}${c.reset}`);
    }
    console.log(`${c.magenta}${c.bold}╰───────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông tin cấu hình phiên làm việc đã lưu trữ
   */
  static renderSessionInfo(data: { modelName?: string; workspacePath?: string; activeSessionId?: string; lastUpdated?: string }, sessionFile: string): void {
    console.log(`\n${c.magenta}${c.bold}╭── 💾 PERSISTED SESSION CONFIG (.codingagent/session.json) ────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Model đã lưu:${c.reset}     ${c.brightCyan}${data.modelName || 'Chưa đặt'}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Workspace đã lưu:${c.reset} ${c.dim}${data.workspacePath || 'Chưa đặt'}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Session đang dùng:${c.reset} ${c.brightCyan}${data.activeSessionId || 'Chưa tạo'}${c.reset}`);
    if (data.lastUpdated) {
      console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Cập nhật lúc:${c.reset}     ${c.gray}${data.lastUpdated}${c.reset}`);
    }
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Tệp lưu trữ:${c.reset}      ${c.dim}${sessionFile}${c.reset}`);
    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị banner khi khởi chạy nhiệm vụ Goal Mode
   */
  static renderGoalBanner(goalText: string): void {
    console.log(`\n${c.magenta}${c.bold}╭── 🎯 AUTONOMOUS GOAL MODE (UNLIMITED STEPS ∞) ─────────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}MỤC TIÊU:${c.reset} ${c.bold}${goalText}${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.gray}Chế độ tự trị không giới hạn số bước (Step limit = ∞) cho tới khi hoàn tất.${c.reset}`);
    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}`);
  }

  /**
   * Hiển thị trạng thái Goal Mode
   */
  static renderGoalStatus(enabled: boolean): void {
    const statusText = enabled ? `${c.brightGreen}${c.bold}BẬT (ON - Unlimited Steps ∞)${c.reset}` : `${c.yellow}${c.bold}TẮT (OFF - Mặc định 30 bước)${c.reset}`;
    console.log(`\n${c.magenta}${c.bold}╭── 🎯 TRẠNG THÁI CHẾ ĐỘ GOAL (GOAL MODE) ───────────────────────────────────╮${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.bold}Trạng thái hiện tại:${c.reset} ${statusText}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}  ${c.gray}Cách dùng:${c.reset}`);
    console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightCyan}/goal <nội dung mục tiêu>${c.reset} : Chạy ngay mục tiêu không giới hạn bước`);
    console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightCyan}/goal on${c.reset}                 : Bật chế độ không giới hạn cho mọi yêu cầu`);
    console.log(`${c.magenta}${c.bold}│${c.reset}    ${c.brightCyan}/goal off${c.reset}                : Tắt chế độ không giới hạn (về 30 bước)`);
    console.log(`${c.magenta}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Đầu mỗi Step trong AgentLoop
   */
  static renderStepHeader(step: number, maxSteps: number): void {
    const isUnlimited = !isFinite(maxSteps) || maxSteps >= 9999;
    const progress = isUnlimited ? `${step}/∞ [GOAL MODE]` : `${step}/${maxSteps}`;
    const bar = '─'.repeat(Math.max(10, 58 - progress.length));
    console.log(`\n${c.blue}${c.bold}╭── ⚡ STEP ${progress} ${bar}${c.reset}`);
  }

  /**
   * Hiển thị trạng thái System 2 trong lúc request tới LLM
   */
  static renderLLMThinking(): void {
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(
      `${c.blue}${c.bold}│${c.reset}  ${c.magenta}${c.bold}💭 Reasoning (System 2):${c.reset} ${c.dim}LLM đang phân tích ngữ cảnh và xác định bước tiếp theo...${c.reset}`,
    );
  }

  /**
   * Hiển thị luồng suy luận nội tâm sâu (System 2 Deep Reasoning / CoT)
   */
  static renderReasoning(thoughtText: string): void {
    if (!thoughtText || !thoughtText.trim()) return;
    const lines = thoughtText.trim().split('\n');
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.magenta}${c.bold}💭 INTERNAL MONOLOGUE (System 2 Deep Reasoning):${c.reset}`);
    for (const line of lines.slice(0, 10)) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}${c.italic}${line}${c.reset}`);
    }
    if (lines.length > 10) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.gray}... (+${lines.length - 10} dòng suy luận CoT)${c.reset}`);
    }
  }

  /**
   * Thông báo hành động model
   */
  static renderModelAction(action: 'tool_call' | 'final_answer' | 'max_steps', detail?: string): void {
    if (action === 'tool_call') {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.brightCyan}⚙️  Action (System 1):${c.reset} ${c.italic}${detail || 'Requesting tool execution...'}${c.reset}`);
    } else if (action === 'final_answer') {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.green}✨ Completed:${c.reset} Ready to provide final response.`);
    } else {
      console.log(`${c.blue}${c.bold}│${c.reset}  ${c.red}⚠️ Circuit Breaker:${c.reset} Max steps reached.`);
    }
  }

  /**
   * Hiển thị Tool Call chuẩn Codex CLI với Diff Preview nếu là tool sửa file
   */
  static renderToolCall(name: string, args: Record<string, any>): void {
    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.brightYellow}🔧 Calling Tool:${c.reset} ${c.bold}${name}${c.reset}`);

    const entries = Object.entries(args);
    entries.forEach(([k, v], idx) => {
      const isLast = idx === entries.length - 1;
      const prefix = isLast ? '└─' : '├─';
      const valStr = formatToolArgumentPreview(v);
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.gray}${prefix}${c.reset} ${c.cyan}${k}:${c.reset} ${c.dim}${valStr}${c.reset}`);
    });

    // Nếu là apply_patch có chứa diff hunk, render trực quan diff
    if (name === 'apply_patch' && typeof args.patch === 'string') {
      CLI.renderDiff(args.patch, { filePath: args.filePath });
    }
  }

  /**
   * Hiển thị Tool Result
   */
  static renderToolResult(name: string, durationMs: number, result: Record<string, any>): void {
    const isError = isToolResultFailure(result);
    const badge = isError ? `${c.red}✖ ERROR` : `${c.green}✔ OK`;

    console.log(`${c.blue}${c.bold}│${c.reset}`);
    console.log(`${c.blue}${c.bold}│${c.reset}  ${c.gray}📥 Result for ${c.bold}${name}${c.reset} [${badge}${c.reset}${c.gray} in ${durationMs}ms]:${c.reset}`);

    if (result.error) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.red}${result.error}${c.reset}`);
    } else if (result.content !== undefined) {
      const lines = String(result.content).split('\n');
      const preview = lines.slice(0, 4).map(l => `     ${c.dim}${l}${c.reset}`).join('\n');
      const more = lines.length > 4 ? `\n     ${c.gray}... (+${lines.length - 4} dòng)${c.reset}` : '';
      console.log(preview + more);
    } else if (result.matches !== undefined) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.green}Tìm thấy ${result.totalMatches || result.matches.length} kết quả khớp.${c.reset}`);
    } else if (result.stdout !== undefined || result.stderr !== undefined) {
      const codeStr = result.exitCode === 0 ? `${c.green}exit: 0` : `${c.red}exit: ${result.exitCode}`;
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.bold}[${codeStr}${c.reset}${c.bold}]${c.reset}`);
      if (result.stdout) {
        const outLines = result.stdout.trim().split('\n').slice(0, 3);
        outLines.forEach((l: string) => console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}${l}${c.reset}`));
      }
      if (result.stderr) {
        const errLines = result.stderr.trim().split('\n').slice(0, 3);
        errLines.forEach((l: string) => console.log(`${c.blue}${c.bold}│${c.reset}     ${c.red}${l}${c.reset}`));
      }
    } else if (result.message) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.brightGreen}${result.message}${c.reset}`);
    } else {
      const resStr = JSON.stringify(result);
      const preview = resStr.length > 100 ? `${resStr.slice(0, 97)}...` : resStr;
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.dim}${preview}${c.reset}`);
    }
    if (result.diagnostic) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.yellow}Diagnosis: ${result.diagnostic}${c.reset}`);
    }
    if (result.suggestion) {
      console.log(`${c.blue}${c.bold}│${c.reset}     ${c.cyan}Next: ${result.suggestion}${c.reset}`);
    }
  }

  /**
   * Cuối mỗi Step trong AgentLoop
   */
  static renderStepFooter(): void {
    console.log(`${c.blue}${c.bold}╰────────────────────────────────────────────────────────────────────────────${c.reset}`);
  }

  /**
   * Format Markdown cơ bản sang Terminal ANSI styling
   */
  static formatMarkdownTerminal(text: string): string {
    return text
      // Headers
      .replace(/^### (.*$)/gm, `${c.brightCyan}${c.bold}❯ $1${c.reset}`)
      .replace(/^## (.*$)/gm, `\n${c.brightYellow}${c.bold}❖ $1${c.reset}`)
      .replace(/^# (.*$)/gm, `\n${c.cyan}${c.bold}══════════ $1 ══════════${c.reset}\n`)
      // Bold & Italic
      .replace(/\*\*(.*?)\*\*/g, `${c.bold}$1${c.reset}`)
      .replace(/\*(.*?)\*/g, `${c.italic}$1${c.reset}`)
      // Inline Code
      .replace(/`([^`]+)`/g, `${c.brightCyan}$1${c.reset}`)
      // Bullet points
      .replace(/^\s*[-*]\s+/gm, `  ${c.emerald}•${c.reset} `)
      .replace(/^\s*\d+\.\s+/gm, `  ${c.yellow}$1.${c.reset} `)
      // Blockquotes & Alerts
      .replace(/^>\s*\[!NOTE\]\s*(.*$)/gm, `  ${c.blue}ℹ NOTE:${c.reset} $1`)
      .replace(/^>\s*\[!IMPORTANT\]\s*(.*$)/gm, `  ${c.amber}⚡ IMPORTANT:${c.reset} $1`)
      .replace(/^>\s*\[!WARNING\]\s*(.*$)/gm, `  ${c.red}⚠️ WARNING:${c.reset} $1`);
  }

  /**
   * Hiển thị Final Answer chuẩn Codex CLI với Grapheme Typewriter Streaming
   */
  static async renderFinalAnswer(answer: string, options: { animate?: boolean } = {}): Promise<void> {
    const content = answer.trim();
    const shouldAnimate = options.animate !== false && Boolean(process.stdout.isTTY);
    
    console.log(`\n${c.green}${c.bold}╭── ✨ FINAL ANSWER ─────────────────────────────────────────────────────────╮${c.reset}\n`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}🔍 Root cause analysis:${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}📝 Files modified:${c.reset}`);
    console.log(`${c.green}${c.bold}│${c.reset}  ${c.brightYellow}${c.bold}✅ Test/build verification commands executed and confirmation of success:${c.reset}\n`);
    
    const formatted = CLI.formatMarkdownTerminal(content);

    if (shouldAnimate) {
      await writeTypewriterText(formatted);
      process.stdout.write('\n');
    } else {
      console.log(formatted);
    }
    console.log(`\n${c.green}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị Telemetry kết thúc lượt thực thi (Turn Execution Summary)
   */
  static renderTurnSummary(telemetry: {
    durationMs: number;
    stepsCount: number;
    filesModified?: string[];
    testsPassed?: boolean;
    sandboxMode?: string;
  }): void {
    const durationSec = (telemetry.durationMs / 1000).toFixed(2);
    const testBadge = telemetry.testsPassed !== undefined
      ? telemetry.testsPassed ? `${c.emerald}✔ PASSED` : `${c.crimson}✖ FAILED`
      : `${c.slate}N/A`;
    const filesCount = telemetry.filesModified?.length || 0;

    console.log(`${c.slate}${c.bold}╭── 📊 TURN TELEMETRY ────────────────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.slate}${c.bold}│${c.reset}  ⏱️  Duration: ${c.bold}${durationSec}s${c.reset}  │  ⚡ Steps: ${c.bold}${telemetry.stepsCount}${c.reset}  │  📝 Mutated: ${c.bold}${filesCount} file(s)${c.reset}  │  🧪 Tests: ${testBadge}${c.reset}`);
    console.log(`${c.slate}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị danh sách Skills và trạng thái kích hoạt
   */
  static renderSkills(skills: any[], activeDecisions: any[] = []): void {
    console.log(`\n${c.cyan}${c.bold}╔════════════════════════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.cyan}${c.bold}║                       🛠️  SUPERPOWERS SKILL REGISTRY                       ║${c.reset}`);
    console.log(`${c.cyan}${c.bold}╚════════════════════════════════════════════════════════════════════════════╝${c.reset}\n`);

    const activeMap = new Map(activeDecisions.map((d: any) => [d.skillId, d]));

    for (const skill of skills) {
      const active = activeMap.get(skill.id);
      const statusBadge = active
        ? active.decision === 'activated'
          ? `${c.green}${c.bold}[ACTIVE]${c.reset}`
          : `${c.yellow}${c.bold}[${active.decision.toUpperCase()}]${c.reset}`
        : `${c.gray}[INSTALLED]${c.reset}`;

      console.log(`  ${statusBadge} ${c.bold}${c.brightCyan}${skill.id}${c.reset} ${c.gray}(v${skill.version})${c.reset} - ${c.white}${skill.name}${c.reset}`);
      console.log(`     ${c.dim}${skill.description}${c.reset}`);
      if (skill.requires && skill.requires.length > 0) {
        console.log(`     ${c.blue}Requires:${c.reset} ${skill.requires.join(', ')}`);
      }
      if (skill.requiredCapabilities && skill.requiredCapabilities.length > 0) {
        console.log(`     ${c.magenta}Capabilities:${c.reset} ${skill.requiredCapabilities.join(', ')}`);
      }
      console.log('');
    }
  }

  /**
   * Hiển thị danh mục Capabilities
   */
  static renderCapabilities(capabilities: any[]): void {
    console.log(`\n${c.cyan}${c.bold}╔════════════════════════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.cyan}${c.bold}║                       ⚡  CAPABILITY CATALOG                               ║${c.reset}`);
    console.log(`${c.cyan}${c.bold}╚════════════════════════════════════════════════════════════════════════════╝${c.reset}\n`);

    const byCat = new Map<string, any[]>();
    for (const cap of capabilities) {
      const list = byCat.get(cap.category) || [];
      list.push(cap);
      byCat.set(cap.category, list);
    }

    for (const [cat, items] of byCat.entries()) {
      console.log(`  ${c.bold}${c.yellow}📂 ${cat.toUpperCase()}${c.reset}`);
      for (const cap of items) {
        const sideEffectColor = cap.sideEffect === 'none' ? c.green : c.red;
        const approvalBadge = cap.requiresApproval ? ` ${c.yellow}[APPROVAL REQUIRED]${c.reset}` : '';
        console.log(`    • ${c.bold}${c.brightCyan}${cap.name}${c.reset} -> ${c.dim}${cap.toolName || 'system'}${c.reset}${approvalBadge}`);
        console.log(`      ${c.gray}Side-effect: ${sideEffectColor}${cap.sideEffect}${c.gray} | Reversible: ${cap.reversible} | Retryable: ${cap.retryable}${c.reset}`);
        console.log(`      ${c.dim}${cap.description}${c.reset}`);
      }
      console.log('');
    }
  }

  /**
   * Hiển thị danh sách yêu cầu phê duyệt
   */
  static renderApprovals(approvals: any[]): void {
    console.log(`\n${c.cyan}${c.bold}╔════════════════════════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.cyan}${c.bold}║                       🛡️  PENDING APPROVALS                                ║${c.reset}`);
    console.log(`${c.cyan}${c.bold}╚════════════════════════════════════════════════════════════════════════════╝${c.reset}\n`);

    if (approvals.length === 0) {
      console.log(`  ${c.green}✔ Không có yêu cầu phê duyệt nào đang chờ.${c.reset}\n`);
      return;
    }

    for (const req of approvals) {
      console.log(`  ${c.yellow}${c.bold}⏳ [${req.id}]${c.reset} Action: ${c.bold}${req.action}${c.reset}`);
      console.log(`     ${c.dim}${req.description}${c.reset}`);
      console.log(`     ${c.gray}Requested at: ${req.requestedAt}${c.reset}\n`);
    }
  }

  /**
   * Hiển thị thông tin trạng thái Permission Policy
   */
  static renderPermissionStatus(mode: string, approvedCount: number): void {
    console.log(`\n${c.brightYellow}${c.bold}🔐 CẤU HÌNH PHÂN QUYỀN (PERMISSION GATEWAY)${c.reset}`);
    console.log(`  ${c.dim}Chế độ hiện tại:${c.reset} ${c.bold}${c.brightCyan}${mode}${c.reset}`);
    console.log(`  ${c.dim}Danh mục đã auto-approve trong phiên:${c.reset} ${c.bold}${approvedCount}${c.reset}`);
    console.log(`  ${c.gray}Các chế độ khả dụng:${c.reset}`);
    console.log(`    - ${c.bold}ask_sensitive${c.reset}  : Hỏi ý kiến khi chỉnh sửa file hoặc chạy lệnh nguy hiểm (Khuyên dùng)`);
    console.log(`    - ${c.bold}always_ask${c.reset}     : Luôn hỏi ý kiến trước mọi thao tác ghi/chạy lệnh`);
    console.log(`    - ${c.bold}auto_approve${c.reset}   : Tự động cho phép tất cả (Không khuyến nghị)`);
    console.log(`    - ${c.bold}read_only${c.reset}      : Chặn hoàn toàn mọi thao tác chỉnh sửa file và chạy lệnh\n`);
  }

  /**
   * Hiển thị khung yêu cầu phê duyệt Permission chuẩn OpenAI Codex CLI
   */
  static renderPermissionPrompt(request: {
    toolName: string;
    category: string;
    target: string;
    summary: string;
    riskLevel: string;
    details?: Record<string, any>;
  }): void {
    const riskColor = request.riskLevel === 'CRITICAL' ? `${c.crimson}${c.bold}` : request.riskLevel === 'HIGH' ? `${c.amber}${c.bold}` : `${c.yellow}${c.bold}`;
    console.log(`\n${c.yellow}╭────────────────────────────────────────────────────────────────────────╮${c.reset}`);
    console.log(`${c.yellow}│${c.reset}  ${c.bold}⚠️  XÁC NHẬN CẤP QUYỀN THỰC THI (CODEX PERMISSION APPROVAL)${c.reset}        ${c.yellow}│${c.reset}`);
    console.log(`${c.yellow}├────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.yellow}│${c.reset}  ${c.dim}Công cụ:${c.reset}     ${c.bold}${request.toolName}${c.reset} (${request.category})`);
    console.log(`${c.yellow}│${c.reset}  ${c.dim}Mục tiêu:${c.reset}    ${c.brightCyan}${request.target}${c.reset}`);
    console.log(`${c.yellow}│${c.reset}  ${c.dim}Mô tả:${c.reset}       ${request.summary}`);
    if (request.details?.misuse) {
      console.log(`${c.yellow}│${c.reset}  ${c.brightMagenta}${c.bold}Gợi ý:${c.reset}       Bấm ${c.bold}'n'${c.reset} để từ chối và ép LLM dùng tool: ${c.brightCyan}${request.details.misuse.tool}${c.reset}`);
    }
    console.log(`${c.yellow}│${c.reset}  ${c.dim}Mức rủi ro:${c.reset}  ${riskColor}[${request.riskLevel}]${c.reset}`);
    console.log(`${c.yellow}├────────────────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.yellow}│${c.reset}  ${c.slate}Phím tắt: ${c.emerald}[y]${c.reset} Duyệt 1 lần • ${c.cyan}[a]${c.reset} Duyệt luôn trong phiên • ${c.red}[n]${c.reset} Từ chối • ${c.dim}[q] Hủy${c.reset}`);
    console.log(`${c.yellow}╰────────────────────────────────────────────────────────────────────────╯${c.reset}`);
  }

  /**
   * Dấu nhắc lệnh người dùng
   */
  static getPromptSymbol(): string {
    return `${c.brightCyan}${c.bold}❯${c.reset} `;
  }
}
