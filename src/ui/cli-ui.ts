import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import { FileMentionEngine, AttachedItemSummary } from '../workspace/file-attachment.js';
import { TreeScanResult, TreeNode, getFileExtensionBadge } from '../workspace/tree-explorer.js';
import { ContextInspectionReport } from '../context/context-inspector.js';

export interface UICollapsePreferences {
  thinking: boolean;    // Thu gọn suy luận System 2 (CoT)
  tools: boolean;       // Thu gọn kết quả tool dài
  diff: boolean;        // Thu gọn diff patch dài
  treeDepth: number;    // Độ sâu mặc định khi explore cây thư mục
  compactSteps?: boolean; // Thu gọn toàn bộ step thành 1 line duy nhất (Antigravity Ctrl+O)
}

export const DEFAULT_COLLAPSE_PREFERENCES: UICollapsePreferences = {
  thinking: true,
  tools: true,
  diff: false,
  treeDepth: 3,
  compactSteps: false,
};

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

  // Codex & Antigravity signature palette tokens
  emerald: '\x1b[38;5;48m',
  teal: '\x1b[38;5;50m',
  slate: '\x1b[38;5;244m',
  amber: '\x1b[38;5;214m',
  crimson: '\x1b[38;5;196m',
  purple: '\x1b[38;5;141m',
  indigo: '\x1b[38;5;75m',

  // Google Antigravity & DeepMind signature TrueColor palette
  geminiCyan: '\x1b[38;2;36;200;219m',
  geminiBlue: '\x1b[38;2;66;133;244m',
  geminiPurple: '\x1b[38;2;161;110;255m',
  geminiAmber: '\x1b[38;2;251;188;4m',
  geminiGreen: '\x1b[38;2;52;168;83m',
  geminiRed: '\x1b[38;2;234;67;53m',
  subtleBorder: '\x1b[38;2;75;85;99m',
  mutedText: '\x1b[38;2;156;163;175m',
  cardBg: '\x1b[48;2;30;35;45m',

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
  { command: '/collapse', usage: '/collapse [thinking|tools|diff|on|off|status]', description: 'Quản lý thu gọn/mở rộng các khối suy luận CoT và tool outputs (Antigravity Style)', category: 'UI & Display', aliases: ['/fold'] },
  { command: '/explore', usage: '/explore [tree|context|reasoning|memory|tools|tasks] [args]', description: 'Khám phá sâu cây thư mục, ngữ cảnh tác nhân, hoặc chuỗi suy luận', category: 'Exploration', aliases: ['/inspect'] },
  { command: '/tree', usage: '/tree [path] [depth]', description: 'Xem cây cấu trúc thư mục dự án phân cấp với kích thước tệp', category: 'Workspace', aliases: ['/dirtree'] },
  { command: '/context', usage: '/context [inspect|prune|compact]', description: 'Kiểm soát và phân tích các tầng token trong Context Window', category: 'Context', aliases: ['/ctx'] },
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

    // 1. Kiểm tra nếu người dùng đang gõ @mention file / thư mục
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
              : item.sizeBytes ? `${c.gray}(${(item.sizeBytes / 1024).toFixed(1)} KB)${c.reset}` : '';
            const marker = index === 0 ? '›' : ' ';
            return `${c.cyan}${marker}${c.reset} ${icon} ${c.brightCyan}${c.bold}${pathLabel}${c.reset} ${sizeInfo}`;
          });

          const footer = `${c.slate}  ${c.teal}[Tab]${c.slate} Hoàn thành @path • ${c.teal}[Enter]${c.slate} Gửi đính kèm • ${c.teal}[Esc]${c.slate} Đóng${c.reset}`;
          this.renderBelowInput(
            [`${c.geminiCyan}${c.bold}📎 GỢI Ý ĐÍNH KÈM FILE / THƯ MỤC (@):${c.reset}`, ...rows, footer],
            activeColumn,
          );
          this.visible = true;
          this.renderKey = nextRenderKey;
          return;
        }
      }
    }

    // 2. Kiểm tra nếu là Slash Command (/...)
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
        const footer = `${c.slate}  ${c.teal}[Tab]${c.slate} Hoàn thành • ${c.teal}[Enter]${c.slate} Thực thi • ${c.teal}[↑/↓]${c.slate} Lịch sử • ${c.teal}[/help]${c.slate} Trợ giúp${c.reset}`;
        this.renderBelowInput(
          [`${c.geminiCyan}${c.bold}⚡ GỢI Ý LỆNH NHANH (SLASH COMMANDS):${c.reset}`, ...rows, footer],
          activeColumn,
        );
        this.visible = true;
        this.renderKey = nextRenderKey;
        return;
      }
    }

    // 3. Nếu không phải lệnh Slash (/) hoặc @mention, dọn sạch hàng gợi ý để trả lại input sạch cho readline
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

    if (maxRows === 0) return;

    let buf = '\x1b[?25l'; // Ẩn con trỏ

    // Ghi từng dòng hint kèm xóa sạch dòng cũ (Clear Line \x1b[2K)
    for (let i = 0; i < maxRows; i++) {
      const lineContent = i < nextRows ? lines[i] : '';
      buf += `\r\n\x1b[2K${lineContent}`;
    }

    // Di chuyển con trỏ ngược lên lại chính xác số dòng đã xuống để trở về đúng dòng prompt của readline
    buf += `\x1b[${maxRows}A`;
    // Đảm bảo vị trí cột ngang chính xác
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

/**
 * Bảng màu TrueColor 24-bit RGB cho chú mèo Minus Cat:
 * Mắt màu Electric Cyan / Emerald, Mũi & Miệng màu Ruby Coral nổi bật, Dễ quan sát
 */
export const CAT_PALETTE: Record<string, RGB | null> = {
  '.': null,                     // Trong suốt (Transparent)
  'O': [255, 145, 0],            // Lông cam vàng ấm áp (Golden Orange)
  'D': [195, 90, 0],             // Đổ bóng lông cam đậm
  'W': [255, 255, 255],          // Mõm & bụng trắng tinh (Crisp White)
  'P': [255, 175, 205],          // Tai trong hồng phấn (Sakura Pink)
  'E': [0, 240, 255],            // Mắt Cyan phát sáng cực rõ (Electric Cyan Eyes)
  'G': [0, 255, 150],            // Mắt Emerald xanh lá (Emerald Green Eyes)
  'N': [15, 25, 45],             // Đồng tử đen sâu (Navy Pupil)
  'Y': [255, 255, 255],          // Điểm sáng lấp lánh trong mắt (Sparkle)
  'M': [255, 45, 95],            // Mũi & Miệng màu Ruby Coral siêu nổi bật!
  'V': [255, 120, 160],          // Lưỡi & viền môi tươi tắn
  'K': [40, 45, 55],             // Khung Laptop xám đen
  'L': [0, 255, 200],            // Màn hình Laptop phát sáng Cyan-Mint
  'C': [245, 235, 215],          // Ly cà phê gốm sứ
  'F': [125, 65, 25],            // Cà phê Espresso
  'S': [130, 220, 255],          // Khói cà phê / Bong bóng Z / Ánh sao
  'H': [25, 25, 30],             // Kính râm đen
  'Q': [0, 255, 120],            // Ký tự Matrix Neon xanh lá trên kính
  'R': [255, 50, 80],            // Lửa phản lực Turbo / Trái tim
  'T': [0, 220, 170],            // Vòng cổ MINUS ngọc lục bảo
};

const SPRITE_CODING: PixelSprite = {
  name: 'Minus Cat (Hacker / Coding)',
  badge: '⚡ Coding Mode',
  width: 16,
  height: 14,
  palette: CAT_PALETTE,
  rows: [
    '....OO....OO....',
    '...OPOO..OPOO...',
    '..OOOOOOOOOOOO..',
    '..OOOOOOOOOOOO..',
    '.OOEEYOOEEYOOO..',
    '.OOENEOOENEOOO..',
    '.OOWWWMMWWWWOO..',
    '..OWWVWWVWWO....',
    '..OOWWWWWWOO....',
    '..OKKKKKKKKO....',
    '.OKLLLLLLLLKO...',
    '.OKLLLLLLLLKO...',
    '.OOWWKKKKWWOO...',
    '..WWWW..WWWW....',
  ],
};

const SPRITE_WAVING: PixelSprite = {
  name: 'Minus Cat (Waving)',
  badge: '🐾 Ready to code!',
  width: 16,
  height: 14,
  palette: CAT_PALETTE,
  rows: [
    '....OO....OO.SS.',
    '...OPOO..OPO.SS.',
    '..OOOOOOOOOOOO..',
    '..OOOOOOOOOOOO..',
    '.OOEEYOO.DDD.SS.',
    '.OOENEOODDDDOO..',
    '.OOWWWMMWWWWOO..',
    '..OWWVMMVWWO.WW.',
    '..OOWWWWWWOO.WW.',
    '..OOTTTTTTOO....',
    '..OOOOOOOOOO....',
    '..OOWWWWWWOO....',
    '..WWWW..WWWW....',
    '..WWWW..WWWW....',
  ],
};

const SPRITE_COFFEE: PixelSprite = {
  name: 'Minus Cat (Coffee & Debug)',
  badge: '☕ Fueled by Coffee',
  width: 16,
  height: 14,
  palette: CAT_PALETTE,
  rows: [
    '....OO....OO..S.',
    '...OPOO..OPO.S..',
    '..OOOOOOOOOOOO.S',
    '..OOOOOOOOOOOO..',
    '.OODDDOODDDOOO..',
    '.OODDDOODDDOOO..',
    '.OOWWWMMWWWWOO..',
    '..OWWVMMVWWO....',
    '..OOWWWWWWOO....',
    '..OOWWCCCCWWOO..',
    '..OOWCFFFFCWWO..',
    '..OOWCCCCCCWWO..',
    '..WWWW..WWWW....',
    '..WWWW..WWWW....',
  ],
};

