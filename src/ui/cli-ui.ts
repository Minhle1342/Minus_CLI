import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import { FileMentionEngine, AttachedItemSummary, RelatedFileInfo } from '../workspace/file-attachment.js';
import { TreeScanResult, TreeNode, getFileExtensionBadge } from '../workspace/tree-explorer.js';
import { ContextInspectionReport } from '../context/context-inspector.js';
import type { BrainstormingSessionResult } from '../agent/multi-agent-brainstorming.js';
import type { QualityGateResult } from '../agent/agent-orchestrator.js';
import { formatTuiErrorDetail } from './ink/components/StepStream.js';
import { supportsTerminalColor } from './tui-theme.js';

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
  compactSteps: true,
};

// ANSI escape codes for styling
const ansiColors = {
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
  white: '\x1b[39m',
  gray: '\x1b[90m',
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m',
  brightRed: '\x1b[91m',
  brightBlue: '\x1b[94m',

  // Minimalist Precision Accents
  emerald: '\x1b[32m',
  teal: '\x1b[36m',
  slate: '\x1b[90m',
  amber: '\x1b[33m',
  crimson: '\x1b[31m',
  purple: '\x1b[35m',
  indigo: '\x1b[36m',

  // TrueColor Accents
  geminiCyan: '\x1b[36m',
  geminiBlue: '\x1b[36m',
  geminiPurple: '\x1b[35m',
  geminiAmber: '\x1b[33m',
  geminiGreen: '\x1b[32m',
  geminiRed: '\x1b[31m',
  subtleBorder: '\x1b[90m',
  mutedText: '\x1b[37m',
  cardBg: '',

  // Backgrounds
  bgCyan: '\x1b[36m', // Legacy name; queue notices use foreground accent.
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgBlack: '\x1b[40m',
  bgDarkGray: '\x1b[100m',
  bgGreenDark: '\x1b[48;5;22m',
  bgRedDark: '\x1b[48;5;52m',
};

export const colors = Object.fromEntries(
  Object.entries(ansiColors).map(([name, code]) => [name, supportsTerminalColor() ? code : '']),
) as typeof ansiColors;

export const c = colors;

