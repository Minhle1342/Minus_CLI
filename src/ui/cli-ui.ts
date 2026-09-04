import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import { FileMentionEngine, AttachedItemSummary } from '../workspace/file-attachment.js';
import { TreeScanResult, TreeNode, getFileExtensionBadge } from '../workspace/tree-explorer.js';
import { ContextInspectionReport } from '../context/context-inspector.js';

export interface UICollapsePreferences {
  thinking: boolean;
  tools: boolean;
  diff: boolean;
  treeDepth: number;
  compactSteps?: boolean;
}

export const DEFAULT_COLLAPSE_PREFERENCES: UICollapsePreferences = {
  thinking: true,
  tools: true,
  diff: false,
  treeDepth: 3,
  compactSteps: false,
};

// ANSI escape codes for styling
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strikethrough: '\x1b[9m',

  // Monospace Palette
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

  // Minimalist Precision Accents
  emerald: '\x1b[38;5;48m',
  teal: '\x1b[38;5;50m',
  slate: '\x1b[38;5;244m',
  amber: '\x1b[38;5;214m',
  crimson: '\x1b[38;5;196m',
  purple: '\x1b[38;5;141m',
  indigo: '\x1b[38;5;75m',

  // TrueColor Accents
  geminiCyan: '\x1b[38;2;36;200;219m',
  geminiBlue: '\x1b[38;2;66;133;244m',
  geminiPurple: '\x1b[38;2;161;110;255m',
  geminiAmber: '\x1b[38;2;251;188;4m',
  geminiGreen: '\x1b[38;2;52;168;83m',
  geminiRed: '\x1b[38;2;234;67;53m',
  subtleBorder: '\x1b[38;2;75;85;99m',
  mutedText: '\x1b[38;2;156;163;175m',
  cardBg: '\x1b[48;2;30;35;45m',

  // Backgrounds
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgBlack: '\x1b[40m',
  bgDarkGray: '\x1b[100m',
  bgGreenDark: '\x1b[48;5;22m',
  bgRedDark: '\x1b[48;5;52m',
};

export const c = colors;

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
  { command: '/compose', usage: '/compose <objective>|status|abort|answer <text>', description: 'Spec-driven lifecycle in an isolated worktree', category: 'Planning' },
  { command: '/compose-next', usage: '/compose-next [grill answer]', description: 'Advance Compose by one legal phase', category: 'Planning' },
  { command: '/model', usage: '/model [id|name]', description: 'Chọn mô hình LLM', category: 'Model & Routing', aliases: ['/modal'] },
  { command: '/tokens', usage: '/tokens [low|medium|high|max|output|input|thinking|reset] [val]', description: 'Chọn gói cấu hình sẵn (low/medium/high/max) hoặc chỉnh token', category: 'Model & Routing', aliases: ['/token', '/token-budget'] },
  { command: '/workspace', usage: '/workspace [path]', description: 'Xem hoặc đổi workspace', category: 'Workspace', aliases: ['/cd'] },
  { command: '/session', description: 'Xem cấu hình session hiện tại', category: 'Session' },
  { command: '/sessions', usage: '/sessions [open|new|inspect]', description: 'Quản lý các session đã lưu', category: 'Session' },
  { command: '/new-session', description: 'Tạo session hội thoại mới', category: 'Session' },
  { command: '/fork-session', usage: '/fork-session [seq]', description: 'Fork session tại event boundary', category: 'Session' },
  { command: '/sandbox', description: 'Xem trạng thái sandbox', category: 'Execution' },
  { command: '/tasks', description: 'Xem background tasks', category: 'Execution' },
  { command: '/queue', usage: '/queue [list|cancel <id>|clear|add <text>]', description: 'Quản lý hàng đợi tin nhắn Queued Messages (Antigravity-style)', category: 'Execution', aliases: ['/q'] },
  { command: '/steer', usage: '/steer <yêu cầu điều chỉnh>', description: 'Đưa tin nhắn vào hàng đợi để bẻ lái Agent ngay trong bước kế tiếp', category: 'Execution' },
  { command: '/cancel', usage: '/cancel [all|goal|tasks|subagents]', description: 'Hủy tác vụ/goal/subagent đang chạy (hoặc bấm Ctrl+C / Esc trong khi thực thi)', category: 'Execution', aliases: ['/stop', '/abort'] },
  { command: '/resume', description: 'Tiếp tục thông minh tác vụ/kế hoạch/goal bị gián đoạn (One-Click Resume)', category: 'Execution', aliases: ['/continue'] },
  { command: '/plan', usage: '/plan [resume|<yêu cầu tác vụ>]', description: 'Xem, lập kế hoạch chi tiết hoặc tiếp tục kế hoạch bị gián đoạn', category: 'Planning' },
  { command: '/memory', description: 'Xem bộ nhớ dự án', category: 'Memory' },
  { command: '/dream', usage: '/dream [run|preview|status]', description: 'Hợp nhất bộ nhớ nền bằng mistral/codestral-latest', category: 'Memory' },
  { command: '/tools', description: 'Liệt kê tool đã đăng ký', category: 'Tools' },
  { command: '/cache', description: 'Xem chẩn đoán cơ chế Prompt Caching (MINUS standard)', category: 'Telemetry', aliases: ['/prompt-cache'] },
  { command: '/status', description: 'Xem trạng thái phiên làm việc', category: 'Telemetry' },
  { command: '/agents', usage: '/agents [resume|stop] [id]', description: 'Xem hoặc điều khiển subagent', category: 'Subagents' },
  { command: '/goal', usage: '/goal [on|off|status|plan|resume|pause|complete|objective]', description: 'Vòng lặp tự trị dài hạn (Ralph Loop) khớp nối với cây kế hoạch /plan', category: 'Goal Mode' },
  { command: '/skills', usage: '/skills [inspect] [id]', description: 'Xem Superpowers skills', category: 'Superpowers' },
  { command: '/capabilities', usage: '/capabilities [category|name|inspect]', description: 'Xem capability catalog', category: 'Superpowers' },
  { command: '/approvals', usage: '/approvals [approve|reject] [id]', description: 'Xử lý yêu cầu phê duyệt', category: 'Security' },
  { command: '/permissions', usage: '/permissions [mode|reset]', description: 'Cấu hình quyền duyệt sửa file/lệnh (always_ask, ask_sensitive, auto_approve, read_only)', category: 'Security', aliases: ['/permission', '/perm'] },
  { command: '/undo', description: 'Hoàn tác checkpoint gần nhất', category: 'Shadow Git', aliases: ['/rollback'] },
  { command: '/checkpoints', description: 'Xem lịch sử checkpoint', category: 'Shadow Git' },
  { command: '/diff', description: 'Xem unified diff của task hiện tại', category: 'Shadow Git' },
  { command: '/evidence', description: 'Xem bằng chứng verification hiện tại', category: 'Telemetry' },
  { command: '/impact', usage: '/impact [path] [symbol]', description: 'Phân tích phạm vi ảnh hưởng (Blast Radius)', category: 'Tools' },
  { command: '/image', usage: '/image <path> [prompt]', description: 'Nạp và phân tích ảnh trực quan (Vision / Multimodal)', category: 'Vision', aliases: ['/vision', '/img'] },
  { command: '/collapse', usage: '/collapse [thinking|tools|diff|on|off|status]', description: 'Quản lý thu gọn/mở rộng các khối suy luận CoT và tool outputs', category: 'UI & Display', aliases: ['/fold'] },
  { command: '/explore', usage: '/explore [tree|context|reasoning|memory|tools|tasks] [args]', description: 'Khám phá sâu cây thư mục, ngữ cảnh tác nhân, hoặc chuỗi suy luận', category: 'Exploration', aliases: ['/inspect'] },
  { command: '/tree', usage: '/tree [path] [depth]', description: 'Xem cây cấu trúc thư mục dự án phân cấp với kích thước tệp', category: 'Workspace', aliases: ['/dirtree'] },
  { command: '/context', usage: '/context [inspect|prune|compact]', description: 'Kiểm soát và phân tích các tầng token trong Context Window', category: 'Context', aliases: ['/ctx'] },
  { command: '/clear', description: 'Xoá màn hình terminal', category: 'General' },
  { command: '/help', description: 'Hiển thị hướng dẫn', category: 'General', aliases: ['/?'] },
  { command: '/exit', description: 'Thoát chương trình', category: 'General', aliases: ['/quit'] },
] as const;

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