const SPRITE_HACKER: PixelSprite = {
  name: 'Minus Cat (Matrix Hacker)',
  badge: '🕶️ Access Granted',
  width: 16,
  height: 14,
  palette: CAT_PALETTE,
  rows: [
    '....OO....OO....',
    '...OPOO..OPOO...',
    '..OOOOOOOOOOOO..',
    '..OOOOOOOOOOOO..',
    '.OOHHHHHHHHHHOO.',
    '.OOHQHHHHQHHHOO.',
    '.OOWWWMMWWWWOO..',
    '..OWWWMMWWWO....',
    '..OOWWWWWWOO....',
    '..OOTTTTTTOO....',
    '..OOOOOOOOOO....',
    '..OOWWWWWWOO....',
    '..WWWW..WWWW....',
    '..WWWW..WWWW....',
  ],
};

const SPRITE_ROCKET: PixelSprite = {
  name: 'Minus Cat (Turbo Mode)',
  badge: '🚀 Full Speed',
  width: 16,
  height: 14,
  palette: CAT_PALETTE,
  rows: [
    '....OO....OO.RR.',
    '...OPOO..OPOORR.',
    '..OOOOOOOOOOOO..',
    '..OOOOOOOOOOOO..',
    '.OOGGYOOGGYOOO..',
    '.OOGNYOOGNYOOO..',
    '.OOWWWMMWWWWOO..',
    '..OWWVMMVWWO....',
    '..OOWWWWWWOO....',
    '..OORRRRRROO....',
    '..OORRRRRROO....',
    '..OOWWWWWWOO....',
    '..WWWW..WWWW....',
    '..WWWW..WWWW....',
  ],
};

const SPRITE_SLEEPING: PixelSprite = {
  name: 'Minus Cat (Cozy Standby)',
  badge: '💤 Standby Mode',
  width: 16,
  height: 14,
  palette: CAT_PALETTE,
  rows: [
    '....OO....OO..SS',
    '...OPOO..OPO.SS.',
    '..OOOOOOOOOOOO..',
    '..OOOOOOOOOOOO..',
    '.OODDDOODDDOOO..',
    '.OODDDOODDDOOO..',
    '.OOWWWMMWWWWOO..',
    '..OWWWMMWWWO....',
    '..OOWWWWWWOO....',
    '..OOOOOOOOOO....',
    '..OOWWWWWWOO....',
    '..OOWWWWWWOO....',
    '..WWWW..WWWW....',
    '..WWWW..WWWW....',
  ],
};

/**
 * Render ma trận Pixel Art 2D thành các dòng ký tự Half-Block 24-bit TrueColor RGB
 */