const BASE_TYPEWRITER_DELAY_MS = 8;
export const FINAL_ANSWER_CHARACTER_DELAY_MS = 4;

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
  { command: '/model', usage: '/model [id|name]', description: 'Select the LLM model', category: 'Model & Routing', aliases: ['/modal'] },
  { command: '/tokens', usage: '/tokens [low|medium|high|max|output|input|thinking|reset] [val]', description: 'Select a preset bundle (low/medium/high/max) or tune tokens', category: 'Model & Routing', aliases: ['/token', '/token-budget'] },
  { command: '/workspace', usage: '/workspace [path]', description: 'Show or switch workspace', category: 'Workspace', aliases: ['/cd'] },
  { command: '/session', description: 'Show the current session config', category: 'Session' },
  { command: '/sessions', usage: '/sessions [open|new|inspect]', description: 'Manage saved sessions', category: 'Session' },
  { command: '/new-session', description: 'Create a new conversation session', category: 'Session' },
  { command: '/fork-session', usage: '/fork-session [seq]', description: 'Fork the session at an event boundary', category: 'Session' },
  { command: '/sandbox', description: 'Show sandbox status', category: 'Execution' },
  { command: '/docker', usage: '/docker [on|off|toggle|start|status]', description: 'Enable / disable or launch Docker Desktop for dev runs', category: 'Execution', aliases: ['/docker-desktop'] },
  { command: '/tasks', description: 'Show background tasks', category: 'Execution' },
  { command: '/ocr', usage: '/ocr [status|doctor|enable|disable|review|scan|show|waive]', description: 'OpenCodeReview gate and manual review', category: 'Review' },
  { command: '/queue', usage: '/queue [list|cancel <id>|clear|add <text>]', description: 'Manage the Queued Messages inbox (Antigravity-style)', category: 'Execution', aliases: ['/q'] },
  { command: '/steer', usage: '/steer <steering request>', description: 'Queue a message to steer the Agent at the very next step', category: 'Execution' },
  { command: '/cancel', usage: '/cancel [all|goal|tasks|subagents]', description: 'Cancel the running task/goal/subagents (or press Ctrl+C / Esc mid-execution)', category: 'Execution', aliases: ['/stop', '/abort'] },
  { command: '/resume', usage: '/resume [session-id]', description: 'Pick a session, redraw the transcript on the TUI, and resume unfinished work', category: 'Execution', aliases: ['/continue'] },
  { command: '/plan', usage: '/plan [resume|<task request>]', description: 'View, create a detailed plan, or resume an interrupted plan', category: 'Planning' },
  { command: '/brainstorm', usage: '/brainstorm <design request>', description: 'Sequential multi-agent design review (Structured Peer-Review) with 5 Personas & Decision Log', category: 'Planning', aliases: ['/review-design'] },
  { command: '/memory', description: 'Show project memory', category: 'Memory' },
  { command: '/dream', usage: '/dream [run|preview|status]', description: 'Consolidate background memory with mistral/codestral-latest', category: 'Memory' },
  { command: '/tools', description: 'List registered tools', category: 'Tools' },
  { command: '/cache', description: 'Show Prompt Caching diagnostics (MINUS standard)', category: 'Telemetry', aliases: ['/prompt-cache'] },
  { command: '/status', description: 'Show session status', category: 'Telemetry' },
  { command: '/agents', usage: '/agents [resume|stop|spawn|allocate|locks|heartbeats|inspect] [args]', description: 'View or control subagents, file locks & heartbeat monitoring', category: 'Subagents', aliases: ['/subagents'] },
  { command: '/goal', usage: '/goal [on|off|status|plan|resume|pause|complete|objective]', description: 'Long-running autonomous loop (Ralph Loop) linked to the /plan task tree', category: 'Goal Mode' },
  { command: '/skills', usage: '/skills [inspect] [id]', description: 'Show Superpowers skills', category: 'Superpowers' },
  { command: '/capabilities', usage: '/capabilities [category|name|inspect]', description: 'Show capability catalog', category: 'Superpowers' },
  { command: '/approvals', usage: '/approvals [approve|reject] [id]', description: 'Handle approval requests', category: 'Security' },
  { command: '/permissions', usage: '/permissions [mode|reset]', description: 'Configure file/command approval policy (always_ask, ask_sensitive, auto_approve, read_only)', category: 'Security', aliases: ['/permission', '/perm'] },
  { command: '/undo', description: 'Undo the most recent checkpoint', category: 'Shadow Git', aliases: ['/rollback'] },
  { command: '/checkpoints', description: 'Show checkpoint history', category: 'Shadow Git' },
  { command: '/diff', description: 'Show the unified diff of the current task', category: 'Shadow Git' },
  { command: '/evidence', description: 'Show current verification evidence', category: 'Telemetry' },
  { command: '/impact', usage: '/impact [path] [symbol]', description: 'Analyze impact scope (Blast Radius)', category: 'Tools' },
  { command: '/image', usage: '/image <path> [prompt]', description: 'Load and analyze images (Vision / Multimodal)', category: 'Vision', aliases: ['/vision', '/img'] },
  { command: '/collapse', usage: '/collapse [thinking|tools|diff|on|off|status]', description: 'Collapse/expand CoT reasoning blocks and tool outputs', category: 'UI & Display', aliases: ['/fold'] },
  { command: '/explore', usage: '/explore [tree|context|reasoning|memory|tools|tasks] [args]', description: 'Deep-dive into the directory tree, agent context, or reasoning traces', category: 'Exploration', aliases: ['/inspect'] },
  { command: '/tree', usage: '/tree [path] [depth]', description: 'Show the hierarchical project directory tree with file sizes', category: 'Workspace', aliases: ['/dirtree'] },
  { command: '/context', usage: '/context [inspect|compact|guardian|snapshot|briefing|save|status]', description: 'Control the Context Window; activate Context Guardian and Context Agent', category: 'Context', aliases: ['/ctx'] },
  { command: '/snapshot', usage: '/snapshot [save|inspect]', description: 'Capture a Context Guardian Snapshot preserving architectural invariants before compaction', category: 'Context' },
  { command: '/briefing', usage: '/briefing', description: 'Load and show the Context Agent / Guardian Handoff Summary Card', category: 'Context' },
  { command: '/explain-like-socrates', usage: '/explain-like-socrates <concept or question to explain>', description: 'Explain ideas/concepts in a Socrates-style dialogue, with step-by-step reasoning and simple metaphors', category: 'Exploration', aliases: ['/socrates'] },
  { command: '/clear', description: 'Clear the terminal screen', category: 'General' },
  { command: '/help', description: 'Show help', category: 'General', aliases: ['/?'] },
  { command: '/exit', description: 'Exit the program', category: 'General', aliases: ['/quit'] },
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
              ? `${c.brightYellow}(Directory)${c.reset}`
              : item.sizeBytes ? `${c.slate}(${(item.sizeBytes / 1024).toFixed(1)} KB)${c.reset}` : '';
            const marker = index === 0 ? '›' : ' ';
            return `${c.cyan}${marker}${c.reset} ${icon} ${c.brightCyan}${c.bold}${pathLabel}${c.reset} ${sizeInfo}`;
          });

          const footer = `${c.slate}  [Tab] Complete @path • [Esc] Close${c.reset}`;
          this.renderBelowInput(
            [`${c.brightCyan}${c.bold}📎 FILE / FOLDER ATTACHMENT SUGGESTIONS (@):${c.reset}`, ...rows, footer],
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
        const footer = `${c.slate}  [Tab] Complete • [Enter] Execute • [/help] Help${c.reset}`;
        this.renderBelowInput(
          [`${c.brightCyan}${c.bold}⚡ QUICK COMMAND SUGGESTIONS (SLASH COMMANDS):${c.reset}`, ...rows, footer],
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

export const SHARED_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export async function writeTypewriterText(text: string, options: TypewriterOptions = {}): Promise<void> {
  const delayMs = Math.max(0, options.delayMs ?? FINAL_ANSWER_CHARACTER_DELAY_MS);
  const write = options.write ?? ((character: string) => process.stdout.write(character));
  if (delayMs === 0) {
    write(text);
    return;
  }
  const wait = options.wait ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const characters = Array.from(SHARED_SEGMENTER.segment(text), (entry) => entry.segment);

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

function getToolFailureDetail(result: Record<string, any>): string {
  const exitDetail = typeof result.exitCode === 'number' && result.exitCode !== 0
    ? `Process exited with code ${result.exitCode}`
    : '';
  const isGenericFailureText = (value: string) =>
    /^(?:the command completed with exit code \d+\.?|process exited with code \d+|command failed(?: with exit code \d+)?\.?|unknown error)$/i.test(value.trim());

  for (const value of [result.error, result.message, result.diagnostic]) {
    if (typeof value === 'string' && value.trim() && !isGenericFailureText(value)) return value.trim();
  }

  const outputLines = [result.stderr, result.stdout]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const diagnosticCodeLine = outputLines.find((line) => /\b(?:MSB|NETSDK|NU|CS)\d{3,}\b/i.test(line));
  if (diagnosticCodeLine) return diagnosticCodeLine;

  const causeLine = outputLines.find((line) =>
    /\b(?:error|failed|failure|exception|fatal|not found|not recognized)\b/i.test(line)
      && !/^build failed!?$/i.test(line),
  ) || outputLines.find((line) => /\b(?:error|failed|failure|exception|fatal|not found|not recognized)\b/i.test(line));
  if (causeLine) return causeLine;
  if (outputLines.length > 0) return outputLines[0];

  return exitDetail || 'Unknown error';
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
    provider: '3-Tier Smart Router (Rate-Limit Resistant)',
    desc: 'Auto-rotates: Gemini ➔ Groq ➔ Cerebras ➔ SambaNova ➔ Pollinations on 429s',
    recommended: true,
  },
  {
    id: '9r',
    name: '9router/auto',
    provider: '9Router Gateway (Local Proxy)',
    desc: 'Routes via the 9Router Proxy (localhost:20128/v1) with RTK Token Saver & 40+ providers',
  },

  // 0.2. Cheaper Inference hosted coding models (OmniRoute integration)
  {
    id: 'or',
    name: 'omniroute/deepseek-v4.1-flash',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'DeepSeek V4.1 Flash: fast coding model from the live hosted catalog',
    recommended: true,
  },
  {
    id: 'or1',
    name: 'omniroute/deepseek-v4-pro',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'DeepSeek V4 Pro: deep reasoning and coding',
    recommended: true,
  },
  {
    id: 'or2',
    name: 'omniroute/deepseek-v4-flash',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'DeepSeek V4 Flash: fast responses for everyday coding',
  },
  {
    id: 'or3',
    name: 'omniroute/qwen-3-8-max',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'Qwen 3.8 Max: coding and agentic workflows',
  },
  {
    id: 'or4',
    name: 'omniroute/qwen-3-8-27b',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'Qwen 3.8 27B: a lightweight, fast coding pick',
  },
  {
    id: 'or5',
    name: 'omniroute/kimi-k3',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'Kimi K3: coding agent with long context',
  },
  {
    id: 'or6',
    name: 'omniroute/glm-5.3',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'GLM 5.3: reasoning and coding',
  },
  {
    id: 'or7',
    name: 'omniroute/glm-5.3-flash',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'GLM 5.3 Flash: fast responses for coding tasks',
  },
  {
    id: 'or8',
    name: 'omniroute/gpt-5.4-mini',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'GPT-5.4 Mini: everyday coding with low latency',
  },
  {
    id: 'or9',
    name: 'omniroute/gpt-5.4',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'GPT-5.4: coding and complex task handling',
  },
  {
    id: 'ora',
    name: 'omniroute/claude-sonnet-4.6',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'Claude Sonnet 4.6: high-quality coding agent',
  },
  {
    id: 'orb',
    name: 'omniroute/minimax-m2.7',
    provider: 'Cheaper Inference (OmniRoute Hosted)',
    desc: 'MiniMax M2.7: hosted coding model balancing cost and capability',
  },

  // 1. Google AI Studio
  {
    id: '1',
    name: 'gemini-3.7-flash',
    provider: 'Google AI Studio',
    desc: 'Latest 2026 generation, optimized for ultra-fast Coding & Agentic workflows',
    recommended: true,
  },
  {
    id: '2',
    name: 'gemini-3.6-flash',
    provider: 'Google AI Studio',
    desc: 'Stable upgrade with fast responses and accurate tool calling',
  },
  {
    id: '3',
    name: 'gemini-3.5-flash',
    provider: 'Google AI Studio',
    desc: 'A perfect balance of speed, intelligence, and execution performance',
  },
  {
    id: '4',
    name: 'gemini-3.5-flash-lite',
    provider: 'Google AI Studio',
    desc: 'Ultra-fast gen-3.5 Lite with low latency (replaces 2.5-flash-lite)',
  },
  {
    id: '5',
    name: 'gemini-3.1-flash-lite-preview',
    provider: 'Google AI Studio',
    desc: 'Blazing-fast responses, accurate tool calls, ultra-light and efficient',
  },
  {
    id: '6',
    name: 'gemini-3.1-flash-lite',
    provider: 'Google AI Studio',
    desc: 'Official gen-3.1 Flash Lite: stable and resource-optimized',
  },
  {
    id: '7',
    name: 'gemini-flash-latest',
    provider: 'Google AI Studio',
    desc: 'Alias that always points to the latest Google Gemini Flash model',
  },

  // 2. Groq Cloud (Free Tier: Siêu tốc độ LPU >500 tokens/s)
  {
    id: '8',
    name: 'groq/llama-3.3-70b-versatile',
    provider: 'Groq Cloud (Free)',
    desc: 'Llama 3.3 70B on ultra-fast LPU chips (~300 tok/s), highly capable',
    recommended: true,
  },
  {
    id: '9',
    name: 'groq/deepseek-r1-distill-llama-70b',
    provider: 'Groq Cloud (Free)',
    desc: 'DeepSeek R1 step-by-step reasoning at ultra speed on Groq',
  },
  {
    id: '10',
    name: 'groq/llama-3.1-8b-instant',
    provider: 'Groq Cloud (Free)',
    desc: 'Llama 3.1 8B with instant responses (~600 tokens/s), extremely light',
  },
  {
    id: '11',
    name: 'groq/gemma2-9b-it',
    provider: 'Groq Cloud (Free)',
    desc: 'Google Gemma 2 9B running on Groq LPU',
  },

  // 3. Cerebras Cloud
  {
    id: '12',
    name: 'cerebras/llama-3.3-70b',
    provider: 'Cerebras Cloud (Free)',
    desc: 'Llama 3.3 70B at record speed (~1,800 tok/s), 1M tokens/day quota',
  },
  {
    id: '13',
    name: 'cerebras/llama3.1-8b',
    provider: 'Cerebras Cloud (Free)',
    desc: 'Llama 3.1 8B at ultra speed (~2,000 tok/s), 1M tokens/day',
  },

  // 4. SambaNova Cloud
  {
    id: '14',
    name: 'sambanova/Meta-Llama-3.1-405B-Instruct',
    provider: 'SambaNova Cloud (Free)',
    desc: 'Giant 405B Llama model, free for developers',
  },
  {
    id: '15',
    name: 'sambanova/Meta-Llama-3.3-70B-Instruct',
    provider: 'SambaNova Cloud (Free)',
    desc: 'Llama 3.3 70B on the powerful SN40L chip architecture',
  },
  {
    id: '16',
    name: 'sambanova/DeepSeek-R1-Distill-Llama-70B',
    provider: 'SambaNova Cloud (Free)',
    desc: 'DeepSeek R1 70B reasoning on SambaNova infrastructure',
  },

  // 5. GitHub Models
  {
    id: '17',
    name: 'github/gpt-4o',
    provider: 'GitHub Models (Free)',
    desc: 'Official GPT-4o, free via GitHub Token / Azure endpoint',
  },
  {
    id: '18',
    name: 'github/gpt-4o-mini',
    provider: 'GitHub Models (Free)',
    desc: 'High-speed GPT-4o Mini via GitHub Token',
  },
  {
    id: '19',
    name: 'github/Mistral-large-2407',
    provider: 'GitHub Models (Free)',
    desc: 'Mistral Large 128k context via GitHub Models',
  },

  // 6. SiliconFlow
  {
    id: '20',
    name: 'siliconflow/deepseek-ai/DeepSeek-V3',
    provider: 'SiliconFlow (Free)',
    desc: 'DeepSeek V3 671B via SiliconFlow infrastructure',
  },
  {
    id: '21',
    name: 'siliconflow/deepseek-ai/DeepSeek-R1',
    provider: 'SiliconFlow (Free)',
    desc: 'DeepSeek R1 in-depth reasoning',
  },
  {
    id: '22',
    name: 'siliconflow/Qwen/Qwen2.5-Coder-32B-Instruct',
    provider: 'SiliconFlow (Free)',
    desc: 'Qwen 2.5 Coder 32B, a top-tier programming expert',
  },

  // 7. Mistral AI
  {
    id: '23',
    name: 'mistral/codestral-latest',
    provider: 'Mistral AI (Free)',
    desc: 'Codestral, a Mistral programming expert (Free dev key)',
  },
  {
    id: '24',
    name: 'mistral/mistral-large-latest',
    provider: 'Mistral AI (Free)',
    desc: 'Mistral Large, the most powerful Mistral model',
  },

  // 8. OpenRouter (Free Coding Models)
  {
    id: '25',
    name: 'openrouter/poolside/laguna-s-2.1:free',
    provider: 'OpenRouter (Poolside)',
    desc: 'Laguna S 2.1 (118B MoE): top-tier dedicated Coding Agent model from Poolside AI, 256K context',
    recommended: true,
  },
  {
    id: '26',
    name: 'openrouter/poolside/laguna-xs-2.1:free',
    provider: 'OpenRouter (Poolside)',
    desc: 'Laguna XS 2.1 (33B MoE): ultra-fast Coding Agent model with low latency, 256K context',
  },
  {
    id: '27',
    name: 'openrouter/cohere/north-mini-code:free',
    provider: 'OpenRouter (Cohere)',
    desc: 'North Mini Code (30B MoE): specialized agentic coding model from Cohere, 256K context',
  },
  {
    id: '28',
    name: 'openrouter/thinkingmachines/inkling:free',
    provider: 'OpenRouter (Thinking Machines)',
    desc: 'Inkling (975B MoE): 1-million-token mega context (1M context), deep reasoning & coding',
  },
  {
    id: '29',
    name: 'openrouter/google/gemma-4-31b-it:free',
    provider: 'OpenRouter (Google DeepMind)',
    desc: 'Gemma 4 31B: Reasoning mode, accurate function calling, 256K context',
  },
  {
    id: '29f',
    name: 'openrouter/free',
    provider: 'OpenRouter (Free)',
    desc: 'Auto-routes to the best available free model on OpenRouter',
  },

  // 9. Pollinations AI
  {
    id: '30',
    name: 'pollinations/openai',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'GPT-4o-mini 100% free, no account or API key needed',
  },
  {
    id: '31',
    name: 'pollinations/mistral',
    provider: 'Pollinations.ai (Zero-Key)',
    desc: 'Mistral 100% free, no account or API key needed',
  },

  // 10. DeepSeek Direct
  {
    id: '32',
    name: 'deepseek-chat',
    provider: 'DeepSeek Direct',
    desc: 'Official DeepSeek V3 (requires a platform.deepseek.com key)',
  },
  {
    id: '33',
    name: 'deepseek-reasoner',
    provider: 'DeepSeek Direct',
    desc: 'Official DeepSeek R1 reasoning (requires a platform.deepseek.com key)',
  },

  // 11. Anthropic Claude API (active models)
  {
    id: '34',
    name: 'claude-fable-5',
    provider: 'Anthropic Claude API',
    desc: 'Claude Fable 5: the strongest Anthropic model for long-running agents and complex tasks',
    recommended: true,
  },
  {
    id: '35',
    name: 'claude-opus-5',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 5: premium reasoning and agentic coding',
  },
  {
    id: '36',
    name: 'claude-opus-4-8',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.8: agentic coding and complex enterprise work',
  },
  {
    id: '37',
    name: 'claude-opus-4-7',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.7: powerful Opus for reasoning and coding',
  },
  {
    id: '38',
    name: 'claude-opus-4-6',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.6: high capability for long, multi-step tasks',
  },
  {
    id: '39',
    name: 'claude-opus-4-5-20251101',
    provider: 'Anthropic Claude API',
    desc: 'Claude Opus 4.5: stable snapshot for coding agents',
  },
  {
    id: '40',
    name: 'claude-sonnet-5',
    provider: 'Anthropic Claude API',
    desc: 'Claude Sonnet 5: balancing speed, quality, and agentic coding',
  },
  {
    id: '41',
    name: 'claude-sonnet-4-6',
    provider: 'Anthropic Claude API',
    desc: 'Claude Sonnet 4.6: fast, strong, and great for everyday coding',
  },
  {
    id: '42',
    name: 'claude-sonnet-4-5-20250929',
    provider: 'Anthropic Claude API',
    desc: 'Claude Sonnet 4.5: stable snapshot for coding and automation',
  },
  {
    id: '43',
    name: 'claude-haiku-4-5-20251001',
    provider: 'Anthropic Claude API',
    desc: 'Claude Haiku 4.5: fast, economical responses for light tasks',
  },

  // 12. MINUS CLI Models (OpenAI / ChatGPT Plus)
  {
    id: 'cs',
    name: 'codex/gpt-5.6-sol',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: '☀️ GPT-5.6 Sol: Peak reasoning, complex logic planning & ultimate code completion',
    recommended: true,
  },
  {
    id: 'ct',
    name: 'codex/gpt-5.6-terra',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: '🌍 GPT-5.6 Terra: Flagship model balancing speed & quality for everyday coding',
  },
  {
    id: 'cl',
    name: 'codex/gpt-5.6-luna',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: '🌙 GPT-5.6 Luna: Ultra-fast and light, optimized for clear-cut and repeatable tasks',
  },
  {
    id: 'c4',
    name: 'codex/o4-mini',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: 'o4-mini: next-gen code reasoning optimized for coding agents',
  },
  {
    id: 'c3',
    name: 'codex/o3-mini',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: 'o3-mini: deep programming reasoning for tough algorithms',
  },
  {
    id: 'cg',
    name: 'codex/gpt-4o',
    provider: 'MINUS (OpenAI / ChatGPT Plus)',
    desc: 'GPT-4o: Versatile, large-context handling and stable code generation',
  },
];

export function getVisibleWidth(text: string): number {
  const clean = stripAnsiForDisplay(text);
  let width = 0;

  for (const { segment } of SHARED_SEGMENTER.segment(clean)) {
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
  const currentWidth = getVisibleWidth(text);
  if (currentWidth >= targetWidth) return text;
  return text + ' '.repeat(targetWidth - currentWidth);
}

export function getTerminalWidth(fallback = 80, min = 40, max = 140): number {
  const cols = process.stdout?.columns;
  if (Number.isFinite(cols) && cols > 0) return Math.min(max, Math.floor(cols));
  return Math.max(min, Math.min(max, fallback));
}

export function truncateToTerminalWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (getVisibleWidth(value) <= maxWidth) return value;
  const suffix = maxWidth > 1 ? '…' : '';
  let result = '';
  for (const { segment } of SHARED_SEGMENTER.segment(value)) {
    if (getVisibleWidth(result + segment + suffix) > maxWidth) break;
    result += segment;
  }
  return result + suffix;
}

function wrapTerminalLine(value: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const { segment } of SHARED_SEGMENTER.segment(value)) {
    if (current && getVisibleWidth(current + segment) > maxWidth) {
      lines.push(current);
      current = '';
    }
    current += segment;
  }
  lines.push(current);
  return lines;
}

export function wrapVisibleText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      if (getVisibleWidth(word) <= maxWidth) {
        currentLine = word;
      } else {
        // Word is longer than maxWidth, hard wrap by character/grapheme
        let chunk = '';
        for (const { segment } of SHARED_SEGMENTER.segment(word)) {
          if (getVisibleWidth(chunk + segment) > maxWidth) {
            if (chunk) lines.push(chunk);
            chunk = segment;
          } else {
            chunk += segment;
          }
        }
        currentLine = chunk;
      }
    } else {
      const candidate = currentLine + ' ' + word;
      if (getVisibleWidth(candidate) <= maxWidth) {
        currentLine = candidate;
      } else {
        lines.push(currentLine);
        if (getVisibleWidth(word) <= maxWidth) {
          currentLine = word;
        } else {
          let chunk = '';
          for (const { segment } of SHARED_SEGMENTER.segment(word)) {
            if (getVisibleWidth(chunk + segment) > maxWidth) {
              if (chunk) lines.push(chunk);
              chunk = segment;
            } else {
              chunk += segment;
            }
          }
          currentLine = chunk;
        }
      }
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

export function createBoxHeader(title: string, color = c.subtleBorder, width?: number): string {
  const targetWidth = width || getTerminalWidth();
  if (targetWidth < 8) return `${color}${'─'.repeat(targetWidth)}${c.reset}`;
  const visibleTitle = truncateToTerminalWidth(title, targetWidth - 8);
  const titleWidth = getVisibleWidth(visibleTitle);
  // '╭── ' = 4 cols, ' ' after title = 1 col, '╮' = 1 col => tổng ký tự khung biên = 6 cols
  const remaining = Math.max(2, targetWidth - 6 - titleWidth);
  return `${color}╭── ${visibleTitle} ${color}${'─'.repeat(remaining)}╮${c.reset}`;
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

export interface CompactStepOptions {
  step: number;
  maxSteps: number;
  phase?: string;
  toolName: string;
  args: Record<string, any>;
  durationMs: number;
  result: Record<string, any>;
  tokens?: number;
  cachedTokens?: number;
}

function getMarkdownFence(line: string): { marker: '`' | '~'; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  if (match[1][0] === '`' && match[2].includes('`')) return undefined;
  return { marker: match[1][0] as '`' | '~', length: match[1].length };
}

function splitMarkdownTableRow(line: string): string[] | undefined {
  const cells: string[] = [];
  let cell = '';
  let codeSpanTicks = 0;
  let sawPipe = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') {
      const next = line[i + 1];
      if (next === '|' || next === '\\') {
        cell += next;
        i++;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '`') {
      let runLength = 1;
      while (line[i + runLength] === '`') runLength++;
      if (codeSpanTicks === 0) codeSpanTicks = runLength;
      else if (codeSpanTicks === runLength) codeSpanTicks = 0;
      cell += '`'.repeat(runLength);
      i += runLength - 1;
      continue;
    }

    if (char === '|' && codeSpanTicks === 0) {
      sawPipe = true;
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }

  if (!sawPipe) return undefined;
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

function isMarkdownTableSeparator(cells: string[] | undefined): cells is string[] {
  return Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

/**
 * Lớp điều khiển hiển thị Terminal UI/UX tối giản phong cách Swiss Monospace / Industrial Minimalist.
 * Tập trung 100% vào tín hiệu người dùng cần thấy (Zero Clutter, High Signal-to-Noise).
 */
export class CLI {
  private static thinkingSpinnerTimer?: ReturnType<typeof setInterval>;
  private static thinkingSpinnerFrame = 0;
  private static thinkingSpinnerStartedAt = 0;
  private static thinkingSpinnerVisible = false;

  static startThinkingSpinner(): void {
    if (this.thinkingSpinnerTimer || this.thinkingSpinnerVisible) return;

    this.thinkingSpinnerFrame = 0;
    this.thinkingSpinnerStartedAt = Date.now();
    this.thinkingSpinnerVisible = true;

    const render = () => {
      const elapsed = ((Date.now() - this.thinkingSpinnerStartedAt) / 1000).toFixed(1);
      const frame = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][this.thinkingSpinnerFrame];
      const line = `  ${c.purple}${frame}${c.reset} ${c.yellow}Thinking${c.reset} ${c.mutedText}(${elapsed}s)${c.reset}`;

      if (process.stdout.isTTY) {
        process.stdout.write(`\r\x1b[2K${line}`);
      } else if (this.thinkingSpinnerFrame === 0) {
        console.log(line);
      }
      this.thinkingSpinnerFrame = (this.thinkingSpinnerFrame + 1) % 10;
    };

    render();
    if (process.stdout.isTTY) {
      this.thinkingSpinnerTimer = setInterval(render, 80);
    }
  }

  static stopThinkingSpinner(): void {
    if (!this.thinkingSpinnerVisible) return;

    if (this.thinkingSpinnerTimer) {
      clearInterval(this.thinkingSpinnerTimer);
      this.thinkingSpinnerTimer = undefined;
    }
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[2K');
    }
    this.thinkingSpinnerVisible = false;
  }

  private static toolDotTimer?: ReturnType<typeof setInterval>;
  private static toolDotDelay?: ReturnType<typeof setTimeout>;
  private static toolDotVisible = false;
  private static toolDotOn = true;
  private static toolDotStartedAt = 0;
  private static toolDotLabel = '';

  /**
   * Dot nhấp nháy trên dòng CLI trong lúc chờ tool result (compact mode).
   * Ghi đè cùng 1 dòng bằng \r (như thinking spinner). Hiện trễ 300ms để tool
   * nhanh không bị chớp giật; TTY-guard nên log pipe/file không đổi.
   */
  static startToolDotSpinner(toolName: string, args: Record<string, any>): void {
    this.stopToolDotSpinner();
    if (!process.stdout.isTTY) return;

    this.stopThinkingSpinner();
    const rawTarget = (args && typeof args === 'object')
      ? (args.path || args.filePath || args.targetFile
        || args.command || args.query || args.statement || args.summary || '')
      : '';
    const targetStr = rawTarget ? ` "${truncateDisplayText(String(rawTarget), 40)}"` : '';
    this.toolDotLabel = ` ${c.bold}${toolName}${c.reset}${c.white}${targetStr}${c.reset}`;

    this.toolDotDelay = setTimeout(() => {
      this.toolDotDelay = undefined;
      this.toolDotVisible = true;
      this.toolDotOn = true;
      this.toolDotStartedAt = Date.now();
      const render = () => {
        const elapsed = ((Date.now() - this.toolDotStartedAt) / 1000).toFixed(1);
        const dot = this.toolDotOn ? `${c.emerald}●${c.reset}` : ' ';
        process.stdout.write(`\r\x1b[2K ${dot}${this.toolDotLabel} ${c.slate}(${elapsed}s)${c.reset}`);
        this.toolDotOn = !this.toolDotOn;
      };
      render();
      this.toolDotTimer = setInterval(render, 400);
      this.toolDotTimer.unref?.();
    }, 300);
    this.toolDotDelay.unref?.();
  }

  static stopToolDotSpinner(): void {
    if (this.toolDotDelay) {
      clearTimeout(this.toolDotDelay);
      this.toolDotDelay = undefined;
    }
    if (this.toolDotTimer) {
      clearInterval(this.toolDotTimer);
      this.toolDotTimer = undefined;
    }
    if (this.toolDotVisible) {
      if (process.stdout.isTTY) {
        process.stdout.write('\r\x1b[2K');
      }
      this.toolDotVisible = false;
    }
    this.toolDotLabel = '';
  }

  /** Dot có đang chờ hiện/đang blink không (để prompt khác nhường dòng rồi resume). */
  static isToolDotActive(): boolean {
    return this.toolDotDelay !== undefined || this.toolDotTimer !== undefined || this.toolDotVisible;
  }

  /**
   * Header mở đầu tối giản, hiện đại (3 dòng, không chiếm diện tích terminal)
   */
  static renderBanner(opts: BannerOptions): void {
    const wsName = path.basename(opts.workspaceRoot) || opts.workspaceRoot;
    const width = Math.max(1, getTerminalWidth() - 2);
    const branch = opts.activeBranch ? ` · git:${opts.activeBranch}` : '';
    const steps = isFinite(opts.maxSteps) ? `${opts.maxSteps} steps` : 'dynamic ∞';

    console.log(`\n  ${c.cyan}${c.bold}MINUS CLI${c.reset} ${c.slate}${truncateToTerminalWidth(`v2.5 · ${opts.modelName}${branch} · ${wsName}`, width - 10)}${c.reset}`);
    console.log(`  ${c.slate}Workspace:${c.reset} ${truncateToTerminalWidth(opts.workspaceRoot, width - 11)}`);
    console.log(`  ${c.slate}${truncateToTerminalWidth(`${steps} · ${opts.tools.length} tools · /help · Ctrl+C hủy`, width)}${c.reset}\n`);
  }

  /**
   * Hiển thị bảng lệnh gợi ý nhanh gọn
   */
  static renderQuickCommands(): void {
    const width = Math.max(1, getTerminalWidth() - 2);
    console.log(`\n  ${c.cyan}${c.bold}Lệnh${c.reset}`);
    for (const cmd of SLASH_COMMANDS) {
      const name = truncateToTerminalWidth(cmd.command, width);
      const descriptionText = `${cmd.description}${cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : ''}`;
      const description = truncateToTerminalWidth(descriptionText, width - getVisibleWidth(name) - 1);
      console.log(`  ${c.cyan}${name}${c.reset}${description ? ` ${c.mutedText}${description}${c.reset}` : ''}`);
    }
    console.log('');
  }

  /**
   * Hiển thị danh sách các model có sẵn để người dùng chọn
   */
  static renderModelSelector(currentModel: string): void {
    const width = getTerminalWidth();
    console.log(`\n${createBoxHeader('🤖 AVAILABLE MODELS (SELECT MODEL)', c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}`);
    
    let lastProvider = '';
    for (const m of AVAILABLE_MODELS) {
      if (m.provider !== lastProvider) {
        lastProvider = m.provider;
        console.log(`\n  ${c.slate}${truncateToTerminalWidth(m.provider.toUpperCase(), width)}${c.reset}`);
      }

      const isCurrent = m.name === currentModel;
      const prefix = `${isCurrent ? '●' : m.recommended ? '★' : ' '} [${m.id}] `;
      const label = truncateToTerminalWidth(m.name, width - getVisibleWidth(prefix));
      console.log(`  ${isCurrent ? c.emerald : m.recommended ? c.amber : c.cyan}${prefix}${c.reset}${c.bold}${label}${c.reset}`);
      if (m.desc) console.log(`    ${c.mutedText}${truncateToTerminalWidth(m.desc, width - 2)}${c.reset}`);
    }

    console.log(`${createBoxDivider(c.geminiPurple, width)}`);
    console.log(`${c.geminiPurple}${c.bold}│${c.reset}  ${c.slate}👉 Enter a model ID (e.g. ${c.brightCyan}0${c.slate}, ${c.brightCyan}1${c.slate}, ${c.brightCyan}9r${c.slate}, ${c.brightCyan}26${c.slate}, ${c.brightCyan}cs${c.slate}...) or ${c.brightCyan}any model name${c.slate} to switch models:${c.reset}`);
    console.log(`${createBoxFooter(c.geminiPurple, width)}\n`);
  }

  /**
   * Bảng hướng dẫn sử dụng tối giản
   */
  static renderHelp(): void {
    const width = Math.max(1, getTerminalWidth() - 4);
    console.log(`\n  ${c.cyan}${c.bold}Hướng dẫn${c.reset}`);
    const byCategory = new Map<string, SlashCommandDefinition[]>();
    for (const cmd of SLASH_COMMANDS) {
      const cat = cmd.category || 'General';
      const list = byCategory.get(cat) || [];
      list.push(cmd);
      byCategory.set(cat, list);
    }
    for (const [cat, cmds] of byCategory.entries()) {
      console.log(`\n  ${c.amber}${c.bold}${truncateToTerminalWidth(cat, width)}${c.reset}`);
      for (const item of cmds) {
        const usage = truncateToTerminalWidth(item.usage || item.command, width - 2);
        const description = truncateToTerminalWidth(item.description, width - getVisibleWidth(usage) - 3);
        console.log(`    ${c.cyan}${usage}${c.reset}${description ? ` ${c.mutedText}${description}${c.reset}` : ''}`);
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

  static renderContextBudgetExceededNotice(info: {
    currentTokens: number;
    configuredBudget: number;
    hardwareLimit: number;
    tier?: string;
  }): void {
    console.log(`  ${c.brightYellow}⚠️ [Context Budget Notice]${c.reset} ${c.slate}Context (~${info.currentTokens.toLocaleString()} tk) exceeds the configured budget (${info.configuredBudget.toLocaleString()} tk). Automatically staying within the model limit (${Math.round(info.hardwareLimit / 1000)}k tk).${c.reset}`);
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

  /**
   * Biểu diễn tiến trình thực thi của Cơ chế Epistemic Dual Investigation & Monte Carlo Rollout.
   * (Chỉ biểu diễn các pha tiến trình sự kiện đang diễn ra, tuyệt đối không bao gồm cảnh báo)
   */
  static renderEpistemicProgress(event: {
    hypothesisId?: string;
    targetFiles?: string[];
    dialecticalVerdict?: {
      outcome: string;
      confidence: number;
      thesisClaim: string;
      antithesisRebuttal: string;
      epistemicArbiterReasoning?: string;
      recommendedAction: string;
      distilledTokens?: number;
    };
    speculativeRollout?: {
      steps: Array<{
        stepIndex: number;
        action: string;
        predictedOutcome: string;
        syntaxValid: boolean;
        regressionRisk: string;
        score: number;
      }>;
      meanScore: number;
      passedSyntaxCheck: boolean;
      recommendation: string;
    };
    distilledTokens?: number;
  }): void {
    // Tắt hiển thị trên TUI theo mặc định (Cách 3). Chỉ bật khi có biến môi trường MINUS_SHOW_EPISTEMIC=true/1.
    if (process.env.MINUS_SHOW_EPISTEMIC !== 'true' && process.env.MINUS_SHOW_EPISTEMIC !== '1') {
      return;
    }

    if (!event.dialecticalVerdict && !event.speculativeRollout) return;

    const hypLabel = event.hypothesisId ? ` [${event.hypothesisId}]` : '';
    const filesLabel = event.targetFiles && event.targetFiles.length > 0
      ? ` ── ${event.targetFiles.map(f => path.basename(f)).join(', ')}`
      : '';

    console.log(`\n  ${c.brightCyan}${c.bold}⚖️ [EPISTEMIC DUAL INVESTIGATION]${c.reset}${c.brightYellow}${hypLabel}${c.reset}${c.slate}${filesLabel}${c.reset}`);

    if (event.dialecticalVerdict) {
      const v = event.dialecticalVerdict;
      const confPct = Math.round(v.confidence * 100);
      const outcomeColor = v.outcome === 'CONFIRMED_THESIS'
        ? c.emerald
        : v.outcome === 'REFINED_HYPOTHESIS'
        ? c.brightYellow
        : c.brightCyan;

      console.log(`     ${c.slate}├─ ${c.brightYellow}Thesis:${c.reset}     ${v.thesisClaim}`);
      console.log(`     ${c.slate}├─ ${c.brightCyan}Antithesis:${c.reset} ${v.antithesisRebuttal}`);
      console.log(`     ${c.slate}├─ ${c.purple}Arbiter:${c.reset}    ${outcomeColor}${c.bold}${v.outcome}${c.reset} ${c.slate}(Confidence: ${confPct}%) · Action: ${c.white}${v.recommendedAction}${c.reset}`);
    }

    if (event.speculativeRollout) {
      const r = event.speculativeRollout;
      const scorePct = Math.round(r.meanScore * 100);
      const recColor = r.recommendation === 'PROCEED'
        ? c.emerald
        : r.recommendation === 'TRY_ALTERNATIVE'
        ? c.brightYellow
        : c.crimson;

      console.log(`     ${c.slate}├─ ${c.brightBlue}MCTS Rollout:${c.reset} ${r.steps.length} lookahead rollout steps · Feasibility: ${c.bold}${scorePct}%${c.reset} ➔ ${recColor}${c.bold}${r.recommendation}${c.reset}`);
      for (const s of r.steps) {
        const syntaxBadge = s.syntaxValid ? `${c.emerald}✔ syntax${c.reset}` : `${c.crimson}✘ syntax${c.reset}`;
        console.log(`     ${c.slate}│  • Step ${s.stepIndex}:${c.reset} ${s.action} ${c.slate}(${syntaxBadge}, risk: ${s.regressionRisk}, score: ${s.score.toFixed(2)})${c.reset}`);
      }
    }

    const tokens = event.distilledTokens || event.dialecticalVerdict?.distilledTokens || 0;
    if (tokens > 0) {
      console.log(`     ${c.slate}╰─ ${c.emerald}Distill:${c.reset}    Distilled ${c.bold}${tokens} tokens${c.reset} ${c.slate}(threshold ≤ 180 tk) ➔ Loaded into Dynamic Context P1.44${c.reset}\n`);
    } else {
      console.log(`     ${c.slate}╰─ ${c.emerald}Distill:${c.reset}    ${c.slate}Context distilled ➔ Loaded into Dynamic Context P1.44${c.reset}\n`);
    }
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
  /**
   * Hiển thị bảng trạng thái & cấu hình bật / tắt Docker Desktop
   */
  static renderDockerStatus(options: {
    isAvailable: boolean;
    autoStartEnabled?: boolean;
    mode?: string;
  }): void {
    const width = getTerminalWidth(80, 50, 95);
    console.log(`\n${createBoxHeader('🐳 DOCKER DESKTOP CONFIGURATION', c.brightCyan, width)}`);

    const daemonStatus = options.isAvailable
      ? `${c.emerald}${c.bold}● RUNNING${c.reset}`
      : `${c.crimson}${c.bold}○ STOPPED${c.reset}`;

    const autoStatus = options.autoStartEnabled
      ? `${c.emerald}${c.bold}✔ ON${c.reset} ${c.slate}(Auto-opens on npm run dev)${c.reset}`
      : `${c.slate}✖ OFF (No auto-open, saves RAM)${c.reset}`;

    const modeStr = `${c.brightCyan}${options.mode || 'auto'}${c.reset}`;

    console.log(`${c.brightCyan}│${c.reset}  ${c.bold}Daemon Status:${c.reset}     ${daemonStatus}`);
    console.log(`${c.brightCyan}│${c.reset}  ${c.bold}Auto-open on dev:${c.reset}    ${autoStatus}`);
    console.log(`${c.brightCyan}│${c.reset}  ${c.bold}Sandbox Mode:${c.reset}           ${modeStr}`);
    console.log(`${createBoxDivider(c.brightCyan, width)}`);
    console.log(`${c.brightCyan}│${c.reset}  ${c.slate}💡 Quick commands:${c.reset}`);
    console.log(`${c.brightCyan}│${c.reset}     ${c.brightCyan}/docker on${c.reset}     ➔ Enable auto-open of Docker Desktop on dev`);
    console.log(`${c.brightCyan}│${c.reset}     ${c.brightCyan}/docker off${c.reset}    ➔ Disable auto-open (run the lightweight Local Sandbox)`);
    console.log(`${c.brightCyan}│${c.reset}     ${c.brightCyan}/docker start${c.reset}  ➔ Start Docker Desktop immediately`);
    console.log(`${createBoxFooter(c.brightCyan, width)}\n`);
  }

  /**
   * Thông báo bật / tắt thành công tính năng tự động mở Docker Desktop
   */
  static renderDockerToggleNotice(enabled: boolean): void {
    const badge = enabled
      ? `${c.emerald}${c.bold}✔ [ENABLED]${c.reset}`
      : `${c.amber}${c.bold}✖ [DISABLED]${c.reset}`;
    const detail = enabled
      ? 'Docker Desktop will start automatically when you run npm run dev.'
      : 'Docker Desktop will not auto-open on dev. The system uses Local Sandbox to save RAM.';
    console.log(`\n  ${badge} ${c.white}${c.bold}Docker Desktop auto-open config:${c.reset} ${c.slate}${detail}${c.reset}`);
    console.log(`  ${c.slate}💡 You can change this anytime with ${c.brightCyan}/docker on${c.slate} or ${c.brightCyan}/docker off${c.reset}\n`);
  }

  /**
   * Hộp thoại hiển thị lựa chọn mở Docker Desktop khi khởi động sau npm run dev
   */
  static renderDockerStartupPrompt(options: { isAvailable?: boolean; autoStartEnabled?: boolean } = {}): void {
    const width = getTerminalWidth(80, 50, 95);
    console.log(`\n${createBoxHeader('🐳 DOCKER DESKTOP STARTUP OPTIONS', c.geminiBlue, width)}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.amber}Docker Desktop is not running on your machine.${c.reset}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.mutedText}You can open Docker Desktop to use Docker Sandbox & SearXNG,${c.reset}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.mutedText}or skip it to save ~1.5GB RAM (using the safe Local Sandbox).${c.reset}`);
    console.log(`${createBoxDivider(c.geminiBlue, width)}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.brightCyan}${c.bold}[y]${c.reset} ${c.white}Open Docker Desktop now${c.reset}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.brightCyan}${c.bold}[n]${c.reset} ${c.slate}Skip (use Local Sandbox)${c.reset}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.brightCyan}${c.bold}[a]${c.reset} ${c.emerald}Always auto-open after npm run dev${c.reset}`);
    console.log(`${c.geminiBlue}│${c.reset}  ${c.brightCyan}${c.bold}[d]${c.reset} ${c.amber}Always skip on npm run dev (do not ask again)${c.reset}`);
    console.log(`${createBoxFooter(c.geminiBlue, width)}`);
  }

  /**
   * Hàm hỏi người dùng tương tác lựa chọn bật / tắt mở Docker Desktop
   */
  static async promptDockerStartupChoice(
    readlineInterface: { question(prompt: string): Promise<string> },
  ): Promise<'on' | 'off' | 'always' | 'never' | 'skip'> {
    CLI.renderDockerStartupPrompt();
    try {
      const answer = (
        await readlineInterface.question(`  ${c.brightCyan}${c.bold}👉 Your choice [y/n/a/d] (default n):${c.reset} `)
      ).trim().toLowerCase();

      if (answer === 'a' || answer === 'always') return 'always';
      if (answer === 'd' || answer === 'never' || answer === 'disable') return 'never';
      if (answer === 'y' || answer === 'yes' || answer === '1') return 'on';
      return 'off';
    } catch {
      return 'skip';
    }
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

  static renderAgents(agents: Array<{
    id: string;
    label?: string;
    status: string;
    capabilities?: string[];
    metadata?: Record<string, any>;
    activeTasksCount?: number;
    totalTasksCompleted?: number;
  }>): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ REGISTERED SUBAGENTS & BENCHMARK SPECIALISTS (${agents.length})${c.reset}`);
    if (agents.length === 0) {
      console.log(`  ${c.mutedText}No subagents registered.${c.reset}\n`);
    } else {
      for (const a of agents) {
        const statusColor = a.status === 'running' ? c.brightGreen : a.status === 'error' ? c.red : c.slate;
        const statusBadge = `${statusColor}[${a.status.toUpperCase()}]${c.reset}`;
        const loadInfo = (typeof a.activeTasksCount === 'number' && a.activeTasksCount > 0)
          ? ` ${c.yellow}(⚡ Active: ${a.activeTasksCount})${c.reset}`
          : '';
        const completedInfo = (typeof a.totalTasksCompleted === 'number' && a.totalTasksCompleted > 0)
          ? ` ${c.dim}(Done: ${a.totalTasksCompleted})${c.reset}`
          : '';
        console.log(`  ${c.bold}${c.brightCyan}${a.id}${c.reset} ── ${statusBadge} ${c.white}${a.label || a.id}${c.reset}${loadInfo}${completedInfo}`);
        if (a.metadata?.topBenchmark) {
          console.log(`    ${c.amber}🏆 Top Benchmark:${c.reset} ${c.bold}${a.metadata.topBenchmark}${c.reset}`);
        }
        if (a.metadata?.model) {
          console.log(`    ${c.slate}Model:${c.reset} ${a.metadata.model} ${a.metadata.provider ? `(${a.metadata.provider})` : ''}`);
        }
        if (a.metadata?.domain) {
          console.log(`    ${c.slate}Domain:${c.reset} ${c.dim}${a.metadata.domain}${c.reset}`);
        }
        if (a.capabilities && a.capabilities.length > 0) {
          console.log(`    ${c.slate}Capabilities:${c.reset} ${c.gray}${a.capabilities.join(', ')}${c.reset}`);
        }
        console.log('');
      }
    }
  }

  static renderBrainstormResult(result: BrainstormingSessionResult): void {
    const dispColor = result.finalDisposition === 'APPROVED' ? c.emerald : result.finalDisposition === 'REVISE' ? c.amber : c.crimson;
    console.log(`\n${c.brightCyan}${c.bold}┌── 🧠 MULTI-AGENT STRUCTURED PEER-REVIEW: ${result.goal.slice(0, 60)} ──┐${c.reset}`);
    console.log(`│ ${c.slate}Session ID:${c.reset} ${c.white}${result.id}${c.reset} │ ${c.slate}Disposition:${c.reset} ${dispColor}${c.bold}[${result.finalDisposition}]${c.reset} │ ${c.slate}Exit Criteria:${c.reset} ${result.exitCriteriaMet ? `${c.emerald}PASS✔${c.reset}` : `${c.crimson}FAIL✖${c.reset}`}`);
    console.log(`├─────────────────────────────────────────────────────────────────────────┤`);
    console.log(`│ ${c.geminiAmber}${c.bold}1. UNDERSTANDING LOCK${c.reset}`);
    console.log(`│   ${c.slate}Core Problem:${c.reset} ${result.understandingLock.coreProblem}`);
    console.log(`│   ${c.slate}In Scope:${c.reset} ${result.understandingLock.inScope.join(', ')}`);
    console.log(`├─────────────────────────────────────────────────────────────────────────┤`);
    console.log(`│ ${c.geminiAmber}${c.bold}2. PEER-REVIEW FEEDBACKS (5 PERSONAS)${c.reset}`);
    for (const [role, fb] of Object.entries(result.reviewerFeedbacks)) {
      const vColor = fb.verdict === 'pass' ? c.emerald : fb.verdict === 'needs_revision' ? c.amber : c.crimson;
      console.log(`│   ${c.bold}${c.brightCyan}▸ ${fb.roleName}${c.reset} ── ${vColor}[${fb.verdict.toUpperCase()}]${c.reset}`);
      console.log(`│     ${c.slate}${fb.summary}${c.reset}`);
      for (const obj of fb.objections) {
        console.log(`│     ${c.crimson}✖ [${obj.severity.toUpperCase()}]${c.reset} ${obj.description}`);
      }
    }
    console.log(`├─────────────────────────────────────────────────────────────────────────┤`);
    console.log(`│ ${c.geminiAmber}${c.bold}3. DECISION LOG & ARBITER RATIONALE${c.reset}`);
    console.log(`│   ${c.white}${result.arbiterRationale}${c.reset}`);
    if (result.actionRequired && result.actionRequired.length > 0) {
      console.log(`│   ${c.brightYellow}Required Actions:${c.reset}`);
      for (const act of result.actionRequired) {
        console.log(`│     • ${c.slate}${act}${c.reset}`);
      }
    }
    console.log(`${c.brightCyan}${c.bold}└── 🏁 [EXIT CRITERIA: ${result.exitCriteriaMet ? 'PASSED - PROCEED TO IMPLEMENTATION' : 'BLOCKED - REVISE REQUIRED'}] ──┘${c.reset}\n`);
  }

  static renderFileLocks(locks: Record<string, string>): void {
    const entries = Object.entries(locks);
    console.log(`\n${c.brightCyan}${c.bold}❯ ACTIVE SUBAGENT FILE LOCKS (${entries.length})${c.reset}`);
    if (entries.length === 0) {
      console.log(`  ${c.mutedText}No files currently locked.${c.reset}\n`);
    } else {
      for (const [file, agentId] of entries) {
        console.log(`  🔒 ${c.brightCyan}${file}${c.reset} ── ${c.yellow}[Locked by: ${agentId}]${c.reset}`);
      }
      console.log('');
    }
  }

  static renderHeartbeats(heartbeats: Array<{ agentId: string; taskId?: string; idleDurationMs: number; isStale: boolean; lastActiveAt?: string }>): void {
    console.log(`\n${c.brightCyan}${c.bold}❯ SUBAGENT HEARTBEATS & LIVENESS MONITOR (${heartbeats.length})${c.reset}`);
    if (heartbeats.length === 0) {
      console.log(`  ${c.mutedText}No active tasks currently monitored.${c.reset}\n`);
    } else {
      for (const hb of heartbeats) {
        const sec = Math.round(hb.idleDurationMs / 1000);
        const statusBadge = hb.isStale
          ? `${c.crimson}${c.bold}[STALE / INACTIVE > 30M]${c.reset}`
          : `${c.emerald}[HEALTHY]${c.reset}`;
        console.log(`  💓 ${c.bold}${hb.agentId}${c.reset} (${hb.taskId || 'general'}) ── ${statusBadge} ${c.slate}Idle: ${sec}s · Last: ${hb.lastActiveAt || 'unknown'}${c.reset}`);
      }
      console.log('');
    }
  }

  static renderQualityGateResult(res: QualityGateResult): void {
    const status = res.passed ? `${c.emerald}${c.bold}✔ QUALITY GATE PASSED${c.reset}` : `${c.crimson}${c.bold}✖ QUALITY GATE REJECTED${c.reset}`;
    console.log(`\n  ${status}`);
    console.log(`    • Files modified: ${res.checks.filesModified.pass ? c.emerald + 'PASS' : c.crimson + 'FAIL'} ${c.slate}(${res.checks.filesModified.details})${c.reset}`);
    console.log(`    • Scope check: ${res.checks.scopeCompliance.pass ? c.emerald + 'PASS' : c.crimson + 'FAIL'} ${c.slate}(${res.checks.scopeCompliance.details})${c.reset}`);
    console.log(`    • Secret scan: ${res.checks.secretScan.pass ? c.emerald + 'PASS' : c.crimson + 'FAIL'} ${c.slate}(${res.checks.secretScan.details})${c.reset}`);
    console.log(`    • Verification command: ${res.checks.verificationCommand.pass ? c.emerald + 'PASS' : c.crimson + 'FAIL'} ${c.slate}(${res.checks.verificationCommand.details})${c.reset}\n`);
  }

  static renderStatus(opts: StatusOptions): void {
    const goal = opts.isGoalMode ? 'Goal Mode: ON (∞)' : `Step Budget: ${opts.maxSteps}`;
    console.log(`\n  ${c.brightCyan}${c.bold}❯ STATUS${c.reset} · ${opts.modelName} · ${goal} · Turns: ${opts.sessionTurns}`);
    if (opts.workspaceRoot) {
      console.log(`  ${c.slate}Workspace:${c.reset} ${c.brightCyan}${opts.workspaceRoot}${c.reset}`);
    }
    if (opts.sandboxStatus) {
      console.log(`  ${c.slate}Sandbox:${c.reset} ${opts.sandboxStatus}`);
    }
    console.log('');
  }

  static renderSessionInfo(data: { modelName?: string; workspacePath?: string; activeSessionId?: string; lastUpdated?: string }, sessionFile: string): void {
    const ws = data.workspacePath ? ` · Workspace: ${data.workspacePath}` : '';
    console.log(`\n  ${c.slate}Session:${c.reset} ${data.activeSessionId || 'none'} · Model: ${data.modelName || 'default'}${ws} · File: ${sessionFile}\n`);
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
    _step: number,
    _maxSteps: number,
    context?: {
      phase?: string;
      activeTask?: string;
      playbook?: string;
      risk?: string;
      isGoal?: boolean;
    },
  ): void {
    const width = getTerminalWidth();
    const label = `─── STEP ${_step}/${_maxSteps}${context?.activeTask ? ` · ${context.activeTask}` : ''} `;
    const visibleLabel = truncateToTerminalWidth(label, width);
    console.log(`\n${c.slate}${visibleLabel}${'─'.repeat(Math.max(0, width - getVisibleWidth(visibleLabel)))}${c.reset}`);
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

  static renderRequestAnalysis(analysisText: string, maxLines = 30): void {
    if (!analysisText || !analysisText.trim()) return;
    const lines = analysisText.trim().split('\n').slice(0, maxLines);
    console.log(`  ${c.cyan}🔍 Request Analysis:${c.reset}`);
    for (const line of lines) {
      console.log(`    ${c.white}${line}${c.reset}`);
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

  static renderReasoningInspection(data: { thought: string; timestamp?: string; step?: number; turn?: number }): void {    console.log(`\n${c.brightCyan}${c.bold}❯ REASONING TRACE${c.reset}`);
    console.log(data.thought || 'No trace recorded.');
    console.log('');
  }

  static renderModelAction(action: 'tool_call' | 'final_answer' | 'max_steps', detail?: string): void {
    if (action === 'final_answer') {
      console.log(`  ${c.emerald}✨ [COMPLETED]${c.reset} Ready to provide final response.`);
    } else if (action === 'tool_call') {
      console.log(`  ${c.geminiCyan}⚙️ [ACTION]${c.reset} ${detail || 'Requesting tool execution...'}`);
    } else {
      console.log(`  ${c.yellow}⏱️ [STEP BUDGET REACHED]${c.reset} ${detail || 'Max steps reached for current turn.'}`);
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
      const cleanErr = formatTuiErrorDetail(getToolFailureDetail(result), 120);
      console.log(`  ${c.crimson}✖ ${name} failed${duration}:${c.reset} ${cleanErr}`);
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

  /**
   * Antigravity CLI Standard: Compact One-Liner Step Log
   * Gộp Tool + Target + Status + Duration + Telemetry thành 1 dòng duy nhất (giảm 75% I/O)
   */
  static renderCompactOneLiner(opts: CompactStepOptions): void {
    const isError = isToolResultFailure(opts.result);
    const width = getTerminalWidth();
    const dot = `${isError ? c.crimson : c.emerald}●${c.reset}`;
    const rawTarget = opts.args.path || opts.args.filePath || opts.args.targetFile
      || opts.args.command || opts.args.query || opts.args.statement || opts.args.summary || '';
    const duration = opts.durationMs > 0 ? ` ${c.slate}(${opts.durationMs}ms)${c.reset}` : '';

    let statusBadge = '';
    if (isError) {
      statusBadge = ` ${c.crimson}✖ failed${c.reset}`;
    } else if (opts.result.stdout !== undefined) {
      statusBadge = ` ${c.emerald}✔ ${opts.result.exitCode === 0 ? 'exit 0' : `exit ${opts.result.exitCode}`}${c.reset}`;
    } else if (opts.result.replacements !== undefined) {
      statusBadge = ` ${c.emerald}✔ ${opts.result.replacements} replaced${c.reset}`;
    } else if (opts.result.created) {
      statusBadge = ` ${c.emerald}✔ created${c.reset}`;
    } else if (opts.result.hunksApplied !== undefined) {
      statusBadge = ` ${c.emerald}✔ ${opts.result.hunksApplied} hunks${c.reset}`;
    } else if (opts.result.matches !== undefined) {
      statusBadge = ` ${c.emerald}✔ ${opts.result.totalMatches || opts.result.matches.length} matches${c.reset}`;
    } else {
      statusBadge = ` ${c.emerald}✔ OK${c.reset}`;
    }

    let telemetryStr = '';
    if (typeof opts.tokens === 'number' && opts.tokens > 0) {
      const tokStr = opts.tokens >= 1000 ? `${(opts.tokens / 1000).toFixed(1)}k tok` : `${opts.tokens} tok`;
      telemetryStr = ` ${c.dim}· ${tokStr}${c.reset}`;
    }

    const toolName = truncateToTerminalWidth(opts.toolName, Math.max(3, Math.floor(width / 3)));
    const toolPrefix = `${dot} ${c.bold}${toolName}${c.reset}`;
    const baseWidth = getVisibleWidth(`  ${toolPrefix}${statusBadge}`);
    const targetReserve = rawTarget ? 8 : 0;
    const visibleDuration = baseWidth + getVisibleWidth(duration) + targetReserve <= width ? duration : '';
    const visibleTelemetry = baseWidth + getVisibleWidth(visibleDuration + telemetryStr) + targetReserve <= width ? telemetryStr : '';
    const targetWidth = width - getVisibleWidth(`  ${toolPrefix}${statusBadge}${visibleDuration}${visibleTelemetry}`) - 3;
    const targetStr = rawTarget && targetWidth > 1
      ? ` "${c.white}${truncateToTerminalWidth(String(rawTarget), targetWidth)}${c.reset}"`
      : '';

    process.stdout.write(`  ${toolPrefix}${targetStr}${statusBadge}${visibleDuration}${visibleTelemetry}\n`);

    if (isError) {
      const cleanErr = formatTuiErrorDetail(getToolFailureDetail(opts.result), 120);
      process.stdout.write(`    ${c.crimson}└─ ${truncateToTerminalWidth(cleanErr, Math.max(1, width - 7))}${c.reset}\n`);
    }
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
    workspaceRoot?: string;
  }): void {
    const cached = info.cachedTokens ?? 0;
    const total = info.totalTokens ?? 0;
    const rate = info.cacheHitRate ?? (total > 0 ? Number(((cached / total) * 100).toFixed(1)) : 0);
    const modeBadge = info.preservePrefixCache
      ? `${c.emerald}ENABLED (Prefix Preserved)${c.reset}`
      : `${c.amber}DISABLED${c.reset}`;
    console.log(`\n  ${c.geminiCyan}${c.bold}❯ PROMPT CACHE TELEMETRY${c.reset} [${modeBadge}]`);
    console.log(`    Model: ${c.brightCyan}${info.modelName}${c.reset} │ Session: ${c.slate}${info.sessionId || 'active'}${c.reset} (${info.sessionAgeSec ?? 0}s)`);
    if (info.workspaceRoot) {
      console.log(`    Workspace: ${c.brightCyan}${info.workspaceRoot}${c.reset}`);
    }
    console.log(`    Tokens: ${cached.toLocaleString()} cached / ${total.toLocaleString()} total (${c.yellow}${rate}%${c.reset} hit rate) │ Checkpoints: ${info.cachedCheckpoints ?? 0}`);
  }

  static renderAttachmentSummary(attachments: AttachedItemSummary[], related?: RelatedFileInfo[]): void {
    if (!attachments || attachments.length === 0) return;
    console.log(`\n  ${c.geminiCyan}${c.bold}📎 ATTACHED TO CONTEXT (${attachments.length} items):${c.reset}`);
    for (const a of attachments) {
      console.log(`    • ${path.basename(a.path)} (${(a.sizeBytes / 1024).toFixed(1)} KB)`);
    }
    if (related && related.length > 0) {
      const hop1 = related.filter((r) => r.hop === 1).length;
      const hop2 = related.filter((r) => r.hop === 2).length;
      console.log(`    ${c.cyan}🔗 Extended 2-hop investigation scope: ${related.length} related files (hop-1: ${hop1}, hop-2: ${hop2})${c.reset}`);
      for (const r of related.slice(0, 8)) {
        console.log(`      • ${r.path} (hop-${r.hop} • ${r.reason}${r.via ? ` via ${r.via}` : ''})`);
      }
      if (related.length > 8) {
        console.log(`      • ... (+${related.length - 8} other files)`);
      }
    }
    console.log('');
  }

  static renderStepFooter(): void {
    // Giảm thiểu khoảng trắng thừa giữa các step
  }

  static formatMarkdownTables(text: string, options: { width?: number; layout?: 'grid' | 'stacked' } = {}): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const openingFence = getMarkdownFence(line);
      if (openingFence) {
        result.push(line);
        i++;
        while (i < lines.length) {
          const codeLine = lines[i++];
          result.push(codeLine);
          const closingFence = getMarkdownFence(codeLine);
          if (closingFence?.marker === openingFence.marker && closingFence.length >= openingFence.length && !codeLine.trim().slice(closingFence.length).trim()) {
            break;
          }
        }
        continue;
      }

      const rawHeader = splitMarkdownTableRow(line);
      const separator = i + 1 < lines.length ? splitMarkdownTableRow(lines[i + 1]) : undefined;
      if (!rawHeader || !isMarkdownTableSeparator(separator) || rawHeader.length !== separator.length) {
        result.push(line);
        i++;
        continue;
      }

      const header = rawHeader.map((cell) => CLI.formatLatexArrows(cell));
      const colCount = header.length;
      const dataRows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = splitMarkdownTableRow(lines[i]);
        if (!row) break;
        dataRows.push(Array.from({ length: colCount }, (_, column) => CLI.formatLatexArrows(row[column] || '')));
        i++;
      }
      const normalizedHeader = Array.from({ length: colCount }, (_, column) => header[column] || '');
      const allRows = [normalizedHeader, ...dataRows];
      const naturalWidths = normalizedHeader.map((_, column) => allRows.reduce(
        (width, row) => Math.max(width, getVisibleWidth(row[column] || '')),
        1,
      ));
      const termWidth = Number.isFinite(options.width)
        ? Math.max(1, Math.floor(options.width!))
        : getTerminalWidth(95, 60, 130);
      const contentBudget = termWidth - (colCount * 3 + 1);

      // Ink can reflow text independently of our padding. In stacked mode no
      // column alignment is required, and labels stay paired with full values.
      if (options.layout === 'stacked') {
        const indent = termWidth > 4 ? '  ' : '';
        const valueWidth = Math.max(1, termWidth - indent.length);
        const stacked: string[] = [];
        const rows = dataRows.length > 0 ? dataRows : [Array<string>(colCount).fill('')];
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          if (rowIndex > 0) stacked.push('');
          stacked.push(...wrapVisibleText(`[${rowIndex + 1}]`, termWidth));
          for (let column = 0; column < colCount; column++) {
            stacked.push(...wrapVisibleText(`${normalizedHeader[column] || `Column ${column + 1}`}:`, termWidth));
            // HTML line breaks are common in generated Markdown table cells.
            const valueLines = rows[rowIndex][column].split(/<br\s*\/?\s*>/i);
            for (const valueLine of valueLines) {
              stacked.push(...wrapVisibleText(valueLine.trim(), valueWidth).map(part => `${indent}${part}`));
            }
          }
        }
        result.push(stacked.join('\n'));
        continue;
      }

      // If even one character per column cannot fit, switch to a stacked layout
      // instead of emitting a table wider than the terminal.
      if (contentBudget < colCount) {
        const rowWidth = Math.max(1, termWidth - 4);
        const stacked: string[] = [];
        for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
          if (stacked.length > 0) stacked.push('');
          stacked.push(`• ${rowIndex + 1}`);
          for (let column = 0; column < colCount; column++) {
            const label = `${normalizedHeader[column] || `Column ${column + 1}`}: `;
            const wrapped = wrapVisibleText(`${label}${dataRows[rowIndex][column]}`, rowWidth);
            stacked.push(...wrapped.map((wrappedLine, lineIndex) => lineIndex === 0 ? `  ${wrappedLine}` : `    ${wrappedLine}`));
          }
        }
        result.push(stacked.join('\n'));
        continue;
      }

      const totalNaturalWidth = naturalWidths.reduce((sum, width) => sum + width, 0);
      let colWidths = naturalWidths;
      if (totalNaturalWidth > contentBudget) {
        const demands = naturalWidths.map((width) => Math.max(0, width - 1));
        const totalDemand = demands.reduce((sum, demand) => sum + demand, 0);
        const extraBudget = contentBudget - colCount;
        const exactShares = demands.map((demand) => totalDemand > 0 ? extraBudget * demand / totalDemand : 0);
        colWidths = exactShares.map((share) => 1 + Math.floor(share));
        let remaining = contentBudget - colWidths.reduce((sum, width) => sum + width, 0);
        const remainderOrder = exactShares
          .map((share, column) => ({ column, remainder: share - Math.floor(share) }))
          .sort((a, b) => b.remainder - a.remainder);
        for (let n = 0; n < remainderOrder.length && remaining > 0; n++, remaining--) {
          colWidths[remainderOrder[n].column]++;
        }
      }

      const topBorder = '┌' + colWidths.map(width => '─'.repeat(width + 2)).join('┬') + '┐';
      const midBorder = '├' + colWidths.map(width => '─'.repeat(width + 2)).join('┼') + '┤';
      const botBorder = '└' + colWidths.map(width => '─'.repeat(width + 2)).join('┴') + '┘';
      const formattedLines: string[] = [topBorder];

      const renderRow = (row: string[]) => {
        const wrappedCells = colWidths.map((width, column) => wrapVisibleText(row[column] || '', width));
        const rowHeight = Math.max(...wrappedCells.map(cellLines => cellLines.length), 1);
        for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
          const rowCells = colWidths.map((width, column) => ` ${padRightVisible(wrappedCells[column]?.[lineIndex] || '', width)} `);
          formattedLines.push(`│${rowCells.join('│')}│`);
        }
      };

      renderRow(normalizedHeader);
      formattedLines.push(midBorder);
      for (const row of dataRows) renderRow(row);
      formattedLines.push(botBorder);
      result.push(formattedLines.join('\n'));
    }

    return result.join('\n');
  }

  static formatLatexArrows(text: string): string {
    if (!text) return text;

    const arrowMap: Record<string, string> = {
      // Right arrows
      rightarrow: '→',
      righttarrow: '→',
      to: '→',
      longrightarrow: '⟶',
      Rightarrow: '⇒',
      Longrightarrow: '⟹',

      // Left arrows
      leftarrow: '←',
      lefttarrow: '←',
      gets: '←',
      longleftarrow: '⟵',
      Leftarrow: '⇐',
      Longleftarrow: '⟸',

      // Up arrows
      uparrow: '↑',
      toptarrow: '↑',
      toparrow: '↑',
      Uparrow: '⇑',

      // Down arrows
      downarrow: '↓',
      bottomtarrow: '↓',
      bottomarrow: '↓',
      Downarrow: '⇓',

      // Bidirectional
      leftrightarrow: '↔',
      longleftrightarrow: '⟷',
      Leftrightarrow: '⇔',
      Longleftrightarrow: '⟺',
      updownarrow: '↕',
      Updownarrow: '⇕',

      // Mapping & Diagonal
      mapsto: '↦',
      longmapsto: '⟼',
      nearrow: '↗',
      nwarrow: '↖',
      searrow: '↘',
      swarrow: '↙',
    };

    // 1. Khớp các trường hợp bọc trong $...$, $$...$$, \(...\) chứa lệnh arrow
    // VD: $\rightarrow$, $$\lefttarrow$$, \( \bottomtarrow \)
    let formatted = text.replace(/(?:\$\$?|\\\()\s*\\([a-zA-Z]+)\s*(?:\$\$?|\\\))/g, (match, cmd) => {
      const symbol = arrowMap[cmd];
      return symbol !== undefined ? symbol : match;
    });

    // 2. Khớp các lệnh arrow đứng trần hoặc bên trong biểu thức phức tạp hơn
    formatted = formatted.replace(/\\([a-zA-Z]+)/g, (match, cmd) => {
      const symbol = arrowMap[cmd];
      return symbol !== undefined ? symbol : match;
    });

    // 3. Nếu còn cặp $ bao quanh một ký tự mũi tên đơn lẻ do bước 2 để lại, làm sạch dấu $
    formatted = formatted.replace(/\$(\s*[→←↑↓⇒⇐⇑⇓↔⟷⇔⟺↕⇕↦⟼↗↖↘↙⟶⟵]\s*)\$/g, '$1');

    return formatted;
  }

  static formatMarkdownTerminal(text: string): string {
    const tableProcessed = CLI.formatMarkdownTables(text);
    const renderProse = (part: string) => {
      const segments = part.split(/(`[^`\n]+`)/g);
      const processed = segments.map((seg, idx) => {
        if (idx % 2 === 1) return seg;
        return CLI.formatLatexArrows(seg);
      }).join('');

      return processed
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
    };
    const lines = tableProcessed.split('\n');
    const output: string[] = [];
    let prose: string[] = [];
    let i = 0;

    const flushProse = () => {
      if (prose.length > 0) {
        output.push(renderProse(prose.join('\n')));
        prose = [];
      }
    };

    while (i < lines.length) {
      const openingFence = getMarkdownFence(lines[i]);
      if (!openingFence) {
        prose.push(lines[i++]);
        continue;
      }

      flushProse();
      const openingLine = lines[i++];
      const openingMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(openingLine);
      const lang = openingMatch?.[2].trim() || '';
      const codeLines: string[] = [];
      while (i < lines.length) {
        const codeLine = lines[i++];
        const closingFence = getMarkdownFence(codeLine);
        if (closingFence?.marker === openingFence.marker
          && closingFence.length >= openingFence.length
          && !codeLine.trim().slice(closingFence.length).trim()) {
          break;
        }
        codeLines.push(codeLine);
      }
      const langTag = lang ? ` ${c.slate}[${lang}]${c.reset}` : '';
      output.push(`\n  ${c.slate}── Code${langTag} ──${c.reset}\n`
        + codeLines.map((codeLine) => `  ${codeLine}`).join('\n')
        + `\n  ${c.slate}──────────────${c.reset}\n`);
    }

    flushProse();
    return output.join('');
  }

  /** Redraw the visible terminal transcript from a session's read-only history projection. */
  static renderSessionTranscript(
    sessionId: string,
    messages: Array<{
      role?: string;
      parts?: Array<{ text?: string; thought?: boolean; functionCall?: unknown; functionResponse?: unknown }>;
    }>,
  ): void {
    console.clear();
    console.log(`\n${c.brightCyan}${c.bold}Session ${sessionId} · conversation history${c.reset}\n`);

    let renderedMessages = 0;
    for (const message of messages) {
      if (message.parts?.some((part) => part.functionResponse)) continue;
      const isAssistant = message.role === 'model' || message.role === 'assistant';
      if (!isAssistant && message.role !== 'user') continue;

      const text = (message.parts || [])
        .filter((part) => !part.thought && !part.functionCall && typeof part.text === 'string')
        .map((part) => part.text!.trim())
        .filter(Boolean)
        .join('\n');
      if (!text) continue;

      const label = isAssistant ? 'ASSISTANT' : 'USER';
      const labelColor = isAssistant ? c.geminiGreen : c.geminiAmber;
      console.log(`${labelColor}${c.bold}${label}${c.reset}`);
      console.log(CLI.formatMarkdownTerminal(text));
      console.log('');
      renderedMessages++;
    }

    if (renderedMessages === 0) {
      console.log(`${c.gray}(Session has no conversation content to display.)${c.reset}\n`);
    }
    console.log(`${c.gray}Transcript is only redrawn on the TUI; the saved session history/context is preserved.${c.reset}\n`);
  }

  /**
   * Hiển thị Final Answer chuẩn Codex / Antigravity CLI (in trực tiếp nội dung Markdown, không viền khung và không typewriter animation)
   */
  static async renderFinalAnswer(answer: string, options: { animate?: boolean } = {}): Promise<void> {
    const content = answer.trim();
    if (!content) return;

    const formatted = CLI.formatMarkdownTerminal(content);

    console.log('');
    console.log(formatted);
    console.log('');
  }

  static async renderExecutionStopped(message: string, reason: string = 'STOPPED'): Promise<void> {
    const content = message.trim();
    console.log(`\n  ${c.crimson}${c.bold}🛑 AGENT EXECUTION STOPPED (${reason})${c.reset}\n`);
    console.log(`  ${content}\n`);
    if (reason === 'CANCELLED' || reason === 'STOPPED') {
      CLI.renderPromptInputNotice('Task stopped safely. Ready for your next request / prompt:', { force: true });
    } else if (reason === 'CIRCUIT_BREAKER_TRIGGERED') {
      CLI.renderPromptInputNotice('LLM paused due to exhausted quota or overloaded servers. You can switch models (/model) or wait a few minutes:', { force: true });
    }
  }

  private static lastCancelledToastTimestamp = 0;

  static resetToastDebounceTimestamps(): void {
    CLI.lastCancelledToastTimestamp = 0;
    CLI.lastPromptNoticeTimestamp = 0;
  }

  static renderTaskCancelledToast(
    message = 'Task stopped as requested (Ctrl+C / Esc).',
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
      CLI.renderPromptInputNotice('Stopped the running task. Enter a new prompt to continue:', { force: options.force });
    } else {
      console.log('');
    }
  }

  private static lastPromptNoticeTimestamp = 0;

  static renderPromptInputNotice(
    hint = 'Ready for a new command. Enter your request / prompt:',
    options: { force?: boolean } = {},
  ): void {
    const now = Date.now();
    // Chống in lặp liên tiếp thông báo prompt trong vòng 400ms
    if (!options.force && now - CLI.lastPromptNoticeTimestamp < 400) {
      return;
    }
    CLI.lastPromptNoticeTimestamp = now;
    console.log(`  ${c.brightCyan}💬 ${hint}${c.reset}`);
    console.log(`  ${c.slate}💡 Tip: Type a command, or type ${c.bold}/help${c.reset}${c.slate} for help, ${c.bold}/exit${c.reset}${c.slate} to exit the program.${c.reset}\n`);
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

  /**
   * Hiển thị Giao diện Xem trước Thay đổi (Diff View) trực quan dưới dạng Git Diff.
   * Màu đỏ là nội dung cũ (-), màu xanh là nội dung mới (+).
   */
  static renderDiffView(
    diffText: string,
    target?: string,
    options: { autoApproved?: boolean; title?: string } = {}
  ): void {
    if (!diffText || !diffText.trim()) return;

    const lines = diffText.replace(/\r\n/g, '\n').trim().split('\n');
    const displayTarget = target || 'File Mutation';
    const isAuto = Boolean(options.autoApproved);

    const bannerHeader = isAuto
      ? `┌── ⚡ [AUTO-APPROVED IN SESSION] CHANGE PREVIEW (DIFF VIEW): ${displayTarget} `
      : `┌── 📄 CHANGE PREVIEW (DIFF VIEW): ${displayTarget} `;
    const bannerFooter = isAuto
      ? `└── ⚡ [AUTO-APPROVED SESSION ACTION] Changes will be applied automatically ──────────┘`
      : `└── ⏳ [MINUS PERMISSION APPROVAL] Please review before granting permission ────────┘`;

    let buf = `\n  ${c.brightCyan}${bannerHeader}${c.reset}\n`;
    const contentWidth = Math.max(1, getTerminalWidth() - 4);

    const maxLines = 50;
    const renderLines = lines.slice(0, maxLines);

    for (const line of renderLines) {
      let lineColor = '';
      if (line.startsWith('---') || line.startsWith('+++')) {
        lineColor = c.slate;
      } else if (line.startsWith('@@')) {
        lineColor = c.cyan;
      } else if (line.startsWith('-')) {
        lineColor = c.crimson;
      } else if (line.startsWith('+')) {
        lineColor = c.emerald;
      } else if (line.startsWith('rename from ') || line.startsWith('rename to ') || line.startsWith('similarity index ')) {
        lineColor = c.amber;
      }
      for (const segment of wrapTerminalLine(line.replace(/\t/g, '    '), contentWidth)) {
        buf += `  ${lineColor}${segment}${c.reset}\n`;
      }
    }

    if (lines.length > maxLines) {
      buf += `  ${c.slate}  ... (+${lines.length - maxLines} more changed lines)${c.reset}\n`;
    }

    buf += `  ${c.slate}${truncateToTerminalWidth(isAuto ? 'Thay đổi sẽ tự động áp dụng' : 'Xem kỹ trước khi cấp quyền', contentWidth)}${c.reset}`;
    console.log(buf);
  }

  /**
   * Hiển thị thông báo và Diff View cho thao tác sửa file khi người dùng đã chọn approve_all_session.
   */
  static renderSessionAutoApprovedDiff(request: {
    toolName: string;
    target: string;
    summary?: string;
    diff?: string;
  }): void {
    console.log(`\n  ${c.brightCyan}⚡ [AUTO-APPROVED IN SESSION]${c.reset} ${c.slate}Auto-approve file changes per session settings:${c.reset} ${c.bold}${request.toolName}${c.reset} ── ${c.brightCyan}${request.target}${c.reset}`);
    if (request.diff) {
      CLI.renderDiffView(request.diff, request.target, { autoApproved: true });
    }
  }

  static renderPermissionPrompt(request: {
    toolName: string;
    category: string;
    target: string;
    summary: string;
    riskLevel: string;
    details?: Record<string, any>;
    diff?: string;
  }): void {
    const rawTarget = (request.target || '').trim();
    const fallbackTarget = request.details
      ? String(request.details.command || request.details.CommandLine || request.details.commandLine || request.details.cmd || request.details.path || request.details.filePath || '').trim()
      : '';
    const displayTarget = rawTarget || fallbackTarget || '(unknown)';

    // Nếu có Git Diff xem trước, hiển thị Diff View trực quan trước hộp thoại cấp quyền
    if (request.diff) {
      CLI.renderDiffView(request.diff, displayTarget, { autoApproved: false });
    }

    let displaySummary = request.summary || '';
    const hasEmptyPlaceholder = displaySummary.includes(': ""') || displaySummary.trim() === '""';
    if (!displaySummary && displayTarget && displayTarget !== '(unknown)') {
      displaySummary = `Execute operation on "${displayTarget}"`;
    } else if (hasEmptyPlaceholder && displayTarget && displayTarget !== '(unknown)') {
      displaySummary = displaySummary.replace(': ""', `: "${displayTarget}"`).replace(/^""$/, `"${displayTarget}"`);
    }

    console.log(`\n  ${c.amber}${c.bold}⚠️  PERMISSION REQUEST${c.reset} [${request.riskLevel}]`);
    console.log(`  Tool: ${c.bold}${request.toolName}${c.reset} ── Target: ${c.brightCyan}${displayTarget}${c.reset}`);
    console.log(`  Desc: ${displaySummary}`);
    if (request.details?.misuse) {
      console.log(`  ${c.geminiPurple || c.magenta}💡 Tip: Press [n] to reject and switch to tool: ${c.brightCyan}${request.details.misuse.tool}${c.reset}`);
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
    console.log(`  ${c.slate}↳ Steering message injected into context; the Agent is adjusting its reasoning right in this step.${c.reset}\n`);
  }

  static renderQueuedMessageEnqueued(text: string, id: string): void {
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    console.log(`\n  ${c.bgCyan}${c.bold} ⚡ QUEUED MESSAGE ENQUEUED (MID-TURN STEERING) ${c.reset} [${id}]`);
    console.log(`  ${c.brightCyan}"${preview}"${c.reset}`);
    console.log(`  ${c.slate}↳ Command queued; the Agent will pick it up and adjust its actions at the very next step.${c.reset}\n`);
  }

  static renderQueueStatus(items: Array<{ id: string; text: string; source: string; enqueuedAt: string }>): void {
    if (items.length === 0) {
      console.log(`\n  ${c.slate}ℹ Queued Messages queue is empty (0 messages).${c.reset}\n`);
      return;
    }
    console.log(`\n${c.brightCyan}${c.bold}❯ QUEUED MESSAGES (${items.length})${c.reset}`);
    items.forEach((item, index) => {
      const time = item.enqueuedAt ? new Date(item.enqueuedAt).toLocaleTimeString() : '';
      const preview = item.text.replace(/\s+/g, ' ');
      const truncated = preview.length > 70 ? `${preview.slice(0, 67)}...` : preview;
      console.log(`  ${c.bold}#${index + 1}${c.reset} [${c.amber}${item.id}${c.reset}] ${c.slate}(${item.source || 'human'} · ${time})${c.reset}: ${truncated}`);
    });
    console.log(`  ${c.slate}💡 Use /queue cancel <id> to cancel or /queue clear to clear the queue.${c.reset}\n`);
  }

  static getPromptSymbol(): string {
    return `${c.geminiCyan || c.brightCyan}${c.bold}❯${c.reset} `;
  }
}

export const formatMarkdownTerminal = CLI.formatMarkdownTerminal;
export const formatLatexArrows = CLI.formatLatexArrows;
export const renderTaskCancelledToast = CLI.renderTaskCancelledToast.bind(CLI);
export const renderPromptInputNotice = CLI.renderPromptInputNotice.bind(CLI);
export const renderDockerStatus = CLI.renderDockerStatus.bind(CLI);
export const renderDockerToggleNotice = CLI.renderDockerToggleNotice.bind(CLI);
export const renderDockerStartupPrompt = CLI.renderDockerStartupPrompt.bind(CLI);
export const promptDockerStartupChoice = CLI.promptDockerStartupChoice.bind(CLI);