export function getSlashCommandSuggestions(input: string, limit = 5): SlashCommandSuggestion[] {
  const normalized = input.trimStart().toLowerCase();
  if (!normalized.startsWith('/') || /\s/.test(normalized)) return [];
  const query = normalized;
  if (query === '/') {
    return SLASH_COMMANDS.slice(0, Math.max(0, limit)).map((definition, index) => ({
      ...definition,
      matchedBy: 'prefix' as const,
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

export class RealtimeSlashCommandHints {
  private static readonly RESERVED_ROWS = 7;
  private visible = false;
  private renderedRows = 0;
  private renderKey?: string;

  constructor(
    private readonly terminal: SlashHintTerminal,
    private readonly getWorkspace?: () => Workspace | undefined,
    private readonly getModelInfo?: () => { modelName: string; effort?: string },
    private readonly getPromptWidth: () => number = () => 2,
  ) {}

  update(line: string, cursorIndex?: number, cursorColumn?: number): void {
    if (!this.terminal.isTTY) return;

    const charIndex = cursorIndex !== undefined ? cursorIndex : line.length;
    const promptWidth = this.getPromptWidth();
    const activeColumn = cursorColumn !== undefined
      ? cursorColumn
      : promptWidth + getVisibleWidth(line.slice(0, charIndex));

    const workspace = this.getWorkspace ? this.getWorkspace() : undefined;

    if (workspace) {
      const activeMention = FileMentionEngine.extractActiveMention(line, charIndex);
      if (activeMention) {
        const suggestions = FileMentionEngine.getFileSuggestions(line, workspace, charIndex, 5);
        if (suggestions.length > 0) {
          const width = Math.max(40, this.terminal.columns || 80);
          const nextRenderKey = `@\u0000${line}\u0000${charIndex}\u0000${width}\u0000${suggestions.map((s) => s.displayPath).join(',')}`;
          if (this.visible && this.renderKey === nextRenderKey) return;

          const rows = suggestions.map((item, index) => {
            const icon = item.type === 'directory' ? '📁' : '📄';
            const pathLabel = truncateDisplayText(item.displayPath, Math.floor(width * 0.55));
            const sizeInfo = item.type === 'directory'
              ? `${c.brightYellow}(Thư mục)${c.reset}`
              : item.sizeBytes ? `${c.slate}(${(item.sizeBytes / 1024).toFixed(1)} KB)${c.reset}` : '';
            const marker = index === 0 ? '›' : ' ';
            return `${c.cyan}${marker}${c.reset} ${icon} ${c.brightCyan}${c.bold}${pathLabel}${c.reset} ${sizeInfo}`;
          });

          const footer = `${c.slate}  [Tab] Hoàn thành @path • [Esc] Đóng${c.reset}`;
          this.renderBelowInput(
            [`${c.brightCyan}${c.bold}📎 GỢI Ý ĐÍNH KÈM FILE / THƯ MỤC (@):${c.reset}`, ...rows, footer],
            activeColumn,
          );
          this.visible = true;
          this.renderKey = nextRenderKey;
          return;
        }
      }
    }

    if (line.trimStart().startsWith('/')) {
      const suggestions = getSlashCommandSuggestions(line);
      if (suggestions.length > 0) {
        const width = Math.max(40, this.terminal.columns || 80);
        const nextRenderKey = `/\u0000${line}\u0000${charIndex}\u0000${width}\u0000${suggestions.map((item) => item.command).join(',')}`;
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
          return `${c.geminiCyan}${marker}${c.reset} ${c.brightCyan}${c.bold}${label}${c.reset} ${c.mutedText}${description}${c.reset}`;
        });
        const footer = `${c.slate}  [Tab] Hoàn thành • [Enter] Thực thi • [/help] Trợ giúp${c.reset}`;
        this.renderBelowInput(
          [`${c.brightCyan}${c.bold}⚡ GỢI Ý LỆNH NHANH (SLASH COMMANDS):${c.reset}`, ...rows, footer],
          activeColumn,
        );
        this.visible = true;
        this.renderKey = nextRenderKey;
        return;
      }
    }

    this.clear(activeColumn);
  }

  clear(cursorColumn = 0): void {
    if (!this.terminal.isTTY || !this.visible) return;
    this.renderBelowInput([], cursorColumn);
    this.visible = false;
    this.renderKey = undefined;
  }

  dispose(): void {
    this.clear();
  }

  private renderBelowInput(lines: string[], cursorColumn = 0): void {
    const prevRows = this.renderedRows;
    const nextRows = lines.length;
    const maxRows = Math.max(prevRows, nextRows);

    if (maxRows === 0 && nextRows === 0) return;

    let buf = '\x1b[?25l'; // Ẩn con trỏ

    // 1. Đặt chỗ (reservation) trước khi lưu con trỏ nếu popup chưa hiển thị.
    // Nếu prompt ở đáy viewport của terminal, việc này buộc buffer cuộn trước
    // để các dòng hint sau đó ghi đè trực tiếp mà không gây trôi dòng (scroll drift).
    if (!this.visible && nextRows > 0) {
      const reserve = Math.max(RealtimeSlashCommandHints.RESERVED_ROWS, nextRows);
      for (let i = 0; i < reserve; i++) {
        buf += '\r\n\x1b[2K';
      }
      buf += `\x1b[${reserve}A`;
      if (cursorColumn > 0) {
        buf += `\r\x1b[${cursorColumn}C`;
      } else {
        buf += '\r';
      }
    }

    // 2. Lưu vị trí con trỏ ban đầu tại dòng input (cả DEC \x1b7 và SCO \x1b[s)
    buf += '\x1b7\x1b[s';

    // 3. Ghi từng dòng hint kèm xóa sạch dòng cũ (Clear Line \x1b[2K)
    for (let i = 0; i < maxRows; i++) {
      const lineContent = i < nextRows ? lines[i] : '';
      buf += `\r\n\x1b[2K${lineContent}`;
    }

    // 4. Di chuyển con trỏ ngược lên lại số dòng đã xuống để trở về dòng input
    buf += `\x1b[${maxRows}A`;

    // 5. Khôi phục vị trí con trỏ ban đầu và định vị cột ngang chính xác
    buf += '\x1b8\x1b[u';
    if (cursorColumn > 0) {
      buf += `\r\x1b[${cursorColumn}C`;
    } else {
      buf += '\r';
    }

    buf += '\x1b[?25h'; // Hiện lại con trỏ

    this.terminal.write(buf);
    this.renderedRows = nextRows;
  }
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsiForDisplay(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function truncateDisplayText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

export interface TypewriterOptions {
  delayMs?: number;
  write?: (character: string) => void;
  wait?: (delayMs: number) => Promise<void>;
}

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

export type RGB = [number, number, number];
export type CatMascotAction = 'coding' | 'waving' | 'coffee' | 'hacker' | 'rocket' | 'sleeping';

export interface PixelSprite {
  name: string;
  badge: string;
  width: number;
  height: number;
  palette: Record<string, RGB | null>;
  rows: string[];
}

export interface CatMascotPose {
  action: CatMascotAction;
  name: string;
  badge: string;
  lines: string[];
}

/** Lightweight, minimalist Mascot representation */
export function getCatMascot(action?: CatMascotAction): CatMascotPose {
  const act = action || 'coding';
  const badgeMap: Record<CatMascotAction, string> = {
    coding: '⚡ Autonomous Pair Programmer',
    waving: '👋 Ready to assist',
    coffee: '☕ Deep Reasoning Engine',
    hacker: '🕶️ Code Intelligence',
    rocket: '🚀 Dynamic Convergence',
    sleeping: '💤 Standby',
  };
  return {
    action: act,
    name: 'Minus Agent',
    badge: badgeMap[act] || badgeMap.coding,
    lines: [`🐱 MINUS [${act}]`],
  };
}

export interface BannerOptions {
  modelName: string;
  workspaceRoot: string;
  maxSteps: number;
  tools: string[];
  sandboxStatus?: string;
  activeBranch?: string;
  mascotAction?: CatMascotAction;
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
    name: 'openrouter/z-ai/glm-5.3-flash',
    provider: 'OpenRouter (Z.ai)',
    desc: 'GLM-5.3 Flash (Z.ai - cựu Ox Alpha): Multimodal reasoning coding model, 1M context',
    recommended: true,
  },
  {
    id: '27',
    name: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
    provider: 'OpenRouter (Free)',
    desc: 'Llama 3.3 70B miễn phí qua OpenRouter',
  },
  {
    id: '28',
    name: 'openrouter/deepseek/deepseek-r1:free',
    provider: 'OpenRouter (Free)',
    desc: 'DeepSeek R1 miễn phí qua OpenRouter',
  },
  {
    id: '29',
    name: 'openrouter/google/gemini-2.0-flash-exp:free',
    provider: 'OpenRouter (Free)',
    desc: 'Gemini 2.0 Flash Experimental miễn phí qua OpenRouter',
  },

  // 9. Pollinations AI
  {
    id: '30',
    name: 'pollinations/openai',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'GPT-4o-mini miễn phí 100%, không cần đăng ký tài khoản hay API key',
  },
  {
    id: '31',
    name: 'pollinations/mistral',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'Mistral miễn phí 100%, không cần đăng ký tài khoản hay API key',
  },

  // 10. DeepSeek Direct
  {
    id: '32',
    name: 'deepseek-chat',
    provider: 'DeepSeek Direct',
    desc: 'DeepSeek V3 chính thức (cần key platform.deepseek.com)',
  },
  {
    id: '33',
    name: 'deepseek-reasoner',
    provider: 'DeepSeek Direct',
    desc: 'DeepSeek R1 reasoning chính thức (cần key platform.deepseek.com)',
  },

  // 11. Anthropic Claude API (active models)
  {
    id: '34',
    name: 'claude-fable-5',
    provider: 'Anthropic Claude API',
    desc: 'Claude Fable 5: model Anthropic mạnh nhất cho agent chạy dài và tác vụ phức tạp',
    recommended: true,
  },
  {
    id: '35',
    name: 'claude-opus-5',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 5: suy luận và coding agentic cao cấp',
  },
  {
    id: '36',
    name: 'claude-opus-4-8',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.8: coding agentic và enterprise work phức tạp',
  },
  {
    id: '37',
    name: 'claude-opus-4-7',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.7: Opus mạnh cho reasoning và coding',
  },
  {
    id: '38',
    name: 'claude-opus-4-6',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.6: năng lực cao cho tác vụ dài và nhiều bước',
  },
  {
    id: '39',
    name: 'claude-opus-4-5-20251101',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.5: snapshot ổn định cho coding agent',
  },
  {
    id: '40',
    name: 'claude-sonnet-5',
    provider: 'Anthropic Claude API',
    desc: 'Claude Sonnet 5: cân bằng tốc độ, chất lượng và coding agentic',
  },
  {
    id: '41',
    name: 'claude-sonnet-4-6',
    provider: 'Anthropic Claude API',
    desc: 'Claude Sonnet 4.6: nhanh, mạnh và phù hợp cho coding hằng ngày',
  },
  {
    id: '42',
    name: 'claude-sonnet-4-5-20250929',
    provider: 'Anthropic Claude API',
    desc: 'Claude Sonnet 4.5: snapshot ổn định cho coding và automation',
  },
  {
    id: '43',
    name: 'claude-haiku-4-5-20251001',
    provider: 'Anthropic Claude API',
    desc: 'Claude Haiku 4.5: phản hồi nhanh và tiết kiệm cho tác vụ nhẹ',
  },

  // 12. MINUS CLI Models (OpenAI / ChatGPT Plus)
  {
    id: 'cs',
    name: 'codex/gpt-5.6-sol',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: '☀️ GPT-5.6 Sol: Đỉnh cao suy luận, quy hoạch logic phức tạp & hoàn thiện code tối đa',
    recommended: true,
  },
  {
    id: 'ct',
    name: 'codex/gpt-5.6-terra',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: '🌍 GPT-5.6 Terra: Mô hình chủ lực cân bằng tốc độ & chất lượng cho coding hàng ngày',
  },
  {
    id: 'cl',
    name: 'codex/gpt-5.6-luna',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: '🌙 GPT-5.6 Luna: Siêu tốc độ, nhẹ, tối ưu cho tác vụ rõ ràng & lặp lại nhanh',
  },
  {
    id: 'c4',
    name: 'codex/o4-mini',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: 'o4-mini: Reasoning code thế hệ mới tối ưu cho coding agent',
  },
  {
    id: 'c3',
    name: 'codex/o3-mini',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: 'o3-mini: Suy luận chuyên sâu lập trình và giải quyết thuật toán hóc búa',
  },
  {
    id: 'cg',
    name: 'codex/gpt-4o',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: 'GPT-4o: Đa năng, xử lý ngữ cảnh lớn & sinh mã ổn định',
  },
];

export function getVisibleWidth(text: string): number {
  const clean = stripAnsiForDisplay(text);
  let width = 0;

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of segmenter.segment(clean)) {
    const codePoint = segment.codePointAt(0);
    if (codePoint === undefined) continue;

    // Combining marks, variation selectors (\uFE0F), zero width joiner (\u200D)
    if (
      (codePoint >= 0x0300 && codePoint <= 0x036F) || // Combining Diacritical Marks
      (codePoint >= 0x1DC0 && codePoint <= 0x1DFF) ||
      (codePoint >= 0x20D0 && codePoint <= 0x20FF) ||
      (codePoint >= 0xFE00 && codePoint <= 0xFE0F) || // Variation Selectors
      codePoint === 0x200B || // Zero Width Space
      codePoint === 0x200C || // Zero Width Non-Joiner
      codePoint === 0x200D    // Zero Width Joiner
    ) {
      continue;
    }

    // Emoji & Extended Pictographic symbols (độ rộng 2 cột trên terminal)
    // CJK ideographs / Fullwidth forms
    if (
      /\p{Extended_Pictographic}/u.test(segment) ||
      (codePoint >= 0x1100 && codePoint <= 0x115F) || // Hangul Jamo
      (codePoint >= 0x2E80 && codePoint <= 0x9FFF) || // CJK Radicals, Ideographs
      (codePoint >= 0xAC00 && codePoint <= 0xD7A3) || // Hangul Syllables
      (codePoint >= 0xF900 && codePoint <= 0xFAFF) || // CJK Compatibility Ideographs
      (codePoint >= 0xFE10 && codePoint <= 0xFE19) || // Vertical forms
      (codePoint >= 0xFE30 && codePoint <= 0xFE6F) || // CJK Compatibility Forms
      (codePoint >= 0xFF00 && codePoint <= 0xFF60) || // Fullwidth Forms
      (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||
      (codePoint >= 0x1F000 && codePoint <= 0x1FAFF)  // Symbols, Pictographs, Supplemental
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function padRightVisible(text: string, targetWidth: number): string {
  const visibleLen = getVisibleWidth(text);
  const pad = Math.max(0, targetWidth - visibleLen);
  return text + ' '.repeat(pad);
}

export function getTerminalWidth(defaultWidth = 80, minWidth = 50, maxWidth = 110): number {
  const cols = process.stdout.columns || defaultWidth;
  return Math.max(minWidth, Math.min(maxWidth, cols));
}

export function createBoxHeader(title: string, color = c.subtleBorder, width?: number): string {
  const targetWidth = width || getTerminalWidth();
  const titleWidth = getVisibleWidth(title);
  // '╭── ' = 4 cols, ' ' after title = 1 col, '╮' = 1 col => tổng ký tự khung biên = 6 cols
  const remaining = Math.max(2, targetWidth - 6 - titleWidth);
  return `${color}╭── ${title} ${color}${'─'.repeat(remaining)}╮${c.reset}`;
}

export function createBoxDivider(color = c.subtleBorder, width?: number): string {
  const targetWidth = width || getTerminalWidth();
  return `${color}├${'─'.repeat(Math.max(2, targetWidth - 2))}┤${c.reset}`;
}

export function createBoxFooter(color = c.subtleBorder, width?: number): string {
  const targetWidth = width || getTerminalWidth();
  return `${color}╰${'─'.repeat(Math.max(2, targetWidth - 2))}╯${c.reset}`;
}

export function renderContextProgressBar(usedTokens: number, maxTokens: number, barWidth = 10): string {
  if (maxTokens <= 0) return '';
  const percent = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  const filled = Math.round((percent / 100) * barWidth);
  const barColor = percent > 85 ? c.crimson : percent > 65 ? c.amber : c.emerald;
  return `${barColor}${'█'.repeat(filled)}${c.slate}${'░'.repeat(Math.max(0, barWidth - filled))}${c.reset} ${percent}%`;
}

/**
 * Lớp điều khiển hiển thị Terminal UI/UX tối giản phong cách Swiss Monospace / Industrial Minimalist.
 * Tập trung 100% vào tín hiệu người dùng cần thấy (Zero Clutter, High Signal-to-Noise).
 */
export class CLI {
  /**
   * Header mở đầu tối giản, hiện đại (3 dòng, không chiếm diện tích terminal)
   */
  static renderBanner(opts: BannerOptions): void {
    const wsName = path.basename(opts.workspaceRoot) || opts.workspaceRoot;
    const branch = opts.activeBranch ? ` · ${c.brightCyan}git:${opts.activeBranch}${c.reset}` : '';
    const steps = isFinite(opts.maxSteps) ? `${opts.maxSteps} steps` : 'dynamic ∞';

    console.log(`\n  ${c.brightCyan}${c.bold}⚡ MINUS CLI${c.reset} ${c.slate}v2.5${c.reset} · ${c.bold}${opts.modelName}${c.reset}${branch} · ${c.slate}${wsName}${c.reset}`);
    console.log(`  ${c.slate}Budget: ${steps} · ${opts.tools.length} tools · Type ${c.brightCyan}/help${c.slate} for commands, ${c.white}Ctrl+C${c.slate} to cancel.${c.reset}\n`);
  }

  /**
   * Hiển thị bảng lệnh gợi ý nhanh gọn
   */
  static renderQuickCommands(): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ COMMANDS${c.reset}`);
    for (const cmd of SLASH_COMMANDS) {
      const aliasStr = cmd.aliases?.length ? ` ${c.slate}(${cmd.aliases.join(', ')})${c.reset}` : '';
      console.log(`  ${c.brightCyan}${cmd.command.padEnd(16)}${c.reset} ${c.mutedText}${cmd.description}${aliasStr}${c.reset}`);
    }
    console.log('');
  }

  /**
   * Hiển thị danh sách các model có sẵn để người dùng chọn
   */
  static renderModelSelector(currentModel: string): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🤖 DANH SÁCH MÔ HÌNH KHẢ DỤNG (SELECT MODEL)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}`);
    
    let lastProvider = '';
    for (const m of AVAILABLE_MODELS) {
      if (m.provider !== lastProvider) {
        lastProvider = m.provider;
        console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}❖ ${m.provider.toUpperCase()}${c.reset}`);
      }

      const isCurrent = m.name === currentModel;
      const marker = isCurrent ? ` ${c.emerald}${c.bold}* [ACTIVE]${c.reset}` : '';
      const recBadge = m.recommended ? ` ${c.geminiAmber}(Recommended)${c.reset}` : '';
      
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}${c.bold}[${m.id.padStart(2, ' ')}]${c.reset} ${c.bold}${m.name}${c.reset}${recBadge}${marker}`);
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}         ${c.mutedText}${m.desc}${c.reset}`);
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}`);
    }

    console.log(`${createBoxDivider(c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}👉 Nhập ID model (ví dụ: ${c.brightCyan}0${c.slate}, ${c.brightCyan}1${c.slate}, ${c.brightCyan}9r${c.slate}, ${c.brightCyan}26${c.slate}, ${c.brightCyan}cs${c.slate}...) hoặc ${c.brightCyan}tên model bất kỳ${c.slate} để đổi mô hình:${c.reset}`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Bảng hướng dẫn sử dụng tối giản
   */
  static renderHelp(): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ MINUS CLI GUIDE${c.reset}`);
    const byCategory = new Map<string, SlashCommandDefinition[]>();
    for (const cmd of SLASH_COMMANDS) {
      const cat = cmd.category || 'General';
      const list = byCategory.get(cat) || [];
      list.push(cmd);
      byCategory.set(cat, list);
    }
    for (const [cat, cmds] of byCategory.entries()) {
      console.log(`\n  ${c.geminiAmber}${c.bold}${cat}${c.reset}`);
      for (const item of cmds) {
        console.log(`    ${c.brightCyan}${(item.usage || item.command).padEnd(26)}${c.reset} ${c.mutedText}${item.description}${c.reset}`);
      }
    }
    console.log('');
  }

  /**
   * Liệt kê Tools đã nạp
   */
  static renderTools(toolList: Array<{ name: string; description: string }>): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ REGISTERED TOOLS (${toolList.length})${c.reset}`);
    for (const tool of toolList) {
      console.log(`  ${c.teal}${tool.name.padEnd(22)}${c.reset} ${c.mutedText}${truncateDisplayText(tool.description, 65)}${c.reset}`);
    }
    console.log('');
  }

  static renderWorkspaceInfo(workspaceRoot: string): void {
    console.log(`\n  ${c.slate}Workspace:${c.reset} ${c.brightCyan}${workspaceRoot}${c.reset}\n`);
  }

  static renderWorkspaceChanged(oldPath: string, newPath: string): void {
    console.log(`\n  ${c.emerald}✔ Workspace switched:${c.reset} ${c.brightCyan}${newPath}${c.reset}\n`);
  }

  static renderCheckpoints(checkpoints: Array<{ index: number; timestamp: string; description: string }>): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ CHECKPOINTS (${checkpoints.length})${c.reset}`);
    if (checkpoints.length === 0) {
      console.log(`  ${c.mutedText}No checkpoints yet.${c.reset}`);
    } else {
      for (const cp of checkpoints) {
        console.log(`  ${c.brightCyan}#${cp.index}${c.reset} ${c.slate}${cp.timestamp}${c.reset} ── ${cp.description}`);
      }
    }
    console.log('');
  }

  /**
   * Hiển thị Cây kế hoạch gọn gàng dạng Checklist
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

    console.log(`\n  ${c.brightCyan}${c.bold}📋 Plan [${completed}/${total}] (${percent}%)${c.reset}`);
    for (const t of tasks) {
      let icon = `${c.slate}○${c.reset}`;
      let style = c.mutedText;
      if (t.status === 'COMPLETED') {
        icon = `${c.emerald}✔${c.reset}`;
        style = `${c.green}`;
      } else if (t.status === 'IN_PROGRESS') {
        icon = `${c.amber}⚡${c.reset}`;
        style = `${c.brightYellow}${c.bold}`;
      } else if (t.status === 'FAILED') {
        icon = `${c.crimson}✖${c.reset}`;
        style = `${c.red}`;
      } else if (t.status === 'SKIPPED') {
        icon = `${c.slate}⊘${c.reset}`;
        style = `${c.slate}${c.strikethrough}`;
      }
      console.log(`    ${icon} ${t.id}. ${style}${t.title}${c.reset}`);
    }
    console.log('');
  }

  /**
   * Hiển thị Diff code gọn gàng
   */
  static renderDiff(diffText: string, options: { filePath?: string; status?: 'MODIFIED' | 'CREATED' | 'DELETED' } = {}): void {
    const lines = diffText.trim().split('\n');
    const title = options.filePath ? `Diff: ${options.status || 'MODIFIED'} ${options.filePath}` : 'Diff Patch';
    console.log(`\n  ${c.slate}─── ${title} ───${c.reset}`);
    for (const line of lines.slice(0, 25)) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        console.log(`  ${c.emerald}+ ${line.slice(1)}${c.reset}`);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        console.log(`  ${c.crimson}- ${line.slice(1)}${c.reset}`);
      } else if (line.startsWith('@@')) {
        console.log(`  ${c.slate}${line}${c.reset}`);
      }
    }
    if (lines.length > 25) {
      console.log(`  ${c.slate}... (+${lines.length - 25} lines)${c.reset}`);
    }
    console.log('');
  }

  static renderReflectionAlert(failures: number, advice?: string): void {
    if (failures < 3) return;
    console.log(`  ${c.amber}⚠️ [Correction Protocol Active: ${failures} consecutive failures]${c.reset}`);
    if (advice) console.log(`     ${c.mutedText}${advice}${c.reset}`);
  }

  /**
   * Báo cáo phân tích nguyên nhân gốc rễ lỗi (Error Detective RCA)
   */
  static renderErrorDetectiveReport(report: {
    primaryDefect?: string;
    location?: string;
    rootCause?: string;
    pattern?: string;
    immediateFix?: string;
    prevention?: string;
  }): void {
    if (!report.primaryDefect) return;
    console.log(`\n  ${c.crimson}${c.bold}🕵️ [ROOT CAUSE ANALYSIS]${c.reset} ${report.pattern ? `${c.brightRed}[${report.pattern}]${c.reset}` : ''}`);
    console.log(`     ${c.white}• Defect:${c.reset}   ${report.primaryDefect}`);
    if (report.location) console.log(`     ${c.slate}• Location:${c.reset} ${c.brightCyan}${report.location}${c.reset}`);
    if (report.rootCause) console.log(`     ${c.emerald}• Cause:${c.reset}    ${c.mutedText}${report.rootCause}${c.reset}`);
    if (report.immediateFix) console.log(`     ${c.brightCyan}• Fix:${c.reset}      ${c.white}${report.immediateFix}${c.reset}`);
    console.log('');
  }

  static renderAutoCompactionNotice(savedTokens: number, remainingTokens: number): void {
    console.log(`  ${c.cyan}🧹 [Auto-Compacted]${c.reset} ${c.emerald}Saved ~${savedTokens.toLocaleString()} tokens${c.reset} ${c.slate}(History: ~${remainingTokens.toLocaleString()} tok)${c.reset}`);
  }

  static renderContextSnapshotSaved(snapshot: {
    snapshotId: string;
    turn: number;
    contextFingerprint: string;
    architecturalDecisions: Array<any>;
    stateMutations: { filesModified: string[] };
    verificationStatus: string;
  }): void {
    const decisionsStr = snapshot.architecturalDecisions.length > 0 ? ` · ${snapshot.architecturalDecisions.length} decisions` : '';
    console.log(`  ${c.purple}💾 [Snapshot Saved]${c.reset} ${c.brightCyan}${snapshot.snapshotId}${c.reset}${decisionsStr}`);
  }

  static renderContextDriftWarning(drift: {
    divergedFiles: string[];
    details: string[];
  }): void {
    console.log(`  ${c.crimson}⚠️ [Context Drift]${c.reset} ${c.amber}${drift.divergedFiles.join(', ')} modified externally.${c.reset}`);
  }

  static renderMemory(data: any): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ PROJECT MEMORY${c.reset}`);
    console.log(`  Project: ${c.bold}${data.projectName || 'unnamed'}${c.reset} (${data.projectType || 'unknown'}) · Package Manager: ${c.yellow}${data.packageManager || 'npm'}${c.reset}`);
    const insights = data.learnedInsights || [];
    if (insights.length > 0) {
      console.log(`  ${c.slate}Learned conventions (${insights.length}):${c.reset}`);
      for (const item of insights.slice(-4)) {
        console.log(`    • ${c.brightCyan}[${item.key}]${c.reset} ${item.insight}`);
      }
    }
    console.log('');
  }

  static renderSandbox(status: any): void {
    console.log(`  ${c.slate}Sandbox:${c.reset} ${status.activeProvider} (${status.mode}) · Isolated: ${status.isIsolated ? '✔ Yes' : 'Host OS'}`);
  }

  static renderTasks(tasks: Array<{ id: string; command: string; status: string; startedAt: string; pid?: number }>): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ BACKGROUND TASKS (${tasks.length})${c.reset}`);
    if (tasks.length === 0) {
      console.log(`  ${c.mutedText}No tasks running.${c.reset}`);
    } else {
      for (const t of tasks) {
        console.log(`  [${t.id}] ${t.command} ── ${t.status}`);
      }
    }
    console.log('');
  }

  static renderStatus(opts: StatusOptions): void {
    const goal = opts.isGoalMode ? 'Goal Mode: ON (∞)' : `Step Budget: ${opts.maxSteps}`;
    console.log(`\n  ${c.brightCyan}${c.bold}❯ STATUS${c.reset} · ${opts.modelName} · ${goal} · Turns: ${opts.sessionTurns}\n`);
  }

  static renderSessionInfo(data: { modelName?: string; workspacePath?: string; activeSessionId?: string; lastUpdated?: string }, sessionFile: string): void {
    console.log(`\n  ${c.slate}Session:${c.reset} ${data.activeSessionId || 'none'} · Model: ${data.modelName || 'default'} · File: ${sessionFile}\n`);
  }

  static renderInterruptedSessionNotice(data: {
    interruptionType: string;
    activeDetail?: string;
    blocker?: string;
    isGoal?: boolean;
    isPlan?: boolean;
  }): void {
    console.log(`\n  ${c.amber}⚠️ [Interrupted Session Detected]${c.reset} ${data.activeDetail || data.interruptionType}`);
    console.log(`  ${c.slate}Type ${c.brightCyan}/resume${c.slate} to continue seamlessly.${c.reset}\n`);
  }

  static renderGoalBanner(goalText: string): void {
    console.log(`\n  ${c.purple}${c.bold}🎯 GOAL:${c.reset} ${c.bold}${goalText}${c.reset} ${c.slate}(Autonomous Mode ∞)${c.reset}\n`);
  }

  static renderGoalStatus(enabled: boolean): void {
    console.log(`\n  ${c.slate}Goal Mode:${c.reset} ${enabled ? `${c.emerald}ON (Unlimited steps ∞)${c.reset}` : `${c.yellow}OFF${c.reset}`}\n`);
  }

  /**
   * Đầu mỗi Step: 1 dòng phân cách mảnh, trang nhã (Zero noise)
   */
  static renderStepHeader(
    step: number,
    maxSteps: number,
    context?: {
      phase?: string;
      activeTask?: string;
      playbook?: string;
      risk?: string;
      isGoal?: boolean;
    },
  ): void {
    const isUnlimited = !isFinite(maxSteps) || maxSteps >= 9999;
    const progress = isUnlimited ? `${step}/∞` : `${step}/${maxSteps}`;
    const phaseTag = context?.phase ? ` [${context.phase.toUpperCase()}]` : '';
    const taskTag = context?.activeTask ? ` ── "${truncateDisplayText(context.activeTask, 40)}"` : '';

    console.log(`\n${c.slate}─── STEP ${progress}${phaseTag}${taskTag} ───────────────────────────────────────${c.reset}`);
  }

  /**
   * Trạng thái suy luận System 2 gọn gàng
   */
  static renderLLMThinking(summary?: string): void {
    const text = summary && summary.trim() ? summary.trim() : 'Analyzing context & deciding next action...';
    console.log(`  ${c.purple}🧠 [REASONING]${c.reset} ${c.mutedText}${text}${c.reset}`);
  }

  static renderReasoning(thoughtText: string, options: { collapsed?: boolean } = {}): void {
    if (!thoughtText || !thoughtText.trim()) return;
    const lines = thoughtText.trim().split('\n');
    if (options.collapsed) {
      console.log(`  ${c.purple}🧠 Thinking:${c.reset} ${c.mutedText}${lines[0]?.slice(0, 70)}...${c.reset}`);
      return;
    }
    console.log(`  ${c.purple}🧠 Reasoning:${c.reset}`);
    for (const line of lines.slice(0, 4)) {
      console.log(`    ${c.slate}${line}${c.reset}`);
    }
    if (lines.length > 4) {
      console.log(`    ${c.slate}... (+${lines.length - 4} lines)${c.reset}`);
    }
  }

  static renderCognitiveScaffold(scaffoldLines: string[]): void {
    // Scaffold được nạp ngầm vào prompt cho LLM, chỉ in 1 dòng biểu thị nhẹ nếu cần
    if (!scaffoldLines || scaffoldLines.length === 0) return;
    const gateLine = scaffoldLines.find((l) => l.includes('Gate') || l.includes('Negative'));
    if (gateLine) {
      console.log(`  ${c.slate}🛡️ ${gateLine.replace(/^[│├─\s]+/, '').slice(0, 80)}${c.reset}`);
    }
  }

  static renderCognitiveBrake(reason: string, pivot?: string): void {
    console.log(`  ${c.crimson}🛑 [Brake]${c.reset} ${c.amber}${reason}${c.reset}${pivot ? ` ➔ ${c.emerald}${pivot}${c.reset}` : ''}`);
  }

  static renderCollapseStatus(prefs: UICollapsePreferences): void {
    console.log(`\n  ${c.slate}UI Collapse:${c.reset} steps: ${prefs.compactSteps ? 'compact' : 'expanded'} · thinking: ${prefs.thinking ? 'folded' : 'expanded'} · tools: ${prefs.tools ? 'preview' : 'raw'}\n`);
  }

  static renderExploreMenu(): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ EXPLORE COMMANDS${c.reset}`);
    console.log(`  /explore tree [depth]  · Workspace directory tree`);
    console.log(`  /explore context       · Context window tokens`);
    console.log(`  /explore reasoning     · Deep thinking trace`);
    console.log(`  /explore memory        · Project conventions & memory\n`);
  }

  static renderWorkspaceTree(scanResult: TreeScanResult, options: { maxLines?: number } = {}): void {
    console.log(`\n  ${c.brightCyan}🌳 ${path.basename(scanResult.rootPath) || scanResult.rootPath}/${c.reset} (${scanResult.totalFiles} files)`);
    const lines: string[] = [];
    function traverse(node: TreeNode, prefix: string) {
      if (lines.length >= (options.maxLines || 40)) return;
      if (node.depth > 0) {
        if (node.isDirectory) {
          lines.push(`  ${prefix}📁 ${node.name}/`);
          (node.children || []).forEach((ch) => traverse(ch, prefix + '  '));
        } else {
          lines.push(`  ${prefix}📄 ${node.name}`);
        }
      } else {
        (node.children || []).forEach((ch) => traverse(ch, '  '));
      }
    }
    traverse(scanResult.rootNode, '');
    lines.forEach((l) => console.log(l));
    console.log('');
  }

  static renderContextInspection(report: ContextInspectionReport): void {
    const gauge = renderContextProgressBar(report.totalEstimatedTokens, report.maxInputTokens, 12);
    console.log(`\n${c.brightCyan}${c.bold}❯ CONTEXT BUDGET${c.reset} [${gauge}] ${report.totalEstimatedTokens.toLocaleString()} / ${report.maxInputTokens.toLocaleString()} tok (${report.utilizationPercent}%)`);
    for (const layer of report.layers) {
      console.log(`  • ${layer.name.padEnd(25)} : ${layer.estimatedTokens.toLocaleString().padStart(8)} tok (${layer.percentage}%)`);
    }
    console.log('');
  }

  static renderReasoningInspection(data: { thought: string; timestamp?: string; step?: number; turn?: number }): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ REASONING TRACE${c.reset}`);
    console.log(data.thought || 'No trace recorded.');
    console.log('');
  }

  static renderModelAction(action: 'tool_call' | 'final_answer' | 'max_steps', detail?: string): void {
    if (action === 'final_answer') {
      console.log(`  ${c.emerald}✨ [COMPLETED]${c.reset} Ready to provide final response.`);
    } else if (action === 'tool_call') {
      console.log(`  ${c.geminiCyan}⚙️ [ACTION]${c.reset} ${detail || 'Requesting tool execution...'}`);
    } else {
      console.log(`  ${c.crimson}⚠️ [CIRCUIT BREAKER]${c.reset} Max steps reached.`);
    }
  }

  /**
   * Hiển thị gọi công cụ gọn gàng (1 dòng)
   */
  static renderToolCall(name: string, args: Record<string, any>): void {
    const summary = args.path || args.filePath || args.command || args.query || args.target || '';
    const argStr = summary ? ` ${c.white}${formatToolArgumentPreview(summary, 80)}${c.reset}` : '';
    console.log(`  ${c.brightCyan}›${c.reset} ${c.bold}${name}${c.reset}${argStr}`);
    if (name === 'apply_patch' && typeof args.patch === 'string') {
      CLI.renderDiff(args.patch, { filePath: args.filePath });
    }
  }

  /**
   * Hiển thị kết quả công cụ súc tích, chỉ hiện thông tin cốt lõi
   */
  static renderToolResult(name: string, durationMs: number, result: Record<string, any>): void {
    const isError = isToolResultFailure(result);
    const duration = durationMs > 0 ? ` ${c.slate}(${durationMs}ms)${c.reset}` : '';

    if (isError) {
      const firstStderrLine = result.stderr ? String(result.stderr).trim().split('\n')[0] : '';
      const exitDetail = typeof result.exitCode === 'number' && result.exitCode !== 0 ? `Process exited with code ${result.exitCode}` : '';
      const errDetail = result.error || result.message || firstStderrLine || exitDetail || 'Unknown error';
      console.log(`  ${c.crimson}✖ ${name} failed${duration}:${c.reset} ${errDetail}`);
      return;
    }

    let statusDetail = 'OK';
    if (result.stdout !== undefined) {
      statusDetail = result.exitCode === 0 ? 'exit 0' : `exit ${result.exitCode}`;
    } else if (result.replacements !== undefined) {
      statusDetail = `${result.replacements} replaced`;
    } else if (result.created) {
      statusDetail = 'created';
    } else if (result.hunksApplied !== undefined) {
      statusDetail = `${result.hunksApplied} hunks applied`;
    } else if (result.matches !== undefined) {
      statusDetail = `${result.totalMatches || result.matches.length} matches`;
    }

    console.log(`  ${c.emerald}✔${c.reset} ${c.slate}${statusDetail}${duration}${c.reset}`);

    // Nếu chạy lệnh kiểm thử có lỗi stderr, in ngắn gọn
    if (result.stderr && result.exitCode !== 0) {
      const errLines = String(result.stderr).trim().split('\n').slice(0, 3);
      errLines.forEach((l) => console.log(`    ${c.crimson}${l}${c.reset}`));
    }
  }

  static renderCompactStepLine(name: string, args: Record<string, any>, durationMs: number, result: Record<string, any>): void {
    const isError = isToolResultFailure(result);
    const icon = isError ? `${c.crimson}✖${c.reset}` : `${c.emerald}✔${c.reset}`;
    const target = args.path || args.filePath || args.command || '';
    const targetStr = target ? ` "${truncateDisplayText(String(target), 35)}"` : '';
    const duration = durationMs > 0 ? ` ${c.slate}(${durationMs}ms)${c.reset}` : '';
    console.log(`  ${icon} ${name}${targetStr}${duration}`);
  }

  static renderCtrlOToggleToast(isCompact: boolean): void {
    console.log(`  ${c.slate}[Ctrl+O] Compact Mode: ${isCompact ? 'ON' : 'OFF'}${c.reset}`);
  }

  static renderCacheUsage(usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    cacheHitRate?: number;
    maxContextTokens?: number;
  }): void {
    if (!usage || (usage.promptTokens === undefined && usage.totalTokens === undefined)) return;
    const promptTokens = usage.promptTokens ?? 0;
    const cachedTokens = usage.cachedTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    const hitRate = usage.cacheHitRate ?? (promptTokens > 0 ? Number(((cachedTokens / promptTokens) * 100).toFixed(1)) : 0);
    const maxCtx = usage.maxContextTokens || 128000;

    const progressMeter = renderContextProgressBar(promptTokens, maxCtx, 12);
    const hitBadge = cachedTokens > 0
      ? `${c.emerald}${c.bold}${hitRate}% hit rate${c.reset}`
      : `${c.slate}0% (cold)${c.reset}`;

    console.log(
      `  ${c.geminiCyan}⚡ [TELEMETRY]${c.reset} Context: [${progressMeter}] ${c.slate}(${promptTokens.toLocaleString()} tok)${c.reset} │ Prompt Cache: ${cachedTokens.toLocaleString()} tok [${hitBadge}] │ Out: ${c.yellow}${completionTokens.toLocaleString()}${c.reset} tok`
    );
  }

  static renderPromptCacheDashboard(info: {
    modelName: string;
    preservePrefixCache: boolean;
    sessionId?: string;
    sessionAgeSec?: number;
    cachedTokens?: number;
    totalTokens?: number;
    cacheHitRate?: number;
    cachedCheckpoints?: number;
  }): void {
    const cached = info.cachedTokens ?? 0;
    const total = info.totalTokens ?? 0;
    const rate = info.cacheHitRate ?? (total > 0 ? Number(((cached / total) * 100).toFixed(1)) : 0);
    const modeBadge = info.preservePrefixCache
      ? `${c.emerald}ENABLED (Prefix Preserved)${c.reset}`
      : `${c.amber}DISABLED${c.reset}`;
    console.log(`\n  ${c.geminiCyan}${c.bold}❯ PROMPT CACHE TELEMETRY${c.reset} [${modeBadge}]`);
    console.log(`    Model: ${c.brightCyan}${info.modelName}${c.reset} │ Session: ${c.slate}${info.sessionId || 'active'}${c.reset} (${info.sessionAgeSec ?? 0}s)`);
    console.log(`    Tokens: ${cached.toLocaleString()} cached / ${total.toLocaleString()} total (${c.yellow}${rate}%${c.reset} hit rate) │ Checkpoints: ${info.cachedCheckpoints ?? 0}`);
  }

  static renderAttachmentSummary(attachments: AttachedItemSummary[]): void {
    if (!attachments || attachments.length === 0) return;
    console.log(`\n  ${c.geminiCyan}${c.bold}📎 ĐÃ ĐÍNH KÈM VÀO NGỮ CẢNH (${attachments.length} mục):${c.reset}`);
    for (const a of attachments) {
      console.log(`    • ${path.basename(a.path)} (${(a.sizeBytes / 1024).toFixed(1)} KB)`);
    }
    console.log('');
  }

  static renderStepFooter(): void {
    // Giảm thiểu khoảng trắng thừa giữa các step
  }

  static formatMarkdownTerminal(text: string): string {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts
      .map((part) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const lines = part.split('\n');
          const lang = lines[0].slice(3).trim();
          const codeLines = lines.slice(1, -1);
          const langTag = lang ? ` ${c.slate}[${lang}]${c.reset}` : '';
          return `\n  ${c.slate}── Code${langTag} ──${c.reset}\n` +
            codeLines.map((l) => `  ${c.brightCyan}${l}${c.reset}`).join('\n') +
            `\n  ${c.slate}──────────────${c.reset}\n`;
        }

        return part
          .replace(/^### (.*$)/gm, `${c.brightCyan}${c.bold}❯ $1${c.reset}`)
          .replace(/^## (.*$)/gm, `\n${c.geminiAmber}${c.bold}$1${c.reset}`)
          .replace(/^# (.*$)/gm, `\n${c.brightCyan}${c.bold}=== $1 ===${c.reset}`)
          .replace(/\*\*([^*]+)\*\*/g, `${c.bold}$1${c.reset}`)
          .replace(/(^|\s)\*([^* \n][^*\n]*[^* \n])\*(\s|$)/g, `$1${c.italic}$2${c.reset}$3`)
          .replace(/`([^`\n]+)`/g, `${c.brightCyan}$1${c.reset}`)
          .replace(/^(\s*)[-*]\s+/gm, `$1${c.emerald}•${c.reset} `)
          .replace(/^(\s*)(\d+)\.\s+/gm, `$1${c.geminiAmber}$2.${c.reset} `)
          .replace(/^>\s*\[!NOTE\]\s*(.*$)/gm, `  ${c.geminiBlue}ℹ NOTE:${c.reset} $1`)
          .replace(/^>\s*\[!TIP\]\s*(.*$)/gm, `  ${c.geminiGreen}💡 TIP:${c.reset} $1`)
          .replace(/^>\s*\[!IMPORTANT\]\s*(.*$)/gm, `  ${c.geminiAmber}⚡ IMPORTANT:${c.reset} $1`)
          .replace(/^>\s*\[!WARNING\]\s*(.*$)/gm, `  ${c.geminiRed}⚠️ WARNING:${c.reset} $1`)
          .replace(/^>\s*\[!CAUTION\]\s*(.*$)/gm, `  ${c.crimson}🛑 CAUTION:${c.reset} $1`);
      })
      .join('');
  }

  static cleanFinalAnswerContent(text: string): string {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^\s*Code changes must end with an explicit test\/build verification step\.?\s*/i, '');
    cleaned = cleaned.replace(/^\s*\[Verification Ladder Result\][\s\S]*?\[Final Result\]\s*/i, '');
    cleaned = cleaned.replace(/^\s*\[Verification Ladder Result\][\s\S]*?(?=\n\n|\n[A-Z#Đ-Ưa-z])/i, '');
    cleaned = cleaned.replace(/^\s*\[Final Result\]\s*/i, '');
    return cleaned.trim();
  }

  static async renderFinalAnswer(answer: string, options: { animate?: boolean } = {}): Promise<void> {
    const rawContent = CLI.cleanFinalAnswerContent(answer);
    if (!rawContent) return;

    const shouldAnimate = options.animate === true;
    const formatted = CLI.formatMarkdownTerminal(rawContent);

    console.log('');
    if (shouldAnimate) {
      await writeTypewriterText(formatted);
      process.stdout.write('\n');
    } else {
      console.log(formatted);
    }
    console.log('');
  }

  static async renderExecutionStopped(message: string, reason: string = 'STOPPED'): Promise<void> {
    const content = message.trim();
    console.log(`\n  ${c.crimson}${c.bold}🛑 AGENT EXECUTION STOPPED (${reason})${c.reset}\n`);
    console.log(`  ${content}\n`);
    if (reason === 'CANCELLED' || reason === 'STOPPED') {
      CLI.renderPromptInputNotice('Tác vụ đã được dừng an toàn. Sẵn sàng nhận yêu cầu / prompt tiếp theo:', { force: true });
    }
  }

  private static lastCancelledToastTimestamp = 0;

  static resetToastDebounceTimestamps(): void {
    CLI.lastCancelledToastTimestamp = 0;
    CLI.lastPromptNoticeTimestamp = 0;
  }

  static renderTaskCancelledToast(
    message = 'Đã dừng tác vụ theo yêu cầu (Ctrl+C / Esc).',
    options: { showPromptNotice?: boolean; force?: boolean } = {},
  ): void {
    const now = Date.now();
    // Chống in lặp liên tiếp khi nhận cả signal và keypress event gần như đồng thời
    if (!options.force && now - CLI.lastCancelledToastTimestamp < 400) {
      return;
    }
    CLI.lastCancelledToastTimestamp = now;

    console.log(`\n  ${c.crimson}${c.bold}🛑 [Cancelled]${c.reset} ${c.brightRed}${message}${c.reset}`);
    if (options.showPromptNotice !== false) {
      CLI.renderPromptInputNotice('Đã dừng tác vụ đang thực thi. Mời bạn nhập prompt mới tiếp tục:', { force: options.force });
    } else {
      console.log('');
    }
  }

  private static lastPromptNoticeTimestamp = 0;

  static renderPromptInputNotice(
    hint = 'Sẵn sàng nhận lệnh mới. Mời bạn nhập yêu cầu / prompt:',
    options: { force?: boolean } = {},
  ): void {
    const now = Date.now();
    // Chống in lặp liên tiếp thông báo prompt trong vòng 400ms
    if (!options.force && now - CLI.lastPromptNoticeTimestamp < 400) {
      return;
    }
    CLI.lastPromptNoticeTimestamp = now;
    console.log(`  ${c.brightCyan}💬 ${hint}${c.reset}`);
    console.log(`  ${c.slate}💡 Gợi ý: Nhập câu lệnh, hoặc gõ ${c.bold}/help${c.reset}${c.slate} để xem trợ giúp, ${c.bold}/exit${c.reset}${c.slate} để thoát chương trình.${c.reset}\n`);
  }

  static renderSkills(skills: any[], activeDecisions: any[] = []): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ SKILLS (${skills.length})${c.reset}`);
    const activeMap = new Map(activeDecisions.map((d: any) => [d.skillId, d]));
    for (const s of skills) {
      const active = activeMap.get(s.id);
      const badge = active ? `${c.emerald}[active]${c.reset} ` : '';
      console.log(`  ${badge}${c.bold}${s.id}${c.reset} ── ${c.mutedText}${s.name}${c.reset}`);
    }
    console.log('');
  }

  static renderCapabilities(capabilities: any[]): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ CAPABILITIES (${capabilities.length})${c.reset}`);
    for (const cap of capabilities) {
      console.log(`  • ${c.bold}${cap.name}${c.reset} ➔ ${c.slate}${cap.toolName || 'system'}${c.reset} (${cap.sideEffect})`);
    }
    console.log('');
  }

  static renderApprovals(approvals: any[]): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ PENDING APPROVALS (${approvals.length})${c.reset}`);
    for (const req of approvals) {
      console.log(`  ⏳ [${req.id}] ${req.action}: ${req.description}`);
    }
    console.log('');
  }

  static renderPermissionStatus(mode: string, approvedCount: number): void {
    console.log(`\n  ${c.slate}Permissions:${c.reset} mode=${c.bold}${mode}${c.reset}, auto-approved in session: ${approvedCount}\n`);
  }

  static renderPermissionPrompt(request: {
    toolName: string;
    category: string;
    target: string;
    summary: string;
    riskLevel: string;
    details?: Record<string, any>;
  }): void {
    const rawTarget = (request.target || '').trim();
    const fallbackTarget = request.details
      ? String(request.details.command || request.details.CommandLine || request.details.commandLine || request.details.cmd || request.details.path || request.details.filePath || '').trim()
      : '';
    const displayTarget = rawTarget || fallbackTarget || '(không xác định)';

    let displaySummary = request.summary || '';
    const hasEmptyPlaceholder = displaySummary.includes(': ""') || displaySummary.trim() === '""';
    if (!displaySummary && displayTarget && displayTarget !== '(không xác định)') {
      displaySummary = `Thực thi thao tác trên "${displayTarget}"`;
    } else if (hasEmptyPlaceholder && displayTarget && displayTarget !== '(không xác định)') {
      displaySummary = displaySummary.replace(': ""', `: "${displayTarget}"`).replace(/^""$/, `"${displayTarget}"`);
    }

    console.log(`\n  ${c.amber}${c.bold}⚠️  PERMISSION REQUEST${c.reset} [${request.riskLevel}]`);
    console.log(`  Tool: ${c.bold}${request.toolName}${c.reset} ── Target: ${c.brightCyan}${displayTarget}${c.reset}`);
    console.log(`  Desc: ${displaySummary}`);
    if (request.details?.misuse) {
      console.log(`  ${c.geminiPurple || c.magenta}💡 Gợi ý: Bấm [n] để từ chối và chuyển sang tool: ${c.brightCyan}${request.details.misuse.tool}${c.reset}`);
    }
    console.log(`  ${c.slate}[y] Allow once · [a] Allow for session · [n] Reject · [q] Abort${c.reset}`);
  }

  static renderTokenConfig(modelName: string, config: any, profile: any): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ TOKEN BUDGET: ${modelName}${c.reset}`);
    console.log(`  Output: ${config.maxOutputTokens || 'default'} (max: ${profile.maxSupportedOutputTokens})`);
    console.log(`  Context: ${config.maxInputTokens || 'default'} (max: ${profile.maxSupportedInputTokens})`);
    console.log(`  Presets: low (16k) · medium (64k) · high (128k) · max\n`);
  }

  static renderSteeringNotice(text: string): void {
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    console.log(`\n  ${c.bgCyan}${c.bold} ⚡ QUEUED MESSAGE INJECTED (MID-TURN STEERING) ${c.reset} ${c.brightCyan}"${preview}"${c.reset}`);
    console.log(`  ${c.slate}↳ Đã tiêm tin nhắn bẻ lái vào ngữ cảnh; Agent đang điều chỉnh suy luận ngay trong bước này.${c.reset}\n`);
  }

  static renderQueueStatus(items: Array<{ id: string; text: string; source: string; enqueuedAt: string }>): void {
    if (items.length === 0) {
      console.log(`\n  ${c.slate}ℹ Hàng đợi Queued Messages trống (0 tin nhắn).${c.reset}\n`);
      return;
    }
    console.log(`\n${c.brightCyan}${c.bold}❯ QUEUED MESSAGES (${items.length})${c.reset}`);
    items.forEach((item, index) => {
      const time = item.enqueuedAt ? new Date(item.enqueuedAt).toLocaleTimeString() : '';
      const preview = item.text.replace(/\s+/g, ' ');
      const truncated = preview.length > 70 ? `${preview.slice(0, 67)}...` : preview;
      console.log(`  ${c.bold}#${index + 1}${c.reset} [${c.amber}${item.id}${c.reset}] ${c.slate}(${item.source || 'human'} · ${time})${c.reset}: ${truncated}`);
    });
    console.log(`  ${c.slate}💡 Dùng /queue cancel <id> để hủy hoặc /queue clear để xóa hàng đợi.${c.reset}\n`);
  }

  static getPromptSymbol(): string {
    return `${c.geminiCyan || c.brightCyan}${c.bold}❯${c.reset} `;
  }
}

export const formatMarkdownTerminal = CLI.formatMarkdownTerminal;
export const renderTaskCancelledToast = CLI.renderTaskCancelledToast.bind(CLI);
export const renderPromptInputNotice = CLI.renderPromptInputNotice.bind(CLI);