export function renderPixelSpriteToAnsiLines(sprite: PixelSprite): string[] {
  const lines: string[] = [];
  const { width, height, palette, rows } = sprite;

  for (let y = 0; y < height; y += 2) {
    const topRow = rows[y] || '';
    const bottomRow = rows[y + 1] || '';
    let line = '';
    let currentFg: RGB | null = null;
    let currentBg: RGB | null = null;

    for (let x = 0; x < width; x++) {
      const topChar = topRow[x] || '.';
      const bottomChar = bottomRow[x] || '.';
      const topRgb = palette[topChar] || null;
      const bottomRgb = palette[bottomChar] || null;

      if (!topRgb && !bottomRgb) {
        if (currentFg || currentBg) {
          line += '\x1b[39;49m';
          currentFg = null;
          currentBg = null;
        }
        line += ' ';
      } else if (topRgb && !bottomRgb) {
        // Nửa trên có màu, nửa dưới trong suốt -> Upper Block '▀' với FG = topRgb
        const fgCode = `\x1b[38;2;${topRgb[0]};${topRgb[1]};${topRgb[2]}m`;
        if (currentBg) {
          line += '\x1b[49m';
          currentBg = null;
        }
        line += fgCode + '▀';
        currentFg = topRgb;
      } else if (!topRgb && bottomRgb) {
        // Nửa trên trong suốt, nửa dưới có màu -> Lower Block '▄' với FG = bottomRgb
        const fgCode = `\x1b[38;2;${bottomRgb[0]};${bottomRgb[1]};${bottomRgb[2]}m`;
        if (currentBg) {
          line += '\x1b[49m';
          currentBg = null;
        }
        line += fgCode + '▄';
        currentFg = bottomRgb;
      } else if (topRgb && bottomRgb) {
        // Cả hai nửa đều có màu -> Lower Block '▄' với FG = bottomRgb và BG = topRgb
        const fgCode = `\x1b[38;2;${bottomRgb[0]};${bottomRgb[1]};${bottomRgb[2]}m`;
        const bgCode = `\x1b[48;2;${topRgb[0]};${topRgb[1]};${topRgb[2]}m`;
        line += fgCode + bgCode + '▄';
        currentFg = bottomRgb;
        currentBg = topRgb;
      }
    }

    if (currentFg || currentBg) {
      line += '\x1b[0m';
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Lấy Sprite linh vật Pixel TrueColor của Minus Cat theo hành động (hoặc ngẫu nhiên khi khởi động)
 */
export function getCatMascot(action?: CatMascotAction): CatMascotPose {
  const spriteMap: Record<CatMascotAction, PixelSprite> = {
    coding: SPRITE_CODING,
    waving: SPRITE_WAVING,
    coffee: SPRITE_COFFEE,
    hacker: SPRITE_HACKER,
    rocket: SPRITE_ROCKET,
    sleeping: SPRITE_SLEEPING,
  };

  const actions: CatMascotAction[] = ['coding', 'waving', 'coffee', 'hacker', 'rocket', 'sleeping'];
  const selectedAction = action || actions[Math.floor(Math.random() * actions.length)];
  const sprite = spriteMap[selectedAction] || SPRITE_CODING;

  return {
    action: selectedAction,
    name: sprite.name,
    badge: sprite.badge,
    lines: renderPixelSpriteToAnsiLines(sprite),
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

// Regex for stripping ANSI escape codes (including SGR, 24-bit TrueColor, 256 colors, cursor positioning, OSC codes)
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsiForDisplay(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * Tính toán độ rộng hiển thị thực tế (terminal column width) của chuỗi ký tự,
 * hỗ trợ chuẩn Unicode East-Asian Width (Emoji = 2 cột, CJK = 2 cột, combining mark = 0 cột).
 */
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

export function getTerminalWidth(defaultWidth = 80, minWidth = 60, maxWidth = 120): number {
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

export function renderContextProgressBar(usedTokens: number, maxTokens: number, barWidth = 14): string {
  if (maxTokens <= 0) return '';
  const percent = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
  const filled = Math.round((percent / 100) * barWidth);
  const barColor = percent > 85 ? c.crimson : percent > 65 ? c.amber : c.emerald;
  return `${barColor}${'█'.repeat(filled)}${c.slate}${'░'.repeat(Math.max(0, barWidth - filled))}${c.reset} ${c.bold}${percent}%${c.reset}`;
}

/**
 * Lớp điều khiển hiển thị Terminal UI/UX chuẩn phong cách Google Antigravity & MINUS CLI.
 */
export class CLI {
  /**
   * Hiển thị Banner mở đầu phong cách Google Antigravity & MINUS CLI kèm Linh vật Mèo Pixel Minus Cat
   */
  static renderBanner(opts: BannerOptions): void {
    const width = getTerminalWidth();
    const cat = getCatMascot(opts.mascotAction);
    const catLines = cat.lines;

    const availableRightWidth = Math.max(25, width - 28);
    const toolsPreview = opts.tools.slice(0, 4).join(', ') + (opts.tools.length > 4 ? ` ... (+${opts.tools.length - 4})` : '');

    const infoLines: string[] = [
      `${c.geminiPurple}🤖 Model:${c.reset}      ${c.bold}${opts.modelName}${c.reset}`,
      `${c.geminiBlue}📂 Workspace:${c.reset}  ${c.mutedText}${truncateDisplayText(opts.workspaceRoot, Math.max(15, availableRightWidth - 14))}${c.reset}`,
      `${c.geminiCyan}🌿 Branch:${c.reset}     ${c.brightCyan}${opts.activeBranch || 'main'}${c.reset}`,
      `${c.geminiGreen}🛡️  Sandbox:${c.reset}    ${opts.sandboxStatus || `${c.emerald}Active (Local)${c.reset}`}`,
      `${c.geminiAmber}⚡ Max Steps:${c.reset}  ${c.bold}${opts.maxSteps}${c.reset} steps per turn budget`,
      `${c.teal}🛠️  Tools (${opts.tools.length}):${c.reset}  ${c.mutedText}${truncateDisplayText(toolsPreview, Math.max(15, availableRightWidth - 14))}${c.reset}`,
      `${c.slate}💡 Lệnh nhanh:${c.reset}  Nhập ${c.brightCyan}/${c.slate} hoặc ${c.brightCyan}/help${c.slate} để mở menu${c.reset}`,
    ];

    console.log(`\n  ${c.geminiCyan}${c.bold}⚡ MINUS / ANTIGRAVITY AGENT${c.reset} ${c.slate}v2.5 (Autonomous Pair Programmer)${c.reset}`);
    console.log(`  ${c.mutedText}Evidence-First • Unified Patch Engine • Closed-Loop Verification${c.reset}\n`);

    if (width < 72) {
      for (const line of catLines) {
        console.log(`  ${line}`);
      }
      console.log('');
      for (const info of infoLines) {
        console.log(`  ${info}`);
      }
    } else {
      const maxRows = Math.max(catLines.length, infoLines.length);
      for (let i = 0; i < maxRows; i++) {
        const leftCol = padRightVisible(catLines[i] ? `  ${catLines[i]}` : '', 22);
        const rightCol = infoLines[i] || '';
        console.log(`${leftCol}  ${rightCol}`);
      }
    }

    console.log(`\n  ${c.geminiGreen}🐱 ${cat.name}:${c.reset} ${c.slate}${cat.badge}${c.reset} • ${c.mutedText}Nhập ${c.brightCyan}/model${c.mutedText} để đổi LLM model.${c.reset}\n`);
  }

  /**
   * Hiển thị thanh gợi ý lệnh nhanh (Responsive Antigravity Palette)
   */
  static renderQuickCommands(): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('⚡ MINUS / ANTIGRAVITY COMMAND PALETTE', c.geminiCyan, width)}`);
    for (const cmd of SLASH_COMMANDS) {
      const aliasStr = cmd.aliases?.length ? ` ${c.slate}(${cmd.aliases.join(', ')})${c.reset}` : '';
      const usageStr = (cmd.usage || cmd.command).padEnd(26);
      const catBadge = cmd.category ? `${c.geminiPurple}[${cmd.category}]${c.reset} ` : '';
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}${usageStr}${c.reset} ${catBadge}${c.mutedText}${cmd.description}${aliasStr}${c.reset}`);
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
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
   * Hiển thị bảng trợ giúp (Antigravity Command Catalog)
   */
  static renderHelp(): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('📖 MINUS CLI COMMAND CATALOG & GUIDE', c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);
    
    const byCategory = new Map<string, SlashCommandDefinition[]>();
    for (const cmd of SLASH_COMMANDS) {
      const cat = cmd.category || 'General';
      const list = byCategory.get(cat) || [];
      list.push(cmd);
      byCategory.set(cat, list);
    }

    for (const [category, cmds] of byCategory.entries()) {
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}❖ ${category.toUpperCase()}:${c.reset}`);
      for (const item of cmds) {
        const usage = (item.usage || item.command).padEnd(28);
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}    ${c.brightCyan}${usage}${c.reset} ${c.mutedText}${item.description}${c.reset}`);
      }
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);
    }

    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}VÍ DỤ TÁC VỤ THỰC TẾ:${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}    ${c.slate}> Tìm trong src xem class AgentLoop ở file nào${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}    ${c.slate}> Đọc package.json và giải thích các scripts${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}    ${c.slate}> Sửa lỗi trong src/tools/read-file.ts và chạy npm test để kiểm chứng${c.reset}`);
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Liệt kê danh mục Tool (Antigravity Tool Registry)
   */
  static renderTools(toolList: Array<{ name: string; description: string }>): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader(`🛠️  REGISTERED TOOL CATALOG (${toolList.length} Tools)`, c.geminiGreen, width)}`);
    for (const tool of toolList) {
      const descSnippet = truncateDisplayText(tool.description, Math.max(20, width - 32));
      console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}${tool.name.padEnd(24)}${c.reset} ${c.mutedText}${descSnippet}${c.reset}`);
    }
    console.log(`${createBoxFooter(c.geminiGreen, width)}\n`);
  }

  /**
   * Hiển thị thông tin workspace hiện tại
   */
  static renderWorkspaceInfo(workspaceRoot: string): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('📂 ACTIVE WORKSPACE', c.geminiBlue, width)}`);
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.bold}Đường dẫn:${c.reset} ${c.brightCyan}${workspaceRoot}${c.reset}`);
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.slate}Để đổi thư mục, dùng: ${c.brightCyan}/workspace <đường_dẫn_mới>${c.slate} hoặc ${c.brightCyan}/cd <path>${c.reset}`);
    console.log(`${createBoxFooter(c.geminiBlue, width)}\n`);
  }

  /**
   * Hiển thị thông báo khi thay đổi workspace thành công
   */
  static renderWorkspaceChanged(oldPath: string, newPath: string): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('📂 ĐỔI WORKSPACE THÀNH CÔNG', c.geminiGreen, width)}`);
    console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.slate}Thư mục cũ:${c.reset} ${c.dim}${oldPath}${c.reset}`);
    console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.emerald}${c.bold}Thư mục mới:${c.reset} ${c.brightCyan}${c.bold}${newPath}${c.reset}`);
    console.log(`${createBoxFooter(c.geminiGreen, width)}\n`);
  }

  /**
   * Hiển thị danh sách các Shadow Git Checkpoints đã lưu
   */
  static renderCheckpoints(checkpoints: Array<{ index: number; timestamp: string; description: string }>): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader(`🛡️  SHADOW GIT CHECKPOINTS HISTORY (${checkpoints.length} Snapshots)`, c.geminiAmber, width)}`);
    if (checkpoints.length === 0) {
      console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.mutedText}Chưa có checkpoint nào được tạo trong phiên làm việc này.${c.reset}`);
    } else {
      for (const cp of checkpoints) {
        console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.brightCyan}#${cp.index}${c.reset} [${c.slate}${cp.timestamp}${c.reset}] ${c.bold}${cp.description}${c.reset}`);
      }
    }
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Dùng lệnh ${c.brightCyan}/undo${c.slate} để hoàn tác về checkpoint gần nhất.${c.reset}`);
    console.log(`${createBoxFooter(c.geminiAmber, width)}\n`);
  }

  /**
   * Hiển thị Cây kế hoạch động với Progress Bar chuẩn Codex & Antigravity CLI
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

    const width = getTerminalWidth();
    const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
    const total = tasks.length;
    const percent = Math.round((completed / total) * 100);
    const barWidth = Math.min(24, Math.max(10, Math.floor(width * 0.22)));
    const filledWidth = Math.round((percent / 100) * barWidth);
    const progressBar = `${c.emerald}${'█'.repeat(filledWidth)}${c.slate}${'░'.repeat(Math.max(0, barWidth - filledWidth))}${c.reset}`;

    const title = `📋 DYNAMIC PLAN PROGRESS [${progressBar}] ${c.emerald}${percent}%${c.reset} (${completed}/${total} Tasks)`;
    console.log(`\n${createBoxHeader(title, c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);
    
    for (const t of tasks) {
      let icon = `${c.slate}[ ]${c.reset}`;
      let titleStyle = c.mutedText;

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

      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${icon} ${c.bold}${t.id}.${c.reset} ${titleStyle}${t.title}${c.reset}`);
      if (t.status === 'IN_PROGRESS' && t.acceptanceCriteria) {
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}      ${c.geminiAmber}↳ Criteria:${c.reset} ${c.mutedText}${t.acceptanceCriteria}${c.reset}`);
      }
      if (t.evidence?.length) {
        const evidence = t.evidence.map((item) => `${c.teal}${item.toolName}${c.reset}:${c.emerald}${item.outcome}${c.reset}`).join(', ');
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}      ${c.slate}↳ Evidence:${c.reset} ${evidence}`);
      }
      if (t.notes) {
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}      ${c.slate}↳ ${t.notes}${c.reset}`);
      }
    }

    console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị Unified Diff Highlighted Renderer chuẩn Antigravity / Codex CLI
   */
  static renderDiff(diffText: string, options: { filePath?: string; status?: 'MODIFIED' | 'CREATED' | 'DELETED' } = {}): void {
    const lines = diffText.trim().split('\n');
    const width = getTerminalWidth();
    const headerTitle = options.filePath ? `📝 ${options.status || 'MODIFIED'}: ${options.filePath}` : '📝 UNIFIED DIFF PATCH';
    
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}`);
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${createBoxHeader(headerTitle, c.teal, Math.max(40, width - 6))}`);
    
    for (const line of lines.slice(0, 30)) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.slate}${line}${c.reset}`);
      } else if (line.startsWith('@@')) {
        console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.brightCyan}${line}${c.reset}`);
      } else if (line.startsWith('+')) {
        console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.emerald}+ ${line.slice(1)}${c.reset}`);
      } else if (line.startsWith('-')) {
        console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.crimson}- ${line.slice(1)}${c.reset}`);
      } else {
        console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.mutedText}  ${line}${c.reset}`);
      }
    }

    if (lines.length > 30) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.teal}│${c.reset} ${c.slate}... (+${lines.length - 30} lines diff)${c.reset}`);
    }
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${createBoxFooter(c.teal, Math.max(40, width - 6))}`);
  }

  /**
   * Hiển thị cảnh báo Self-Reflection & Debugging Protocol
   */
  static renderReflectionAlert(failures: number, advice?: string): void {
    if (failures < 3) {
      return;
    }
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}`);
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}⚠️ [Self-Correction Protocol Activated (Consecutive Failures: ${failures})]${c.reset}`);
    if (advice) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.mutedText}↳ ${advice}${c.reset}`);
    }
  }

  /**
   * Hiển thị Bộ nhớ dài hạn của dự án
   */
  static renderMemory(data: any): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🧠 PROJECT KNOWLEDGE BASE (.codingagent/project-memory.json)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Dự án:${c.reset}       ${c.brightCyan}${data.projectName}${c.reset} (${c.slate}${data.projectType}${c.reset})`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Package Mgr:${c.reset} ${c.yellow}${data.packageManager}${c.reset}`);
    
    const scriptKeys = Object.keys(data.scripts || {});
    if (scriptKeys.length > 0) {
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Scripts:${c.reset}     ${c.mutedText}${scriptKeys.map((k: string) => `${k} (npm run ${k})`).slice(0, 4).join(', ')}${c.reset}`);
    }

    const insights = data.learnedInsights || [];
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Kinh nghiệm:${c.reset} ${c.emerald}${insights.length} quy ước đã ghi nhớ${c.reset}`);
    if (insights.length > 0) {
      for (const item of insights.slice(-4)) {
        console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.geminiAmber}◆ [${item.key}]${c.reset} ${c.mutedText}${item.insight}${c.reset}`);
      }
    }

    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Hiển thị trạng thái môi trường Sandbox
   */
  static renderSandbox(status: any): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🛡️  EXECUTION SANDBOX STATUS', c.geminiGreen, width)}`);
    console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.bold}Provider:${c.reset}        ${c.brightCyan}${status.activeProvider}${c.reset}`);
    console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.bold}Chế độ:${c.reset}          ${c.yellow}${status.mode.toUpperCase()}${c.reset}`);
    console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.bold}Cách ly (Isolated):${c.reset} ${status.isIsolated ? `${c.emerald}✔ CÔ LẬP HOÀN TOÀN (Docker)` : `${c.amber}⚠ HOST OS (Có bộ lọc Allowlist)`}${c.reset}`);
    if (status.containerId) {
      console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.bold}Container ID:${c.reset}    ${c.slate}${status.containerId}${c.reset}`);
      console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.bold}Docker Image:${c.reset}    ${c.slate}${status.image}${c.reset}`);
    }
    console.log(`${createBoxFooter(c.geminiGreen, width)}\n`);
  }

  /**
   * Hiển thị danh sách các Background Tasks đang chạy
   */
  static renderTasks(tasks: Array<{ id: string; command: string; status: string; startedAt: string; pid?: number }>): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader(`⚙️  BACKGROUND PROCESSES & TASKS (${tasks.length})`, c.geminiCyan, width)}`);
    if (tasks.length === 0) {
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.mutedText}Không có background task nào đang chạy.${c.reset}`);
    } else {
      for (const t of tasks) {
        const statusBadge = t.status === 'running'
          ? `${c.emerald}RUNNING (PID: ${t.pid || 'N/A'})${c.reset}`
          : `${c.slate}STOPPED${c.reset}`;
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}[${t.id}]${c.reset} ${c.brightCyan}${t.command}${c.reset} ── ${statusBadge} ${c.slate}(Khởi chạy lúc: ${t.startedAt})${c.reset}`);
      }
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị trạng thái hiện tại (Antigravity Telemetry HUD)
   */
  static renderStatus(opts: StatusOptions): void {
    const width = getTerminalWidth();
    const goalStatus = opts.isGoalMode
      ? `${c.emerald}${c.bold}ON (Unlimited steps ∞)${c.reset}`
      : `${c.yellow}OFF (${opts.maxSteps} steps)${c.reset}`;

    console.log(`\n${createBoxHeader('📊 SESSION TELEMETRY & STATUS', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Model:${c.reset}         ${c.brightCyan}${opts.modelName}${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Workspace:${c.reset}     ${c.slate}${opts.workspaceRoot}${c.reset}`);
    if (opts.sandboxStatus) {
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Sandbox:${c.reset}       ${opts.sandboxStatus}`);
    }
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Goal Mode:${c.reset}     ${goalStatus}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Max Steps:${c.reset}     ${c.yellow}${opts.maxSteps} steps${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Session Turns:${c.reset} ${c.emerald}${opts.sessionTurns} completed${c.reset}`);
    if (opts.sessionFile) {
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Persisted in:${c.reset}  ${c.slate}${opts.sessionFile}${c.reset}`);
    }
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Hiển thị thông tin cấu hình phiên làm việc đã lưu trữ
   */
  static renderSessionInfo(data: { modelName?: string; workspacePath?: string; activeSessionId?: string; lastUpdated?: string }, sessionFile: string): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('💾 PERSISTED SESSION CONFIG (.codingagent/session.json)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Model đã lưu:${c.reset}     ${c.brightCyan}${data.modelName || 'Chưa đặt'}${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Workspace đã lưu:${c.reset} ${c.slate}${data.workspacePath || 'Chưa đặt'}${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Session đang dùng:${c.reset} ${c.brightCyan}${data.activeSessionId || 'Chưa tạo'}${c.reset}`);
    if (data.lastUpdated) {
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Cập nhật lúc:${c.reset}     ${c.slate}${data.lastUpdated}${c.reset}`);
    }
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Tệp lưu trữ:${c.reset}      ${c.slate}${sessionFile}${c.reset}`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Hiển thị cảnh báo phiên làm việc bị gián đoạn/tạm dừng dở dang (chỉ hiển thị khi thực sự còn task chưa xong)
   */
  static renderInterruptedSessionNotice(data: {
    interruptionType: string;
    activeDetail?: string;
    blocker?: string;
    isGoal?: boolean;
    isPlan?: boolean;
  }): void {
    console.log(`\n${c.amber}${c.bold}⚠️  [PHÁT HIỆN PHIÊN BỊ TẠM DỪNG / GIÁN ĐOẠN TRƯỚC ĐÓ]${c.reset}`);
    console.log(`   ${c.slate}Loại tiến trình:${c.reset} ${c.geminiPurple}${data.interruptionType}${c.reset}`);
    if (data.blocker) {
      console.log(`   ${c.slate}Lý do dừng:${c.reset} ${c.amber}${data.blocker}${c.reset}`);
    }
    if (data.activeDetail) {
      console.log(`   ${c.slate}Tiến độ hiện tại:${c.reset} ${c.brightCyan}${data.activeDetail}${c.reset}`);
    }
    console.log(`   💡 ${c.emerald}${c.bold}Chỉ cần gõ ${c.brightCyan}/resume${c.emerald}${c.bold} để tiếp tục thực thi chính xác từ bước này.${c.reset}`);
    console.log(`   💡 ${c.slate}Gõ ${c.bold}/model${c.reset} ${c.slate}nếu bạn muốn đổi provider/model trước khi tiếp tục.${c.reset}\n`);
  }

  /**
   * Hiển thị banner khi khởi chạy nhiệm vụ Goal Mode (Antigravity Autonomous Goal)
   */
  static renderGoalBanner(goalText: string): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🎯 AUTONOMOUS GOAL MODE (UNLIMITED STEPS ∞)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}MỤC TIÊU:${c.reset} ${c.bold}${goalText}${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.mutedText}Chế độ tự trị không giới hạn số bước (Step limit = ∞) cho tới khi hoàn tất.${c.reset}`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}`);
  }

  /**
   * Hiển thị trạng thái Goal Mode
   */
  static renderGoalStatus(enabled: boolean): void {
    const width = getTerminalWidth();
    const statusText = enabled ? `${c.emerald}${c.bold}BẬT (ON - Unlimited Steps ∞)${c.reset}` : `${c.yellow}${c.bold}TẮT (OFF - Mặc định 30 bước)${c.reset}`;
    console.log(`\n${createBoxHeader('🎯 TRẠNG THÁI CHẾ ĐỘ GOAL (GOAL MODE)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}Trạng thái hiện tại:${c.reset} ${statusText}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Cách dùng:${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/goal <nội dung mục tiêu>${c.reset} : Chạy ngay mục tiêu không giới hạn bước`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/goal on${c.reset}                 : Bật chế độ không giới hạn cho mọi yêu cầu`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/goal off${c.reset}                : Tắt chế độ không giới hạn (về 30 bước)`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Đầu mỗi Step trong AgentLoop (Antigravity Responsive Step Header)
   */
  static renderStepHeader(step: number, maxSteps: number): void {
    const width = getTerminalWidth();
    const isUnlimited = !isFinite(maxSteps) || maxSteps >= 9999;
    const progress = isUnlimited ? `${step}/∞ [AUTONOMOUS GOAL]` : `${step}/${maxSteps}`;
    const title = `⚡ STEP ${progress}`;
    const barLen = Math.max(4, width - title.length - 6);
    console.log(`\n${c.geminiBlue}${c.bold}╭── ${c.brightCyan}${title}${c.geminiBlue} ${'─'.repeat(barLen)}${c.reset}`);
  }

  /**
   * Hiển thị trạng thái Reasoning (System 2) - Tóm tắt hành vi/ý định suy luận của LLM
   */
  static renderLLMThinking(summary?: string): void {
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}`);
    const text = summary && summary.trim() ? summary.trim() : 'Analyzing context & deciding next action...';
    console.log(
      `${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiPurple}${c.bold}🧠 [REASONING]${c.reset} ${c.mutedText}${text}${c.reset}`,
    );
  }

  /**
   * Hiển thị luồng suy luận nội tâm sâu (System 2 Deep Reasoning / CoT)
   * Hỗ trợ cơ chế thu gọn (Collapse / Folded) phong cách Antigravity CLI
   */
  static renderReasoning(thoughtText: string, options: { collapsed?: boolean } = {}): void {
    if (!thoughtText || !thoughtText.trim()) return;
    const lines = thoughtText.trim().split('\n');
    const charCount = thoughtText.length;

    console.log(`${c.geminiBlue}${c.bold}│${c.reset}`);
    if (options.collapsed) {
      const preview = lines[0]?.slice(0, 60) || '';
      console.log(
        `${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiPurple}${c.bold}🧠 [REASONING]${c.reset} ${c.slate}▾ (${charCount.toLocaleString()} chars, ${lines.length} lines)${c.reset} ${c.mutedText}${preview}...${c.reset} ${c.slate}[/explore reasoning để mở rộng]${c.reset}`
      );
      return;
    }

    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiPurple}${c.bold}🧠 [DEEP REASONING - CoT]:${c.reset}`);
    for (const line of lines.slice(0, 12)) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.slate}${c.italic}${line}${c.reset}`);
    }
    if (lines.length > 12) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.gray}... (+${lines.length - 12} dòng suy luận • Nhập /explore reasoning để xem toàn bộ)${c.reset}`);
    }
  }

  /**
   * Hiển thị trạng thái thu gọn UI (Collapse Preferences)
   */
  static renderCollapseStatus(prefs: UICollapsePreferences): void {
    const width = getTerminalWidth();
    const compactBadge = prefs.compactSteps ? `${c.emerald}${c.bold}[✔ THU GỌN 1-LINE]${c.reset}` : `${c.yellow}${c.bold}[MỞ RỘNG (Expanded)]${c.reset}`;
    const thinkingBadge = prefs.thinking ? `${c.emerald}${c.bold}[✔ THU GỌN (Folded)]${c.reset}` : `${c.yellow}${c.bold}[MỞ RỘNG (Expanded)]${c.reset}`;
    const toolsBadge = prefs.tools ? `${c.emerald}${c.bold}[✔ THU GỌN (Preview)]${c.reset}` : `${c.yellow}${c.bold}[MỞ RỘNG (Full Raw)]${c.reset}`;
    const diffBadge = prefs.diff ? `${c.emerald}${c.bold}[✔ THU GỌN (>20 lines)]${c.reset}` : `${c.yellow}${c.bold}[MỞ RỘNG (Full Patch)]${c.reset}`;

    console.log(`\n${createBoxHeader('🗂️  CẤU HÌNH THU GỌN GIAO DIỆN (UI COLLAPSE PREFERENCES)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}1. Chế độ Step 1-Line (Compact Steps):${c.reset}  ${compactBadge} ${c.slate}(Bấm ${c.brightYellow}Ctrl+O${c.slate} để toggle)${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}2. Suy luận System 2 (Thinking / CoT):${c.reset} ${thinkingBadge}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}3. Kết quả Tool lớn (Tool Outputs):${c.reset}    ${toolsBadge}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}4. Khối Diff Patches (Diffs):${c.reset}          ${diffBadge}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.bold}5. Độ sâu cây thư mục mặc định:${c.reset}       ${c.brightCyan}${prefs.treeDepth} tầng${c.reset}`);
    console.log(`${createBoxDivider(c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Phím tắt & Lệnh chuyển đổi:${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightYellow}Ctrl + O${c.reset}                             : ${c.bold}Mở rộng (Expand) / Thu gọn (Shrink) 1-line step tức thì${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/collapse on${c.reset} | ${c.brightCyan}/shrink${c.reset}             : Bật chế độ thu gọn toàn bộ step thành 1 dòng`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/collapse off${c.reset} | ${c.brightCyan}/expand${c.reset}            : Mở rộng hiển thị chi tiết toàn bộ`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/collapse steps on|off${c.reset}           : Bật / tắt thu gọn các step thành 1 line`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/collapse thinking on|off${c.reset}        : Bật / tắt thu gọn suy luận CoT`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/collapse tools on|off${c.reset}           : Bật / tắt thu gọn kết quả tool`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightCyan}/collapse diff on|off${c.reset}            : Bật / tắt thu gọn diff code`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Hiển thị Menu Khám phá Antigravity Explorer
   */
  static renderExploreMenu(): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🧭 ANTIGRAVITY EXPLORER HUB (KHÁM PHÁ HỆ THỐNG)', c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Các không gian khám phá khả dụng:${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.brightYellow}🌳 /explore tree [path] [depth]${c.reset}     ${c.mutedText}: Khám phá cây thư mục dự án & kích thước tệp tin${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.brightCyan}🔍 /explore context${c.reset}                 ${c.mutedText}: Phân tích chi tiết các tầng token trong Context Window${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.geminiPurple}🧠 /explore reasoning${c.reset}               ${c.mutedText}: Mở rộng toàn bộ luồng suy luận nội tâm System 2 CoT${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.emerald}🧠 /explore memory${c.reset}                  ${c.mutedText}: Xem quy ước dự án và các bài học agent đã ghi nhớ${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.teal}🛠️  /explore tools${c.reset}                   ${c.mutedText}: Xem danh mục và kích thước schema của các Tool${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.slate}⚙️  /explore tasks${c.reset}                   ${c.mutedText}: Kiểm tra các tiến trình nền và subagents đang chạy${c.reset}`);
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị cây thư mục dự án theo cấu trúc phân cấp Antigravity
   */
  static renderWorkspaceTree(scanResult: TreeScanResult, options: { maxLines?: number } = {}): void {
    const width = getTerminalWidth();
    const maxLines = options.maxLines || 60;
    const title = `🌳 WORKSPACE DIRECTORY TREE (${scanResult.totalFiles} files, ${scanResult.totalDirectories} dirs • ${(scanResult.totalSizeBytes / 1024).toFixed(1)} KB)`;

    console.log(`\n${createBoxHeader(title, c.geminiGreen, width)}`);
    console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.bold}${c.brightYellow}📂 ${path.basename(scanResult.rootPath) || scanResult.rootPath}/${c.reset}`);

    const lines: string[] = [];

    function traverse(node: TreeNode, prefix: string, isTail: boolean) {
      if (lines.length >= maxLines) return;
      if (node.depth > 0) {
        const connector = isTail ? '└── ' : '├── ';
        const childPrefix = prefix + (isTail ? '    ' : '│   ');

        if (node.isDirectory) {
          const countStr = node.fileCount ? ` ${c.slate}(${node.fileCount} files)${c.reset}` : '';
          lines.push(`${c.geminiGreen}${c.bold}│${c.reset}  ${prefix}${connector}${c.brightYellow}📁 ${node.name}/${c.reset}${countStr}`);
          const children = node.children || [];
          children.forEach((child, index) => {
            traverse(child, childPrefix, index === children.length - 1);
          });
        } else {
          const badgeInfo = getFileExtensionBadge(node.extension || '');
          const color = (c as any)[badgeInfo.colorKey] || c.mutedText;
          const sizeStr = node.sizeBytes !== undefined ? ` ${c.slate}(${(node.sizeBytes / 1024).toFixed(1)} KB)${c.reset}` : '';
          lines.push(`${c.geminiGreen}${c.bold}│${c.reset}  ${prefix}${connector}${badgeInfo.icon} ${color}${node.name}${c.reset}${sizeStr}`);
        }
      } else {
        const children = node.children || [];
        children.forEach((child, index) => {
          traverse(child, '', index === children.length - 1);
        });
      }
    }

    traverse(scanResult.rootNode, '', true);

    for (const line of lines) {
      console.log(line);
    }

    if (scanResult.totalFiles + scanResult.totalDirectories > lines.length) {
      console.log(`${c.geminiGreen}${c.bold}│${c.reset}  ${c.slate}... (Hiển thị ${lines.length} mục • Dùng /tree <path> [depth] để khám phá sâu hơn)${c.reset}`);
    }

    console.log(`${createBoxFooter(c.geminiGreen, width)}\n`);
  }

  /**
   * Hiển thị bảng kiểm tra và phân tích chi tiết Context Window của Agent
   */
  static renderContextInspection(report: ContextInspectionReport): void {
    const width = getTerminalWidth();
    const gauge = renderContextProgressBar(report.totalEstimatedTokens, report.maxInputTokens, 16);
    const title = '🔍 AGENT CONTEXT INSPECTOR & TOKEN BREAKDOWN';

    console.log(`\n${createBoxHeader(title, c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Mô hình:${c.reset}        ${c.brightCyan}${report.modelName}${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Context Budget:${c.reset} [${gauge}] ${c.bold}${report.totalEstimatedTokens.toLocaleString()}${c.reset} / ${report.maxInputTokens.toLocaleString()} tokens (${report.utilizationPercent}%)`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Phiên làm việc:${c.reset} ${c.slate}${report.sessionId}${c.reset} (${report.turnCount} turns, ${report.messageCount} messages)`);
    console.log(`${createBoxDivider(c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}❖ PHÂN TẦNG DUNG LƯỢNG NGỮ CẢNH (CONTEXT LAYERS):${c.reset}`);

    for (let i = 0; i < report.layers.length; i++) {
      const layer = report.layers[i];
      const percentStr = `${layer.percentage}%`.padStart(5, ' ');
      const tokenStr = `${layer.estimatedTokens.toLocaleString()} tok`.padStart(11, ' ');
      console.log(
        `${c.geminiCyan}${c.bold}│${c.reset}    ${c.brightCyan}${i + 1}.${c.reset} ${c.bold}${layer.name.padEnd(30)}${c.reset} : ${c.geminiAmber}${tokenStr}${c.reset} (${c.emerald}${percentStr}${c.reset}) ── ${c.mutedText}${layer.description}${c.reset}`
      );
    }

    console.log(`${createBoxDivider(c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.geminiGreen}${c.bold}❖ ĐÁNH GIÁ SỨC KHỎE NGỮ CẢNH & KHUYẾN NGHỊ (HEALTH & ADVICE):${c.reset}`);
    for (const rec of report.recommendations) {
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}    ${c.mutedText}${rec}${c.reset}`);
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị chi tiết toàn bộ chuỗi suy luận System 2 Deep Reasoning
   */
  static renderReasoningInspection(data: { thought: string; timestamp?: string; step?: number; turn?: number }): void {
    const width = getTerminalWidth();
    const timeStr = data.timestamp ? ` • ${data.timestamp}` : '';
    const turnStr = data.turn ? `Turn ${data.turn}` : 'Current Turn';
    const stepStr = data.step ? ` • Step ${data.step}` : '';
    const title = `🧠 DEEP REASONING EXPLORER (${turnStr}${stepStr}${timeStr})`;

    console.log(`\n${createBoxHeader(title, c.geminiPurple, width)}`);
    if (!data.thought || !data.thought.trim()) {
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.mutedText}Chưa có chuỗi suy luận nào được ghi nhận trong lượt này.${c.reset}`);
    } else {
      const lines = data.thought.trim().split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineNum = `${i + 1}`.padStart(3, ' ');
        console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}${lineNum} │${c.reset} ${c.mutedText}${lines[i]}${c.reset}`);
      }
    }
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Thông báo hành động model (Antigravity System 1 Action Badge)
   */
  static renderModelAction(action: 'tool_call' | 'final_answer' | 'max_steps', detail?: string): void {
    if (action === 'tool_call') {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiCyan}⚙️  [ACTION]${c.reset} ${c.mutedText}${detail || 'Requesting tool execution...'}${c.reset}`);
    } else if (action === 'final_answer') {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.emerald}✨ [COMPLETED]${c.reset} Ready to provide final response.`);
    } else {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.crimson}⚠️ [CIRCUIT BREAKER]${c.reset} Max steps reached.`);
    }
  }

  /**
   * Hiển thị Tool Call chuẩn Antigravity / Codex CLI với Diff Preview nếu là tool sửa file
   */
  static renderToolCall(name: string, args: Record<string, any>): void {
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}`);
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}⚙️  [TOOL CALL]${c.reset} ${c.bold}${c.brightCyan}${name}${c.reset}`);

    const entries = Object.entries(args);
    entries.forEach(([k, v], idx) => {
      const isLast = idx === entries.length - 1;
      const prefix = isLast ? '└─' : '├─';
      const valStr = formatToolArgumentPreview(v);
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.slate}${prefix}${c.reset} ${c.teal}${k}:${c.reset} ${c.mutedText}${valStr}${c.reset}`);
    });

    // Nếu là apply_patch có chứa diff hunk, render trực quan diff
    if (name === 'apply_patch' && typeof args.patch === 'string') {
      CLI.renderDiff(args.patch, { filePath: args.filePath });
    }
  }

  /**
   * Hiển thị Tool Result (Antigravity Tool Output Visualizer)
   */
  static renderToolResult(name: string, durationMs: number, result: Record<string, any>): void {
    const isError = isToolResultFailure(result);
    const badge = isError
      ? `${c.crimson}${c.bold}✖ ERROR${c.reset}`
      : `${c.emerald}${c.bold}✔ OK${c.reset}`;
    const durationBadge = durationMs > 0 ? `${c.slate}(${durationMs}ms)${c.reset}` : '';

    console.log(`${c.geminiBlue}${c.bold}│${c.reset}`);
    console.log(`${c.geminiBlue}${c.bold}│${c.reset}  ${c.slate}📥 [RESULT]${c.reset} ${c.bold}${name}${c.reset} ➔ [${badge}] ${durationBadge}`);

    if (result.error) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.crimson}${result.error}${c.reset}`);
    } else if (result.content !== undefined) {
      const lines = String(result.content).split('\n');
      const preview = lines.slice(0, 4).map(l => `     ${c.mutedText}${l}${c.reset}`).join('\n');
      const more = lines.length > 4 ? `\n     ${c.slate}... (+${lines.length - 4} lines)${c.reset}` : '';
      console.log(preview + more);
    } else if (result.matches !== undefined) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.emerald}✔ Found ${result.totalMatches || result.matches.length} matching occurrences.${c.reset}`);
    } else if (result.stdout !== undefined || result.stderr !== undefined) {
      const codeStr = result.exitCode === 0 ? `${c.emerald}exit: 0${c.reset}` : `${c.crimson}exit: ${result.exitCode}${c.reset}`;
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     [${codeStr}]`);
      if (result.stdout) {
        const outLines = result.stdout.trim().split('\n').slice(0, 3);
        outLines.forEach((l: string) => console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.mutedText}${l}${c.reset}`));
      }
      if (result.stderr) {
        const errLines = result.stderr.trim().split('\n').slice(0, 3);
        errLines.forEach((l: string) => console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.crimson}${l}${c.reset}`));
      }
    } else if (result.message) {
      console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.emerald}${result.message}${c.reset}`);
    } else if (result.success === undefined || Object.keys(result).length > 1) {
      const { diagnostic, suggestion, prompt, hint, suggestionText, ...rest } = result;
      if (Object.keys(rest).length > 0) {
        const resStr = JSON.stringify(rest);
        const preview = resStr.length > 100 ? `${resStr.slice(0, 97)}...` : resStr;
        console.log(`${c.geminiBlue}${c.bold}│${c.reset}     ${c.mutedText}${preview}${c.reset}`);
      }
    }
  }

  /**
   * Hiển thị Step đã thực thi thành 1 line duy nhất (Antigravity Compact / Shrunk Step Mode)
   * Kích hoạt hoặc chuyển đổi thông qua tổ hợp phím Ctrl + O
   */
  static renderCompactStepLine(name: string, args: Record<string, any>, durationMs: number, result: Record<string, any>): void {
    const isError = isToolResultFailure(result);
    const badge = isError
      ? `${c.crimson}${c.bold}✖ ERR${c.reset}`
      : `${c.emerald}${c.bold}✔ OK${c.reset}`;
    const durationBadge = durationMs > 0
      ? (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`)
      : '0ms';

    // Tạo tóm tắt ngắn gọn của đối số
    let argSummary = '';
    if (args.path || args.filePath) argSummary = `"${args.path || args.filePath}"`;
    else if (args.command) argSummary = `"${String(args.command).slice(0, 35)}${String(args.command).length > 35 ? '...' : ''}"`;
    else if (args.query) argSummary = `"${String(args.query).slice(0, 30)}"`;
    else if (args.symbol) argSummary = `"${args.symbol}"`;
    else if (args.summary) argSummary = `"${String(args.summary).slice(0, 30)}..."`;
    else if (Object.keys(args).length > 0) {
      const firstKey = Object.keys(args)[0];
      const firstVal = String(args[firstKey]).slice(0, 25);
      argSummary = `${firstKey}=${firstVal}`;
    }

    // Tóm tắt kết quả
    let resultSummary = '';
    if (result.error) {
      resultSummary = `${c.crimson}${String(result.error).slice(0, 40)}${c.reset}`;
    } else if (result.created) {
      resultSummary = `${c.emerald}created${c.reset}`;
    } else if (result.hunksApplied !== undefined) {
      resultSummary = `${c.emerald}${result.hunksApplied} hunk(s) applied${c.reset}`;
    } else if (name === 'replace_text' && result.success) {
      resultSummary = `${c.emerald}1 match replaced${c.reset}`;
    } else if (name === 'write_file' && result.success) {
      resultSummary = `${c.emerald}written${c.reset}`;
    } else if (result.matches !== undefined) {
      resultSummary = `${c.emerald}${result.totalMatches || result.matches.length} match(es)${c.reset}`;
    } else if (result.stdout !== undefined) {
      resultSummary = result.exitCode === 0 ? `${c.slate}exit: 0${c.reset}` : `${c.crimson}exit: ${result.exitCode}${c.reset}`;
    } else if (result.message) {
      const cleanMsg = String(result.message).replace(/\s+/g, ' ').trim();
      resultSummary = `${c.mutedText}${cleanMsg.length > 35 ? cleanMsg.slice(0, 32) + '...' : cleanMsg}${c.reset}`;
    }

    const summaryParts = [resultSummary, durationBadge].filter(Boolean).join(', ');
    console.log(
      `${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiCyan}⚙️ ${c.bold}${name}${c.reset}${argSummary ? `(${c.slate}${argSummary}${c.reset})` : ''} ➔ [${badge}] ${c.slate}(${summaryParts})${c.reset}`
    );
  }

  /**
   * Hiển thị Toast thông báo trạng thái phím tắt Ctrl + O (Antigravity Expand / Shrink Step Switch)
   */
  static renderCtrlOToggleToast(isCompact: boolean): void {
    if (isCompact) {
      console.log(`\n  ${c.brightYellow}${c.bold}⚡ [Ctrl+O] Đã THU GỌN các step (1-line compact mode)${c.reset} ${c.slate}— Bấm Ctrl+O để mở rộng chi tiết${c.reset}\n`);
    } else {
      console.log(`\n  ${c.brightCyan}${c.bold}📖 [Ctrl+O] Đã MỞ RỘNG các step (Full verbose details mode)${c.reset} ${c.slate}— Bấm Ctrl+O để thu gọn thành 1 dòng${c.reset}\n`);
    }
  }

  /**
   * Hiển thị Prompt Caching & Token Telemetry theo chuẩn Antigravity HUD
   */
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
      `${c.geminiBlue}${c.bold}│${c.reset}  ${c.geminiCyan}⚡ [TELEMETRY]${c.reset} Context: [${progressMeter}] ${c.slate}(${promptTokens.toLocaleString()} tok)${c.reset} │ Prompt Cache: ${cachedTokens.toLocaleString()} tok [${hitBadge}] │ Out: ${c.yellow}${completionTokens.toLocaleString()}${c.reset} tok`
    );
  }

  /**
   * Hiển thị bảng điều khiển & chẩn đoán Prompt Caching theo chuẩn Antigravity
   */
  static renderPromptCacheDashboard(info: {
    modelName: string;
    preservePrefixCache: boolean;
    sessionId?: string;
    totalPromptTokens?: number;
    totalCachedTokens?: number;
    lastHitRate?: number;
  }): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('⚡ PROMPT CACHING ARCHITECTURE & DIAGNOSTICS', c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Mô hình hiện tại:${c.reset}       ${c.brightCyan}${info.modelName}${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Kiến trúc tiền tố:${c.reset}      ${c.emerald}✔ Immutable Static System Prompt at index 0${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Dynamic Context:${c.reset}        ${c.emerald}✔ Tail-End User Message Injection (Non-destructive)${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Tool Declarations:${c.reset}      ${c.emerald}✔ Deterministic Alphabetical Ordering${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Context Compactor:${c.reset}      ${info.preservePrefixCache ? c.emerald + '✔ KV-Cache Preservation Mode (Append-Only)' : c.yellow + '⚠ In-place Pruning (May invalidate cache)'}${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Affinity Routing:${c.reset}       ${c.emerald}✔ Session-ID & Prompt-Cache-Key HTTP Headers${c.reset}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Observability:${c.reset}          ${c.emerald}✔ Real-time Token Details & Hit Rate Telemetry${c.reset}`);
    if (info.sessionId) {
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Session Cache Key:${c.reset}      ${c.slate}${info.sessionId.slice(0, 32)}${c.reset}`);
    }
    if (info.lastHitRate !== undefined) {
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}Tỉ lệ Hit gần nhất:${c.reset}     ${c.geminiAmber}${c.bold}${info.lastHitRate}% hit rate${c.reset}`);
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị bảng tổng hợp các File & Thư mục được đính kèm vào User Prompt (@mention)
   */
  static renderAttachmentSummary(attachments: AttachedItemSummary[]): void {
    if (!attachments || attachments.length === 0) return;
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader(`📎 ĐÃ ĐÍNH KÈM VÀO NGỮ CẢNH (${attachments.length} mục)`, c.geminiCyan, width)}`);
    for (const item of attachments) {
      if (item.type === 'directory') {
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.geminiAmber}📁 ${item.path}/${c.reset} ${c.slate}(Thư mục • ${item.fileCount || 0} mục)${c.reset}`);
      } else {
        const sizeStr = `${(item.sizeBytes / 1024).toFixed(1)} KB`;
        const linesStr = item.lineCount !== undefined ? `${item.lineCount.toLocaleString()} dòng • ` : '';
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.emerald}📄 ${item.path}${c.reset} ${c.slate}(${linesStr}${sizeStr})${c.reset}`);
      }
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Cuối mỗi Step trong AgentLoop
   */
  static renderStepFooter(): void {
    const width = getTerminalWidth();
    console.log(`${c.geminiBlue}${c.bold}╰${'─'.repeat(Math.max(10, width - 2))}${c.reset}`);
  }

  /**
   * Format Markdown cơ bản sang Terminal ANSI styling phong cách Antigravity
   */
  static formatMarkdownTerminal(text: string): string {
    // Tách các khối fenced code blocks (```...```) để không format nhầm comment code # hoặc toán tử *
    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts
      .map((part) => {
        // Nếu là khối code fenced
        if (part.startsWith('```') && part.endsWith('```')) {
          const lines = part.split('\n');
          const firstLine = lines[0];
          const lang = firstLine.slice(3).trim();
          const codeLines = lines.slice(1, -1);
          const langTag = lang ? ` ${c.slate}[${lang}]${c.reset}` : '';
          const header = `\n  ${c.teal}╭─── Code${langTag} ${c.teal}${'─'.repeat(Math.max(10, 48 - (lang ? lang.length + 3 : 0)))}╮${c.reset}`;
          const body = codeLines.map((l) => `  ${c.teal}│${c.reset} ${c.brightCyan}${l}${c.reset}`).join('\n');
          const footer = `  ${c.teal}╰${'─'.repeat(Math.max(18, 56))}╯${c.reset}\n`;
          return `${header}\n${body}\n${footer}`;
        }

        // Format văn bản thông thường
        return part
          // Headers (chỉ khi có khoảng trắng sau dấu # ở đầu dòng)
          .replace(/^### (.*$)/gm, `${c.geminiCyan}${c.bold}❯ $1${c.reset}`)
          .replace(/^## (.*$)/gm, `\n${c.geminiAmber}${c.bold}❖ $1${c.reset}`)
          .replace(/^# (.*$)/gm, `\n${c.geminiCyan}${c.bold}══════════ $1 ══════════${c.reset}`)
          // Bold (**text**)
          .replace(/\*\*([^*]+)\*\*/g, `${c.bold}$1${c.reset}`)
          // Italic (*text* - tránh dính vào phép toán hoặc file glob như *.ts)
          .replace(/(^|\s)\*([^* \n][^*\n]*[^* \n])\*(\s|$)/g, `$1${c.italic}$2${c.reset}$3`)
          // Inline Code (`code`)
          .replace(/`([^`\n]+)`/g, `${c.brightCyan}$1${c.reset}`)
          // Bullet points
          .replace(/^(\s*)[-*]\s+/gm, `$1${c.emerald}•${c.reset} `)
          .replace(/^(\s*)(\d+)\.\s+/gm, `$1${c.geminiAmber}$2.${c.reset} `)
          // Blockquotes & Alerts
          .replace(/^>\s*\[!NOTE\]\s*(.*$)/gm, `  ${c.geminiBlue}ℹ NOTE:${c.reset} $1`)
          .replace(/^>\s*\[!TIP\]\s*(.*$)/gm, `  ${c.geminiGreen}💡 TIP:${c.reset} $1`)
          .replace(/^>\s*\[!IMPORTANT\]\s*(.*$)/gm, `  ${c.geminiAmber}⚡ IMPORTANT:${c.reset} $1`)
          .replace(/^>\s*\[!WARNING\]\s*(.*$)/gm, `  ${c.geminiRed}⚠️ WARNING:${c.reset} $1`)
          .replace(/^>\s*\[!CAUTION\]\s*(.*$)/gm, `  ${c.crimson}🛑 CAUTION:${c.reset} $1`);
      })
      .join('');
  }

  /**
   * Tự động loại bỏ các tiền tố quy tắc nội bộ / Verification Ladder thừa trước khi in ra màn hình
   */
  static cleanFinalAnswerContent(text: string): string {
    let cleaned = text.trim();

    // Xóa câu quy tắc thừa "Code changes must end with an explicit test/build verification step."
    cleaned = cleaned.replace(/^\s*Code changes must end with an explicit test\/build verification step\.?\s*/i, '');

    // Xóa khối "[Verification Ladder Result] ... [Final Result]" hoặc "[Verification Ladder Result] ..."
    cleaned = cleaned.replace(/^\s*\[Verification Ladder Result\][\s\S]*?\[Final Result\]\s*/i, '');
    cleaned = cleaned.replace(/^\s*\[Verification Ladder Result\][\s\S]*?(?=\n\n|\n[A-Z#Đ-Ưa-z])/i, '');
    cleaned = cleaned.replace(/^\s*\[Final Result\]\s*/i, '');

    return cleaned.trim();
  }

  /**
   * Hiển thị Final Answer chuẩn Codex CLI (in trực tiếp nội dung LLM không kèm viền header)
   */
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

  /**
   * Hiển thị thông báo dừng/lỗi thực thi chuẩn Codex CLI (Execution Stopped / Blocked Banner)
   */
  static async renderExecutionStopped(message: string, reason: string = 'STOPPED'): Promise<void> {
    const content = message.trim();
    console.log(`\n${c.crimson}${c.bold}╭── 🛑 AGENT EXECUTION STOPPED (${reason}) ──────────────────────────────────╮${c.reset}\n`);
    const formatted = CLI.formatMarkdownTerminal(content);
    console.log(formatted);
    console.log(`\n${c.crimson}${c.bold}╰────────────────────────────────────────────────────────────────────────────╯${c.reset}\n`);
  }

  /**
   * Hiển thị thông báo Toast ngắn gọn khi tác vụ bị hủy ngang qua Ctrl+C / Escape (Antigravity CLI Style)
   */
  static renderTaskCancelledToast(message: string = 'Đã dừng tác vụ đang thực thi theo yêu cầu của bạn (Ctrl+C / Esc).'): void {
    console.log(`\n${c.crimson}${c.bold}🛑 [CANCELLED]${c.reset} ${c.brightYellow}${message}${c.reset} ${c.dim}(Phiên và bộ nhớ đã được lưu an toàn)${c.reset}\n`);
  }


  /**
   * Hiển thị danh sách Skills và trạng thái kích hoạt
   */
  static renderSkills(skills: any[], activeDecisions: any[] = []): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🛠️  SUPERPOWERS SKILL REGISTRY', c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);

    const activeMap = new Map(activeDecisions.map((d: any) => [d.skillId, d]));

    for (const skill of skills) {
      const active = activeMap.get(skill.id);
      const statusBadge = active
        ? active.decision === 'activated'
          ? `${c.emerald}${c.bold}[ACTIVE]${c.reset}`
          : `${c.geminiAmber}${c.bold}[${active.decision.toUpperCase()}]${c.reset}`
        : `${c.slate}[INSTALLED]${c.reset}`;

      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${statusBadge} ${c.bold}${c.brightCyan}${skill.id}${c.reset} ${c.slate}(v${skill.version})${c.reset} - ${c.white}${skill.name}${c.reset}`);
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}     ${c.mutedText}${skill.description}${c.reset}`);
      if (skill.requires && skill.requires.length > 0) {
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}     ${c.teal}Requires:${c.reset} ${skill.requires.join(', ')}`);
      }
      if (skill.requiredCapabilities && skill.requiredCapabilities.length > 0) {
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}     ${c.geminiPurple}Capabilities:${c.reset} ${skill.requiredCapabilities.join(', ')}`);
      }
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị danh mục Capabilities
   */
  static renderCapabilities(capabilities: any[]): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('⚡ CAPABILITY CATALOG', c.geminiCyan, width)}`);
    console.log(`${c.geminiCyan}${c.bold}│${c.reset}`);

    const byCat = new Map<string, any[]>();
    for (const cap of capabilities) {
      const list = byCat.get(cap.category) || [];
      list.push(cap);
      byCat.set(cap.category, list);
    }

    for (const [cat, items] of byCat.entries()) {
      console.log(`${c.geminiCyan}${c.bold}│${c.reset}  ${c.bold}${c.geminiAmber}📂 ${cat.toUpperCase()}${c.reset}`);
      for (const cap of items) {
        const sideEffectColor = cap.sideEffect === 'none' ? c.emerald : c.crimson;
        const approvalBadge = cap.requiresApproval ? ` ${c.geminiAmber}[APPROVAL REQUIRED]${c.reset}` : '';
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}    • ${c.bold}${c.brightCyan}${cap.name}${c.reset} -> ${c.slate}${cap.toolName || 'system'}${c.reset}${approvalBadge}`);
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}      ${c.slate}Side-effect: ${sideEffectColor}${cap.sideEffect}${c.slate} | Reversible: ${cap.reversible} | Retryable: ${cap.retryable}${c.reset}`);
        console.log(`${c.geminiCyan}${c.bold}│${c.reset}      ${c.mutedText}${cap.description}${c.reset}`);
      }
    }
    console.log(`${createBoxFooter(c.geminiCyan, width)}\n`);
  }

  /**
   * Hiển thị danh sách yêu cầu phê duyệt
   */
  static renderApprovals(approvals: any[]): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🛡️  PENDING APPROVALS', c.geminiAmber, width)}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}`);

    if (approvals.length === 0) {
      console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.emerald}✔ Không có yêu cầu phê duyệt nào đang chờ.${c.reset}`);
    } else {
      for (const req of approvals) {
        console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.geminiAmber}${c.bold}⏳ [${req.id}]${c.reset} Action: ${c.bold}${req.action}${c.reset}`);
        console.log(`${c.geminiAmber}${c.bold}│${c.reset}     ${c.mutedText}${req.description}${c.reset}`);
        console.log(`${c.geminiAmber}${c.bold}│${c.reset}     ${c.slate}Requested at: ${req.requestedAt}${c.reset}`);
      }
    }
    console.log(`${createBoxFooter(c.geminiAmber, width)}\n`);
  }

  /**
   * Hiển thị thông tin trạng thái Permission Policy
   */
  static renderPermissionStatus(mode: string, approvedCount: number): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🔐 CẤU HÌNH PHÂN QUYỀN (PERMISSION GATEWAY)', c.geminiAmber, width)}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Chế độ hiện tại:${c.reset} ${c.bold}${c.brightCyan}${mode}${c.reset}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Danh mục đã auto-approve trong phiên:${c.reset} ${c.bold}${approvedCount}${c.reset}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Các chế độ khả dụng:${c.reset}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}    - ${c.bold}ask_sensitive${c.reset}  : Hỏi ý kiến khi chỉnh sửa file hoặc chạy lệnh nguy hiểm (Khuyên dùng)`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}    - ${c.bold}always_ask${c.reset}     : Luôn hỏi ý kiến trước mọi thao tác ghi/chạy lệnh`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}    - ${c.bold}auto_approve${c.reset}   : Tự động cho phép tất cả (Không khuyến nghị)`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}    - ${c.bold}read_only${c.reset}      : Chặn hoàn toàn mọi thao tác chỉnh sửa file và chạy lệnh`);
    console.log(`${createBoxFooter(c.geminiAmber, width)}\n`);
  }

  /**
   * Hiển thị khung yêu cầu phê duyệt Permission chuẩn Antigravity
   */
  static renderPermissionPrompt(request: {
    toolName: string;
    category: string;
    target: string;
    summary: string;
    riskLevel: string;
    details?: Record<string, any>;
  }): void {
    const width = getTerminalWidth();
    const riskColor = request.riskLevel === 'CRITICAL' ? `${c.crimson}${c.bold}` : request.riskLevel === 'HIGH' ? `${c.geminiAmber}${c.bold}` : `${c.yellow}${c.bold}`;
    console.log(`\n${createBoxHeader('⚠️  XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL)', c.geminiAmber, width)}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Công cụ:${c.reset}     ${c.bold}${request.toolName}${c.reset} (${request.category})`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Mục tiêu:${c.reset}    ${c.brightCyan}${request.target}${c.reset}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Mô tả:${c.reset}       ${request.summary}`);
    if (request.details?.misuse) {
      console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.geminiPurple}${c.bold}Gợi ý:${c.reset}       Bấm ${c.bold}'n'${c.reset} để từ chối và ép LLM dùng tool: ${c.brightCyan}${request.details.misuse.tool}${c.reset}`);
    }
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Mức rủi ro:${c.reset}  ${riskColor}[${request.riskLevel}]${c.reset}`);
    console.log(`${createBoxDivider(c.geminiAmber, width)}`);
    console.log(`${c.geminiAmber}${c.bold}│${c.reset}  ${c.slate}Phím tắt: ${c.emerald}[y]${c.reset} Duyệt 1 lần • ${c.cyan}[a]${c.reset} Duyệt luôn trong phiên • ${c.crimson}[n]${c.reset} Từ chối • ${c.dim}[q] Hủy${c.reset}`);
    console.log(`${createBoxFooter(c.geminiAmber, width)}`);
  }

  /**
   * Hiển thị bảng cấu hình Token của mô hình hiện tại kèm các gói đóng gói sẵn (Preset Tiers)
   */
  static renderTokenConfig(modelName: string, config: any, profile: any): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('📊 CẤU HÌNH TOKEN BUDGET & GÓI ĐÓNG GÓI SẴN (PRESETS)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Mô hình hiện tại:${c.reset}          ${c.bold}${modelName}${c.reset} ${c.slate}(Provider: ${profile.provider.toUpperCase()})${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Max Output Tokens:${c.reset}         ${c.bold}${c.emerald}${config.maxOutputTokens?.toLocaleString() ?? 'Mặc định'}${c.reset} ${c.slate}(Hỗ trợ tối đa: ${profile.maxSupportedOutputTokens.toLocaleString()})${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Max Input Tokens (Context):${c.reset} ${c.bold}${c.brightCyan}${config.maxInputTokens?.toLocaleString() ?? 'Mặc định'}${c.reset} ${c.slate}(Hỗ trợ tối đa: ${profile.maxSupportedInputTokens.toLocaleString()})${c.reset}`);
    
    if (profile.supportsThinkingBudget || config.thinkingBudget !== undefined) {
      const budgetStr = config.thinkingBudget === 0 ? 'TẮT (0)' : (config.thinkingBudget?.toLocaleString() ?? 'Tự động');
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Thinking Token Budget:${c.reset}     ${c.bold}${c.geminiPurple}${budgetStr}${c.reset}`);
    }
    if (profile.supportsReasoningEffort || config.reasoningEffort) {
      console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}Reasoning Effort:${c.reset}          ${c.bold}${c.geminiAmber}${config.reasoningEffort ?? 'medium'}${c.reset}`);
    }

    console.log(`${c.geminiPurple}${c.bold}│${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.brightCyan}${c.bold}📦 4 GÓI ĐÓNG GÓI SẴN (PRESET TIERS):${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.emerald}${c.bold}1. LOW (Eco / Tiết kiệm)${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}       ↳ Output: ${c.bold}2,048${c.reset} | Context: ${c.bold}16,000${c.reset} | Thinking: ${c.bold}2,048${c.reset} (effort: ${c.bold}low${c.reset})`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.geminiAmber}${c.bold}2. MEDIUM (Balanced / Tiêu chuẩn)${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}       ↳ Output: ${c.bold}8,192${c.reset} | Context: ${c.bold}64,000${c.reset} | Thinking: ${c.bold}8,192${c.reset} (effort: ${c.bold}medium${c.reset})`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.brightYellow}${c.bold}3. HIGH (Deep / Chuyên sâu)${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}       ↳ Output: ${c.bold}16,384${c.reset} | Context: ${c.bold}128,000${c.reset} | Thinking: ${c.bold}24,576${c.reset} (effort: ${c.bold}high${c.reset})`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}    ${c.crimson}${c.bold}4. MAX (Unlimited / Tối đa)${c.reset}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}       ↳ Output: ${c.bold}${profile.maxSupportedOutputTokens.toLocaleString()}${c.reset} | Context: ${c.bold}${profile.maxSupportedInputTokens.toLocaleString()}${c.reset} | Thinking: ${c.bold}64,000${c.reset} (effort: ${c.bold}max${c.reset})`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }



  /**
   * Dấu nhắc lệnh người dùng (Prompt Symbol) màu xanh ngọc (Cyan) chuẩn Antigravity
   */
  static getPromptSymbol(): string {
    return `${c.geminiCyan || c.brightCyan}${c.bold}❯${c.reset} `;
  }
}

export const formatMarkdownTerminal = CLI.formatMarkdownTerminal;

