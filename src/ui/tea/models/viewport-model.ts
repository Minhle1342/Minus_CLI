import type { ViewportModel, TranscriptEntry, SessionTab, SessionTabsModel, RootModel, Cmd, KeyMsg, ComposerModel, DiffViewerModel } from '../types.js';
import { color, displayWidth, fit, lipGlossTheme, stripTerminalControls, tokyoNight, wrap } from '../styles/theme.js';
import { formatMarkdownTablesWithTea } from '../styles/table.js';
import { toolCallEntry, toolResultEntry, diffFrame, diffLineTone } from './tool-entry.js';
import { createComposer } from './composer-model.js';
import { createDiffViewer } from './diff-model.js';
import type { PermissionCard } from '../types.js';
export function appendEntry(model: ViewportModel, entry: TranscriptEntry): ViewportModel {
  return { ...model, entries: [...model.entries.slice(-999), entry] };
}
const cachedLines = new WeakMap<TranscriptEntry, Map<number, string[]>>();

/** Lightweight terminal syntax coloring for code in answers and tool output. */
function highlightCode(line: string): string {
  const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|#.*|\/\*.*?\*\/|\b(?:const|let|var|function|class|interface|type|import|export|from|return|if|else|for|while|async|await|def|lambda|try|catch|throw|new|public|private|true|false|null|undefined|None|True|False)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
  let rendered = '';
  let offset = 0;
  for (const match of line.matchAll(tokens)) {
    const at = match.index ?? 0;
    rendered += color(tokyoNight.text, line.slice(offset, at));
    const token = match[0];
    const tone = token.startsWith('//') || token.startsWith('#') || token.startsWith('/*') ? tokyoNight.muted
      : /^["'`]/.test(token) ? tokyoNight.green
      : /^\d/.test(token) ? tokyoNight.yellow
      : /^(?:true|false|null|undefined|None|True|False)$/.test(token) ? tokyoNight.yellow
      : /^(?:const|let|var|function|class|interface|type|import|export|from|return|if|else|for|while|async|await|def|lambda|try|catch|throw|new|public|private)$/.test(token) ? tokyoNight.purple
      : tokyoNight.blue;
    rendered += color(tone, token);
    offset = at + token.length;
  }
  return rendered + color(tokyoNight.text, line.slice(offset));
}

function formatTool(text: string): string {
  const raw = stripTerminalControls(text).split('\n');
  // shortcut: khung diff có viewer riêng (Ctrl+X D) — gọn thành 1 dòng tóm tắt thay vì tô màu từng dòng.
  const skip = new Set<number>();
  const summaryAt = new Map<number, string>();
  for (let i = 0; i < raw.length; i++) {
    const header = /^\s*╭─ diff (.+?)\s*─\s*$/.exec(raw[i]);
    if (!header) continue;
    let end = -1;
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j].trim().startsWith('╰─')) { end = j; break; }
    }
    if (end < 0) continue; // khung không đóng: giữ nguyên, không nuốt tail
    const stats = /\+(\d+)\s+-(\d+)/.exec(raw[end]);
    for (let j = i; j <= end; j++) skip.add(j);
    summaryAt.set(i, `⋯ diff ${header[1]}${stats ? ` (+${stats[1]} -${stats[2]})` : ''} · Ctrl+X D`);
  }
  return raw.map((line, index): string | null => {
    if (skip.has(index)) {
      const summary = summaryAt.get(index);
      return summary ? color(tokyoNight.muted, summary) : null;
    }
    if (index === 0) {
      if (line.startsWith('✖')) return color(tokyoNight.red, line);
      // TUI: read-only call lines (›) are subordinate to the conversation —
      // render muted so mutation tools (●/✔) keep visual weight.
      if (line.startsWith('› ')) return color(tokyoNight.muted, line);
      return color(tokyoNight.cyan, line);
    }
    if (/^[╭├╰─┬┼┴]/.test(line.trim())) return color(tokyoNight.border, line);
    if (line.includes('│')) {
      const parts = line.split('│');
      return parts.map((cell, i) => {
        if (i === 0 && cell === '') return '';
        if (i === parts.length - 1 && cell === '') return '';
        return i === 1 ? color(tokyoNight.cyan, cell) : color(tokyoNight.text, cell);
      }).join(color(tokyoNight.border, '│'));
    }
    return highlightCode(line);
  }).filter((l): l is string => l !== null).join('\n');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    // Standard markdown backslash escapes: the guard lookbehinds in
    // formatAnswerInline keep `\X` literal, so unescape here instead.
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
}

/** Render prose delimiters as color; quoted strings inside code remain literal. */
export function formatAnswerInline(body: string, base: string, depth = 0): string {
  if (depth > 8) return color(base, body);
  const tokens = /(?<!\\)(`[^`\n]+`|!\[[^\]\n]*\]\([^)\n]+\)|\[[^\]\n]+\]\([^)\n]+\)|<kbd>[^<\n]+<\/kbd>|<mark>[^<\n]+<\/mark>|<u>[^<\n]+<\/u>|\*\*\*(?!\s)[^\*\n]+?(?<!\s)\*\*\*|(?<![\p{L}\p{N}])___(?!\s)[^_\n]+?(?<!\s)___(?![\p{L}\p{N}])|\*\*(?!\s)[^\*\n]+?(?<!\s)\*\*|(?<![\p{L}\p{N}])__(?!\s)[^_\n]+?(?<!\s)__(?![\p{L}\p{N}])|~~(?!\s)[^~\n]+?(?<!\s)~~|(?<![\p{L}\p{N}\*])\*(?!\s|\*)[^\*\n]+?(?<!\s|\*)\*(?![\p{L}\p{N}\*])|(?<![\p{L}\p{N}_])_(?!\s|_)[^_\n]+?(?<!\s|_)_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}]))/gu;
  let styled = '';
  let offset = 0;
  for (const match of body.matchAll(tokens)) {
    const at = match.index ?? 0;
    styled += color(base, decodeHtmlEntities(body.slice(offset, at)));
    const token = match[0];
    if (token.startsWith('`')) {
      styled += color(tokyoNight.green, token.slice(1, -1));
    } else if (token.startsWith('![')) {
      const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
      if (img) {
        const label = img[1] ? `🖼 ${img[1]}` : '🖼 image';
        styled += color(tokyoNight.purple, label) + color(tokyoNight.muted, ` (${img[2]})`);
      } else {
        styled += color(base, token);
      }
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      styled += formatAnswerInline(link[1], tokyoNight.blue, depth + 1)
        + color(tokyoNight.muted, ` (${link[2]})`);
    } else if (token.startsWith('<kbd>')) {
      const kbd = /^<kbd>([^<\n]+)<\/kbd>$/i.exec(token);
      styled += kbd ? color(tokyoNight.yellow, `[${kbd[1]}]`) : color(base, token);
    } else if (token.startsWith('<mark>')) {
      const mark = /^<mark>([^<\n]+)<\/mark>$/i.exec(token);
      styled += mark ? color(tokyoNight.yellow, mark[1]) : color(base, token);
    } else if (token.startsWith('<u>')) {
      const u = /^<u>([^<\n]+)<\/u>$/i.exec(token);
      styled += u ? `\x1b[4m${color(base, u[1])}\x1b[24m` : color(base, token);
    } else if (token.startsWith('***') || token.startsWith('___')) {
      styled += `\x1b[1;3m${formatAnswerInline(token.slice(3, -3), tokyoNight.yellow, depth + 1)}\x1b[22;23m`;
    } else if (token.startsWith('**') || token.startsWith('__')) {
      styled += formatAnswerInline(token.slice(2, -2), tokyoNight.yellow, depth + 1);
    } else if (token.startsWith('~~')) {
      styled += `\x1b[9m${color(tokyoNight.muted, token.slice(2, -2))}\x1b[29m`;
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_'))) {
      styled += `\x1b[3m${formatAnswerInline(token.slice(1, -1), tokyoNight.cyan, depth + 1)}\x1b[23m`;
    } else if (token.startsWith("'")) {
      styled += color(tokyoNight.green, token.slice(1, -1));
    } else {
      styled += color(base, token);
    }
    offset = at + token.length;
  }
  return styled + color(base, decodeHtmlEntities(body.slice(offset)));
}

export function formatAnswer(text: string, width = 80): string {
  const tableProcessed = formatMarkdownTablesWithTea(text, Math.max(20, width));
  const rawLines = stripTerminalControls(tableProcessed).split('\n');
  // Setext H1 underline (===): fold into the previous text line as ATX.
  // `---` intentionally stays a horizontal rule (pinned by tests).
  const lines: string[] = [];
  let inFence = false;
  for (const line of rawLines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) inFence = !inFence;
    const prev = lines.length > 0 ? lines[lines.length - 1] : '';
    const prevIsProse = prev.trim() !== ''
      && !/^[╭├╰─┬┼┴]/.test(prev.trim())
      && !prev.includes('│')
      && !/^(?: {4}|\t)/.test(prev)
      && !/^\s{0,3}(#{1,6}\s|>+\s*|(?:[-*•]|\d+\.)\s|(`{3,}|~{3,}))/.test(prev);
    if (!inFence && /^\s{0,3}=+\s*$/.test(line) && prevIsProse) {
      lines[lines.length - 1] = `# ${prev.trim()}`;
    } else {
      lines.push(line);
    }
  }
  let codeFence: { marker: string; length: number } | undefined;
  let firstContentLine = true;
  return lines.flatMap(line => {
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (codeFence) {
      if (fence && fence[1][0] === codeFence.marker && fence[1].length >= codeFence.length && !fence[2].trim()) {
        codeFence = undefined;
        return [];
      }
      return [highlightCode(line)];
    }
    if (fence) {
      codeFence = { marker: fence[1][0], length: fence[1].length };
      return [];
    }
    if (/^[╭├╰─┬┼┴]/.test(line.trim())) {
      firstContentLine = false;
      return [color(tokyoNight.border, line)];
    }
    if (line.includes('│')) {
      firstContentLine = false;
      const parts = line.split('│');
      return [parts.map((cell, i) => {
        if (i === 0 && cell === '') return '';
        if (i === parts.length - 1 && cell === '') return '';
        const targetWidth = displayWidth(cell);
        // Own Table rows pad cells with a leading space; foreign │ lines
        // (model-drawn, pasted output) must not lose their first character.
        const content = (cell.startsWith(' ') ? cell.slice(1) : cell).trim();
        const formatted = formatAnswerInline(content, tokyoNight.text);
        const pad = Math.max(0, targetWidth - 1 - displayWidth(formatted) - 1);
        return ' ' + formatted + ' '.repeat(pad) + ' ';
      }).join(color(tokyoNight.border, '│'))];
    }

    const hr = /^\s{0,3}(?:[-*_]\s*){3,}$/.exec(line);
    if (hr) {
      firstContentLine = false;
      const hrWidth = Math.min(Math.max(width, 10), 80);
      return [color(tokyoNight.border, '─'.repeat(hrWidth))];
    }

    const quote = /^\s{0,3}>+\s*(.*)$/.exec(line);
    if (quote) {
      firstContentLine = false;
      return [color(tokyoNight.purple, '▎ ') + formatAnswerInline(quote[1], tokyoNight.muted)];
    }

    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    if (heading) {
      firstContentLine = false;
      return [formatAnswerInline(heading[1], tokyoNight.purple)];
    }

    const bullet = /^(\s*(?:[-*•]|\d+\.))(\s+)/.exec(line);
    let marker = '';
    let body = line;
    if (bullet) {
      const remaining = line.slice(bullet[0].length);
      const task = /^\[([ xX])\]\s+/.exec(remaining);
      if (task) {
        const isChecked = task[1].toLowerCase() === 'x';
        const checkbox = isChecked
          ? color(tokyoNight.green, '☑ ')
          : color(tokyoNight.muted, '☐ ');
        marker = color(tokyoNight.blue, bullet[1]) + bullet[2] + checkbox;
        body = remaining.slice(task[0].length);
      } else {
        marker = color(tokyoNight.blue, bullet[1]) + bullet[2];
        body = remaining;
      }
    }
    const base = firstContentLine ? tokyoNight.cyan : tokyoNight.text;
    if (line.trim()) firstContentLine = false;
    return [marker + formatAnswerInline(body, base)];
  }).join('\n');
}

function permissionLines(request: PermissionCard, width: number): string[] {
  const risk = request.riskLevel.toUpperCase();
  const riskColor = /HIGH|CRITICAL/.test(risk) ? tokyoNight.red : risk === 'MEDIUM' ? tokyoNight.yellow : tokyoNight.green;
  // Khung diff inline ngay cuối card (capped 12 dòng); full xem bằng Ctrl+X D.
  const frame = request.diff ? diffFrame(request.target || request.toolName, request.diff) : undefined;
  const fields = [
    color(tokyoNight.purple, 'Permission request') + '  ' + color(riskColor, `[${risk}]`),
    color(tokyoNight.muted, 'Tool     ') + color(tokyoNight.cyan, stripTerminalControls(request.toolName)),
    color(tokyoNight.muted, 'Category ') + color(tokyoNight.text, stripTerminalControls(request.category).replace(/_/g, ' ')),
    color(tokyoNight.muted, 'Target   ') + color(tokyoNight.blue, stripTerminalControls(request.target)),
    ...(request.summary ? ['', color(tokyoNight.text, stripTerminalControls(request.summary))] : []),
    ...(request.suggestedTool ? [color(tokyoNight.yellow, 'Suggested tool: ') + color(tokyoNight.cyan, stripTerminalControls(request.suggestedTool))] : []),
    ...(frame ? frame.split('\n').map((line) => color(diffLineTone(line) ?? tokyoNight.text, line)) : []),
  ];
  if (width < 6) return fields.flatMap(line => wrap(line, width));
  const innerWidth = width - 4;
  const edge = (text: string) => color(tokyoNight.border, text);
  return [edge('╭' + '─'.repeat(width - 2) + '╮'),
    ...fields.flatMap(line => wrap(line, innerWidth)).map(line => edge('│') + ' ' + fit(line, innerWidth) + ' ' + edge('│')),
    edge('╰' + '─'.repeat(width - 2) + '╯')];
}

/** Rendered lines contributed by one transcript entry (cached per width). */
function entryLines(entry: TranscriptEntry, width: number, collapsed: boolean, pairDivider: string): string[] {
    let widths = cachedLines.get(entry);
    if (!widths) { widths = new Map(); cachedLines.set(entry, widths); }
    let rendered = widths.get(width);
    if (!rendered) {
      const prefix = entry.kind === 'user' ? 'You › ' : entry.kind === 'answer' ? 'Minus › ' : entry.kind === 'thought' ? 'Thinking › ' : '';
      const prefixColor = entry.kind === 'user' ? tokyoNight.blue : entry.kind === 'answer' ? tokyoNight.purple : tokyoNight.muted;
      const textColor = entry.kind === 'thought' ? tokyoNight.muted : entry.kind === 'tool' ? tokyoNight.cyan : entry.kind === 'step' ? tokyoNight.yellow : tokyoNight.text;
      // Thinking is model prose: same markdown pipeline as the answer, the
      // muted "Thinking › " prefix keeps it visually subordinate.
      const body = entry.kind === 'answer' || entry.kind === 'thought' ? formatAnswer(entry.text, width)
        : entry.kind === 'tool' ? formatTool(entry.text)
        : color(textColor, stripTerminalControls(entry.text));
      rendered = entry.kind === 'permission' && entry.permission
        ? permissionLines(entry.permission, width)
        : wrap(color(prefixColor, prefix) + body, width);
      widths.set(width, rendered);
    }
    // Tool result terminal markers (✔/✖/⊘) close the pair; call rows (›/●) do not.
    const isToolResult = entry.kind === 'tool' && /^[✔✖⊘]/.test(entry.text.trimStart());
    if (collapsed && ['thought', 'tool', 'step'].includes(entry.kind)) {
      if (rendered.length <= 1) return isToolResult ? [...rendered, pairDivider] : rendered;
      const label = entry.kind === 'thought' ? 'Thinking' : entry.kind === 'tool' ? 'Tool' : 'Step';
      const labelColor = entry.kind === 'thought' ? tokyoNight.muted : entry.kind === 'tool' ? tokyoNight.cyan : tokyoNight.yellow;
      const badge = color(tokyoNight.purple, '▸ ') + color(labelColor, label)
        + color(tokyoNight.muted, ` · ${rendered.length - 1} lines hidden · `);
      const summary = stripTerminalControls(entry.text).split('\n')[0].trim();
      const summaryColor = summary.startsWith('✖') ? tokyoNight.red : entry.kind === 'thought' ? tokyoNight.muted : tokyoNight.text;
      const badgeLines = wrap(badge + color(summaryColor, summary), width).slice(0, 1);
      return isToolResult ? [...badgeLines, pairDivider] : badgeLines;
    }
    // TUI: single-line (read-only) tool rows take no blank separator, so a
    // call + result pair costs 2 rows instead of 4+. Multi-line entries keep
    // the breathing room.
    if (entry.kind === 'tool' && !entry.text.includes('\n')) {
      return isToolResult ? [...rendered, pairDivider] : rendered;
    }
    return isToolResult ? [...rendered, pairDivider] : [...rendered, ''];
  }

/**
 * Lines rendered below the last `Minus ›` answer. Offsetting by this parks the
 * answer at the bottom of the viewport; undefined when no answer exists.
 * Caller clamps against its own maxOffset.
 */
export function lastAnswerOffset(model: ViewportModel, width: number): number | undefined {
  const index = model.entries.findLastIndex((e) => e.kind === 'answer');
  if (index < 0) return undefined;
  const pairDivider = color(tokyoNight.border, '─'.repeat(Math.max(0, width)));
  return model.entries.slice(index + 1)
    .reduce((sum, entry) => sum + entryLines(entry, width, model.collapsed, pairDivider).length, 0)
    + (model.thinking ? 1 : 0) + (model.answerStream ? 1 : 0);
}

export function viewportLines(model: ViewportModel, width: number): string[] {
  // TUI: divider Tokyo Night khép mỗi cặp tool đã xong (call + result).
  // Vẽ ở tầng render nên live + history replay đều có, không tốn entry.
  const pairDivider = color(tokyoNight.border, '─'.repeat(Math.max(0, width)));
  const lines = model.entries.flatMap(entry => entryLines(entry, width, model.collapsed, pairDivider));
  // TUI: thinking is ephemeral (archived into a thought entry on flush) — show
  // only the tail as one flattened line so the stream never floods the viewport.
  if (model.thinking) {
    const tail = stripTerminalControls(model.thinking).replace(/\s+/g, ' ').trim().slice(-240);
    lines.push(...wrap(color(tokyoNight.muted, '… Thinking › ' + tail), width));
  }
  // P1: streaming answer keeps an ellipsis marker so it reads differently from a final `Minus ›` answer.
  if (model.answerStream) lines.push(...wrap(color(tokyoNight.purple, 'Minus … › ') + formatAnswer(model.answerStream, width), width));
  return lines;
}
export function viewportView(model: ViewportModel, width: number, height: number, selectedLines?: string[]): string[] {
  const lines = selectedLines || viewportLines(model, width);
  const bottom = Math.max(height, lines.length - model.offset);
  const visible = lines.slice(Math.max(0, bottom - height), bottom);
  return Array.from({ length: height }, (_, i) => fit(visible[i] || '', width));
}

// ─── Session tabs: chuyển + quản lý nhiều session song song trong 1 terminal ───
// UX: 1 dòng tab-strip luôn nằm ngay trên viewport + 1 modal quản lý (mở bằng
// Ctrl+T). Mỗi tab cache transcript riêng nên switch là tức thì, task nền giữ
// nguyên entries khi quay lại. Cmd session-* để lớp ngoài bind kernel/persist.
let newTabSeq = Math.floor(Math.random() * 46656);

export function createSessionTabs(activeId = '', titles: string[] = []): SessionTabsModel {
  const ids = titles.length ? titles : (activeId ? [activeId] : []);
  const tabs: SessionTab[] = ids.map(id => ({ id, title: shortTabTitle(id), lastActive: 0 }));
  if (!tabs.length) tabs.push({ id: activeId || 'main', title: shortTabTitle(activeId || 'main'), lastActive: 0 });
  const active = activeId && tabs.some(t => t.id === activeId) ? activeId : tabs[0].id;
  return { open: false, selected: Math.max(0, tabs.findIndex(t => t.id === active)), tabs, activeId: active };
}

export function shortTabTitle(id: string): string {
  const clean = stripTerminalControls(id).trim() || 'main';
  return clean.length > 18 ? '…' + clean.slice(-17) : clean;
}

/**
 * Project event-log history (Content[]) thành TranscriptEntry[] để hydrate viewport
 * khi switch sang session cũ. Mirror đúng entries lúc live để render ra giống hệt:
 * - text user/model → kind user/answer (đi qua formatAnswer markdown như live)
 * - thought parts → kind thought (như Thinking đã archive lúc stream)
 * - functionCall → kind tool qua toolCallEntry (y hệt tool:before live)
 * - functionResponse → kind tool qua toolResultEntry (y hệt tool:after live;
 *   duration 0ms vì event log không persist thời gian chạy tool)
 */
/**
 * System steering blocks are model scaffolding, never user content: hide the
 * whole bubble when hydrating history into the transcript. Wrappers around
 * real user text unwrap to the text. A user literally typing a marker stays
 * hidden — same accepted tradeoff as the final-answer echo strip (vanishingly
 * rare, display-only: the model context and event log are untouched).
 */
const HIDDEN_TRANSCRIPT_LEADERS = [
  '[SUBMISSION REQUIRED]',
  '[STRONG ADVISORY',
  '[ADAPTIVE REASONING',
  '🧠 [ADAPTIVE REASONING',
  '[EVIDENCE_GATE_OBSERVE]',
  '[WEAK_SUBMISSION_SUMMARY_',
  '[REPRODUCTION_VERIFICATION_',
  '[VERIFICATION LADDER',
  '[UNVERIFIED_MUTATION',
  '[CASCADE_REPAIR_',
  '[READY TO SUBMIT]',
  '[VERIFICATION REQUIREMENTS SATISFIED]',
  '[RESPONSE LANGUAGE]',
  '[SYSTEM ',
  '[CRITIC ',
  '[ROLLING DIALOGUE SYNOPSIS',
];
const UNWRAP_TRANSCRIPT_LEADERS = [
  '[USER QUEUED MESSAGE (MID-TURN STEERING)]:',
  '[USER INSTRUCTION]:',
];

/** User-visible text for a hydrated user bubble; undefined = hide the bubble. */
export function userVisibleText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'Continue') return undefined;
  for (const leader of HIDDEN_TRANSCRIPT_LEADERS) {
    if (trimmed.startsWith(leader)) return undefined;
  }
  if (trimmed.includes('[USER INSTRUCTION]:')) {
    const parts = trimmed.split('[USER INSTRUCTION]:');
    const inner = parts[parts.length - 1].trim();
    return inner || undefined;
  }
  for (const leader of UNWRAP_TRANSCRIPT_LEADERS) {
    if (trimmed.startsWith(leader)) {
      const inner = trimmed.slice(leader.length).trim();
      return inner || undefined;
    }
  }
  return text;
}

interface HistoryPart { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown; id?: string }; functionResponse?: { name?: string; id?: string; response?: unknown } }
export function sessionHistoryToTranscript(messages: Array<{
  role?: string;
  parts?: Array<{ text?: string; thought?: boolean; functionCall?: unknown; functionResponse?: unknown }>;
}>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Index tool-call args by call ID so hydrated tool results can render diff
  // frames and line ranges identically to live rendering. functionCall and
  // functionResponse live in separate messages (model → user), so we build the
  // map in a first pass before projecting entries.
  const callArgsById = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    for (const part of message.parts || []) {
      const call = part.functionCall;
      if (call && typeof call === 'object' && call.id) {
        const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
          ? call.args as Record<string, unknown> : {};
        callArgsById.set(String(call.id), args);
      }
    }
  }
  for (const message of messages) {
    const parts = ((message.parts || []) as HistoryPart[]);
    const isAssistant = message.role === 'model' || message.role === 'assistant';
    if (!isAssistant && message.role !== 'user') continue;
    for (const part of parts) {
      if (part.thought && typeof part.text === 'string' && part.text.trim()) {
        entries.push({ kind: 'thought', text: part.text.trim() });
      }
    }
    const text = parts
      .filter((part) => !part.thought && !part.functionCall && !part.functionResponse && typeof part.text === 'string')
      .map((part) => (part.text as string).trim())
      .filter(Boolean)
      .join('\n');
    if (text) {
      if (!isAssistant) {
        const visible = userVisibleText(text);
        if (visible !== undefined) entries.push({ kind: 'user', text: visible });
      } else {
        entries.push({ kind: 'answer', text });
      }
    }
    // Tool parts hydrate even when the message carries no prose: the model
    // routinely emits call-only messages, and tool/result events project as
    // text-less user-role messages (see Session.addToolResultWithId). Dropping
    // them here would silently strip every tool entry from a hydrated tab.
    if (isAssistant) {
      for (const part of parts) {
        const call = part.functionCall;
        if (call && typeof call === 'object') {
          const name = typeof call.name === 'string' && call.name ? call.name : 'unknown_tool';
          const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? call.args as Record<string, unknown> : {};
          entries.push({ kind: 'tool', text: toolCallEntry(name, args) });
        }
      }
    }
    for (const part of parts) {
      const resp = part.functionResponse;
      if (resp && typeof resp === 'object') {
        const name = typeof resp.name === 'string' && resp.name ? resp.name : 'unknown_tool';
        const raw = (resp as { response?: unknown }).response;
        let result = raw && typeof raw === 'object' && !Array.isArray(raw)
          ? raw as Record<string, unknown> : { output: raw };
        // ponytail: Với các session cũ có tool output khổng lồ, cắt bớt output dài quá 2000 ký tự để tiết kiệm RAM & tránh lag wrap
        if (typeof result.output === 'string' && result.output.length > 2000) {
          result = { ...result, output: result.output.slice(0, 2000) + '\n… (output omitted from history)' };
        } else if (typeof result.content === 'string' && result.content.length > 2000) {
          result = { ...result, content: result.content.slice(0, 2000) + '\n… (content omitted from history)' };
        }
        // Truyền args (tương ứng với live path) để diff frame + line range
        // hiển thị đúng khi khôi phục session cũ.
        const args = resp.id ? callArgsById.get(String(resp.id)) : undefined;
        entries.push({ kind: 'tool', text: toolResultEntry(name, result, 0, args) });
      }
    }
  }
  const maxEntries = Number.parseInt(process.env.MINUS_TRANSCRIPT_MAX_ENTRIES || '', 10) || 1000;
  return entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
}

/** Đồng bộ tab list từ sidebar.sessions (persisted ids) mà không mất cache entries. */
export function syncSessionTabs(model: SessionTabsModel, ids: string[], activeId: string, titles?: string[]): SessionTabsModel {
  const byId = new Map(model.tabs.map(t => [t.id, t]));
  const tabs: SessionTab[] = ids.length
    ? ids.map((id, i) => ({ ...(byId.get(id) || { id, lastActive: 0 }), id, title: titles?.[i] ? shortTabTitle(titles[i]) : byId.get(id)?.title || shortTabTitle(id) }))
    : model.tabs.length ? model.tabs : [{ id: activeId || 'main', title: shortTabTitle(activeId || 'main'), lastActive: 0 }];
  // Giữ tab đang active dù kernel chưa persist kịp (optimistic new-tab).
  // activeId có thể là tên hiển thị (setMetadata {session: name}) → resolve sang id.
  const looksLikeId = activeId && (tabs.some(t => t.id === activeId) || byId.has(activeId));
  if (activeId && !looksLikeId) {
    const byTitle = tabs.find(t => t.title === shortTabTitle(activeId) || t.title === activeId)
      || [...byId.values()].find(t => t.title === shortTabTitle(activeId));
    if (byTitle) {
      if (!tabs.some(t => t.id === byTitle.id)) tabs.push(byTitle);
      return { ...model, tabs, activeId: byTitle.id, selected: Math.max(0, tabs.findIndex(t => t.id === byTitle.id)) };
    }
    // Tên lạ (chưa có tab): giữ active cũ, không tạo tab rác từ tên hiển thị.
    const keep = model.activeId && tabs.some(t => t.id === model.activeId) ? model.activeId : tabs[0].id;
    return { ...model, tabs, activeId: keep, selected: Math.max(0, tabs.findIndex(t => t.id === keep)) };
  }
  if (activeId && !tabs.some(t => t.id === activeId)) {
    const kept = byId.get(activeId);
    tabs.push(kept || { id: activeId, title: shortTabTitle(activeId), lastActive: Date.now() });
  }
  const resolved = activeId || model.activeId || tabs[0].id;
  return { ...model, tabs, activeId: resolved, selected: Math.max(0, tabs.findIndex(t => t.id === resolved)) };
}

/** Lưu transcript + stream buffer + chrome (composer/diff/tools/tokens) hiện tại vào tab active trước khi switch/new. */
function snapshotActive(model: RootModel): SessionTab[] {
  // NOTE: không snapshot `model` (model tường minh của tab): tab chưa từng /model
  // phải tiếp tục theo default chung thay vì bị ghim vào giá trị lúc switch.
  return model.sessions.tabs.map(t =>
    t.id === model.sessions.activeId
      ? { ...t, entries: model.viewport.entries, thinking: model.viewport.thinking, answerStream: model.viewport.answerStream, lastActive: Date.now(),
        composer: sanitizeComposer(model.composer), diff: model.diff, tools: model.sidebar.tools, tokens: model.sidebar.tokens }
      : t);
}

/** Bỏ state ephemeral (completions async, mouse selection) khỏi composer trước khi cache — draft/value/cursor/history giữ nguyên theo tab. */
export function sanitizeComposer(composer: ComposerModel): ComposerModel {
  return { ...composer, completions: [], selected: 0, selection: undefined };
}

/** Restore chrome của tab ra xem: composer/diff/tools/tokens/model riêng từng session. */
export function restoreTabChrome(target: SessionTab): { composer: ComposerModel; diff: DiffViewerModel; tools: string[]; tokens: number; model?: string } {
  return {
    composer: target.composer ? sanitizeComposer(target.composer) : createComposer(),
    diff: target.diff ?? createDiffViewer(),
    tools: target.tools ?? [],
    tokens: target.tokens ?? 0,
    model: target.model,
  };
}

/** Model hiển thị cho tab: tường minh theo tab, else default chung, else sidebar hiện tại. */
export function tabDisplayModel(model: RootModel, tab: SessionTab): string {
  return tab.model ?? model.sessions.defaultModel ?? model.sidebar.model;
}

/**
 * Session sở hữu task đang chạy. Ưu tiên ctx tường minh từ kernel (đã thread
 * sessionId qua mọi emit) → fallback pin lúc busy → fallback tab đang xem.
 */
export function eventOwnerId(model: RootModel, ownerOverride?: string): string {
  return ownerOverride || model.status.busySessionId || model.sessions.activeId;
}

/** Append entry vào owner: viewport nếu đang xem tab đó, else cache tab + đếm unread. */
export function ownerAppendEntry(model: RootModel, entry: TranscriptEntry, ownerOverride?: string): RootModel {
  const owner = eventOwnerId(model, ownerOverride);
  if (owner === model.sessions.activeId || !model.sessions.tabs.some(t => t.id === owner)) {
    return { ...model, viewport: appendEntry(model.viewport, entry) };
  }
  const tabs = model.sessions.tabs.map(t => t.id === owner
    ? { ...t, entries: [...(t.entries || []).slice(-999), entry], unread: (t.unread || 0) + 1, lastActive: Date.now() }
    : t);
  return { ...model, sessions: { ...model.sessions, tabs } };
}

/** Nối stream chunk (thinking/answerStream) vào buffer của owner. */
export function ownerStream(model: RootModel, field: 'thinking' | 'answerStream', chunk: string, ownerOverride?: string): RootModel {
  const owner = eventOwnerId(model, ownerOverride);
  if (owner === model.sessions.activeId || !model.sessions.tabs.some(t => t.id === owner)) {
    return { ...model, viewport: { ...model.viewport, [field]: model.viewport[field] + chunk } };
  }
  const tabs = model.sessions.tabs.map(t => t.id === owner
    ? { ...t, [field]: (t[field] || '') + chunk, lastActive: Date.now() }
    : t);
  return { ...model, sessions: { ...model.sessions, tabs } };
}

/** Flush thinking buffer của owner thành thought entry (không đụng viewport tab khác). */
export function ownerArchiveThinking(model: RootModel, ownerOverride?: string): RootModel {
  const owner = eventOwnerId(model, ownerOverride);
  if (owner === model.sessions.activeId || !model.sessions.tabs.some(t => t.id === owner)) {
    if (!model.viewport.thinking) return model;
    return { ...model, viewport: { ...appendEntry(model.viewport, { kind: 'thought', text: model.viewport.thinking }), thinking: '' } };
  }
  const tabs = model.sessions.tabs.map(t => (t.id === owner && t.thinking)
    ? { ...t, entries: [...(t.entries || []).slice(-999), { kind: 'thought' as const, text: t.thinking }], thinking: '', unread: (t.unread || 0) + 1 }
    : t);
  return { ...model, sessions: { ...model.sessions, tabs } };
}

/** Xóa stream buffer của owner sau khi flush (final_answer). */
export function ownerClearStream(model: RootModel, field: 'thinking' | 'answerStream', ownerOverride?: string): RootModel {
  const owner = eventOwnerId(model, ownerOverride);
  if (owner === model.sessions.activeId || !model.sessions.tabs.some(t => t.id === owner)) {
    return { ...model, viewport: { ...model.viewport, [field]: '' } };
  }
  const tabs = model.sessions.tabs.map(t => t.id === owner ? { ...t, [field]: '' } : t);
  return { ...model, sessions: { ...model.sessions, tabs } };
}

function switchToTab(model: RootModel, index: number): [RootModel, Cmd[]] {
  const snap = snapshotActive(model);
  const target = snap[Math.min(Math.max(0, index), snap.length - 1)];
  if (!target || target.id === model.sessions.activeId) {
    return [{ ...model, focus: 'composer' as const, sessions: { ...model.sessions, open: false } }, []];
  }
  // Mở tab ra xem: restore cả stream buffer + chrome (composer/diff/tools/tokens) + xóa unread (đã đọc).
  const tabs = snap.map(t => t.id === target.id ? { ...t, unread: 0 } : t);
  const chrome = restoreTabChrome(target);
  return [{
    ...model,
    focus: 'composer' as const,
    selection: undefined, // Bôi đen text là của tab cũ — bỏ khi chuyển tab, kẻo viewport vẫn vẽ ảnh chụp cũ.
    sessions: { ...model.sessions, open: false, tabs, activeId: target.id, pendingActiveId: target.id, selected: tabs.findIndex(t => t.id === target.id) },
    viewport: {
      ...model.viewport,
      entries: target.entries || [],
      thinking: target.busy ? (target.thinking || '') : '',
      answerStream: target.busy ? (target.answerStream || '') : '',
      offset: 0,
      pinned: true,
    },
    composer: chrome.composer,
    diff: chrome.diff,
    sidebar: { ...model.sidebar, session: target.title, tools: chrome.tools, tokens: chrome.tokens, model: tabDisplayModel(model, target) },
  }, [{ type: 'session-switch', sessionId: target.id }]];
}

/**
 * Kernel flipped the active session without TEA initiating (a tab-list sync
 * resolved a different activeId): snapshot the live viewport/chrome into the
 * outgoing tab and restore the incoming tab's cache — the same swap
 * adoptActiveTab performs. Without this, the incoming tab's live entries would
 * append onto the outgoing tab's transcript (overlay) and the outgoing tab's
 * live state would never be snapshotted (data loss).
 */
export function adoptAfterSync(model: RootModel, sessions: SessionTabsModel, prevActiveId: string): RootModel {
  const newActiveId = sessions.activeId;
  if (!newActiveId || newActiveId === prevActiveId) return { ...model, sessions };
  const target = sessions.tabs.find(t => t.id === newActiveId);
  if (!target) return { ...model, sessions };
  const snapped: SessionTab[] = sessions.tabs.map(t =>
    t.id === prevActiveId
      ? { ...t, entries: model.viewport.entries, thinking: model.viewport.thinking, answerStream: model.viewport.answerStream, lastActive: Date.now(),
        composer: sanitizeComposer(model.composer), diff: model.diff, tools: model.sidebar.tools, tokens: model.sidebar.tokens }
      : t);
  const restored = snapped.find(t => t.id === newActiveId)!;
  const chrome = restoreTabChrome(restored);
  const tabs = snapped.map(t => t.id === newActiveId ? { ...t, unread: 0 } : t);
  const withSessions = { ...model, sessions: { ...sessions, tabs } };
  return {
    ...withSessions,
    viewport: {
      ...model.viewport,
      entries: restored.entries || [],
      thinking: restored.busy ? (restored.thinking || '') : '',
      answerStream: restored.busy ? (restored.answerStream || '') : '',
      offset: 0,
      pinned: true,
    },
    composer: chrome.composer,
    diff: chrome.diff,
    sidebar: { ...model.sidebar, session: restored.title, tools: chrome.tools, tokens: chrome.tokens, model: tabDisplayModel(withSessions, restored) },
  };
}

/**
 * Lớp ngoài (lệnh slash /resume, /sessions open/new, /new-session, …) đổi active
 * session ở kernel: snapshot viewport vào tab cũ, restore cache tab mới.
 * Không phát Cmd (outer đã tự switch). Tab chưa có thì thêm mới (chờ hydrate).
 */
export function adoptActiveTab(model: RootModel, newActiveId: string): RootModel {
  if (!newActiveId || newActiveId === model.sessions.activeId) return model;
  let snap = snapshotActive(model);
  let target = snap.find(t => t.id === newActiveId);
  if (!target) {
    target = { id: newActiveId, title: shortTabTitle(newActiveId), lastActive: Date.now() };
    snap = [...snap, target];
  }
  const tabs = snap.map(t => t.id === newActiveId ? { ...t, unread: 0 } : t);
  const restored = tabs.find(t => t.id === newActiveId)!;
  const chrome = restoreTabChrome(restored);
  return {
    ...model,
    sessions: { ...model.sessions, tabs, activeId: newActiveId, pendingActiveId: undefined, selected: Math.max(0, tabs.findIndex(t => t.id === newActiveId)) },
    viewport: {
      ...model.viewport,
      entries: restored.entries || [],
      thinking: restored.busy ? (restored.thinking || '') : '',
      answerStream: restored.busy ? (restored.answerStream || '') : '',
      offset: 0,
      pinned: true,
    },
    composer: chrome.composer,
    diff: chrome.diff,
    sidebar: { ...model.sidebar, session: restored.title, tools: chrome.tools, tokens: chrome.tokens, model: tabDisplayModel(model, restored) },
  };
}

function createNewTab(model: RootModel): [RootModel, Cmd[]] {
  const tabs = snapshotActive(model);
  // Counter đơn điệu + random: chống trùng id khi double-click/spam trong cùng ms.
  // Kernel sẽ create đúng id này qua /new-session (đồng bộ epilogue), metadata confirm sau.
  newTabSeq = (newTabSeq + 1) % 46656;
  const id = `session-${Date.now().toString(36)}${newTabSeq.toString(36).padStart(3, '0')}${Math.floor(Math.random() * 36).toString(36)}`;
  // Tab mới tạo chắc chắn chưa có lịch sử → đánh dấu để × có thể xóa vĩnh viễn.
  const next: SessionTab[] = [...tabs, { id, title: shortTabTitle(id), historyKnown: true, lastActive: Date.now() }];
  return [{
    ...model,
    focus: 'composer' as const,
    sessions: { ...model.sessions, open: false, tabs: next, activeId: id, pendingActiveId: id, selected: next.length - 1 },
    viewport: { ...model.viewport, entries: [], thinking: '', answerStream: '', offset: 0, pinned: true },
    composer: createComposer(),
    diff: createDiffViewer(),
    // Tab mới chưa /model riêng → hiển thị default chung, không kế thừa model tab cũ.
    sidebar: { ...model.sidebar, session: shortTabTitle(id), tools: [], tokens: 0, model: model.sessions.defaultModel ?? model.sidebar.model },
  }, [{ type: 'session-new', sessionId: id }]];
}

/**
 * Tạm ẩn tab khỏi strip (transcript + task nền giữ nguyên, mở lại bằng modal).
 * Ẩn tab đang active thì chuyển sang tab hiển thị gần nhất. Không cho ẩn tab
 * hiển thị cuối cùng. `keepOpen` giữ modal mở để quản lý tiếp.
 */
function hideTab(model: RootModel, index: number, keepOpen = false): [RootModel, Cmd[]] {
  const state = model.sessions;
  const target = state.tabs[Math.min(Math.max(0, index), state.tabs.length - 1)];
  if (!target || target.hidden) return [model, []];
  const visible = state.tabs.filter(t => !t.hidden);
  if (visible.length <= 1) {
    return [{ ...model, status: { ...model.status, notice: 'Không thể ẩn tab cuối cùng — tạo tab mới (n) trước.' } }, []];
  }
  const tabs = snapshotActive(model).map(t => t.id === target.id ? { ...t, hidden: true } : t);
  const hidingActive = state.activeId === target.id;
  // Tab dự phòng: vị trí tab vừa ẩn trong strip (tab sau trượt lên, hoặc tab trước nếu ẩn tab cuối).
  const targetPos = Math.max(0, visible.findIndex(t => t.id === target.id));
  const visibleAfter = tabs.filter(t => !t.hidden);
  const fallback = visibleAfter[Math.min(targetPos, visibleAfter.length - 1)];
  const shown = { ...fallback, unread: 0 };
  const shownTabs = tabs.map(t => t.id === fallback.id ? shown : t);
  const chrome = restoreTabChrome(shown);
  return [{
    ...model,
    focus: keepOpen ? 'sessions' as const : 'composer' as const,
    sessions: { ...state, open: keepOpen ? state.open : false, tabs: shownTabs, activeId: hidingActive ? fallback.id : state.activeId, selected: Math.max(0, shownTabs.findIndex(t => t.id === (hidingActive ? fallback.id : state.tabs[state.selected]?.id))) },
    viewport: hidingActive ? { ...model.viewport, entries: shown.entries || [], thinking: shown.thinking || '', answerStream: shown.answerStream || '', offset: 0, pinned: true } : model.viewport,
    composer: hidingActive ? chrome.composer : model.composer,
    diff: hidingActive ? chrome.diff : model.diff,
    sidebar: hidingActive ? { ...model.sidebar, session: shown.title, tools: chrome.tools, tokens: chrome.tokens, model: tabDisplayModel(model, shown) } : model.sidebar,
    status: { ...model.status, notice: `Đã ẩn tab ${target.title} (vẫn chạy nền · Ctrl+T → h để hiện)` },
  }, hidingActive ? [{ type: 'session-switch', sessionId: fallback.id }] : []];
}

function toggleHideSelected(model: RootModel): [RootModel, Cmd[]] {
  const state = model.sessions;
  const target = state.tabs[Math.min(Math.max(0, state.selected), state.tabs.length - 1)];
  if (!target) return [model, []];
  if (target.hidden) {
    const tabs = state.tabs.map(t => t.id === target.id ? { ...t, hidden: false } : t);
    return [{ ...model, sessions: { ...state, tabs }, status: { ...model.status, notice: `Đã hiện tab ${target.title}` } }, []];
  }
  return hideTab(model, state.selected, true);
}

/**
 * Nút × (click) / phím x,d: tab đã biết chắc RỖNG (mới tạo hoặc hydrate 0 msgs)
 * → xóa vĩnh viễn khỏi tab model + phát session-delete để kernel xóa file.
 * Tab có nội dung (hoặc chưa rõ) → chỉ ẩn tạm như cũ để không mất lịch sử.
 */
function smartCloseTab(model: RootModel, index: number, keepOpen = false): [RootModel, Cmd[]] {
  const state = model.sessions;
  const target = state.tabs[Math.min(Math.max(0, index), state.tabs.length - 1)];
  if (!target) return [model, []];
  // Tab đang xem: viewport hiện tại mới là sự thật (cache có thể cũ).
  const liveEntries = target.id === state.activeId ? model.viewport.entries : target.entries;
  if (!target.historyKnown || (liveEntries?.length ?? 0) > 0) return hideTab(model, index, keepOpen);
  return deleteTab(model, index);
}

function deleteTab(model: RootModel, index: number): [RootModel, Cmd[]] {
  const state = model.sessions;
  const target = state.tabs[Math.min(Math.max(0, index), state.tabs.length - 1)];
  if (!target) return [model, []];
  const tabs = snapshotActive(model).filter(t => t.id !== target.id);
  if (!tabs.length) {
    return [{ ...model, status: { ...model.status, notice: 'Không thể xóa tab cuối cùng.' } }, []];
  }
  const deletingActive = state.activeId === target.id;
  const visible = tabs.filter(t => !t.hidden);
  const fallback = visible[Math.min(state.selected, Math.max(0, visible.length - 1))] || tabs[0];
  const cmds: Cmd[] = deletingActive && fallback.id !== target.id ? [{ type: 'session-switch', sessionId: fallback.id }] : [];
  cmds.push({ type: 'session-delete', sessionId: target.id });
  const pending = state.pendingActiveId === target.id ? undefined : deletingActive ? fallback.id : state.pendingActiveId;
  const shown = { ...fallback, unread: 0 };
  const shownTabs = tabs.map(t => t.id === fallback.id ? shown : t);
  const chrome = restoreTabChrome(shown);
  return [{
    ...model,
    focus: 'composer' as const,
    sessions: { ...state, open: false, tabs: shownTabs, activeId: deletingActive ? fallback.id : state.activeId, pendingActiveId: pending, selected: Math.max(0, shownTabs.findIndex(t => t.id === (deletingActive ? fallback.id : state.activeId))) },
    viewport: deletingActive ? { ...model.viewport, entries: shown.entries || [], thinking: shown.thinking || '', answerStream: shown.answerStream || '', offset: 0, pinned: true } : model.viewport,
    composer: deletingActive ? chrome.composer : model.composer,
    diff: deletingActive ? chrome.diff : model.diff,
    sidebar: deletingActive ? { ...model.sidebar, session: shown.title, tools: chrome.tools, tokens: chrome.tokens, model: tabDisplayModel(model, shown) } : model.sidebar,
    status: { ...model.status, notice: `Đã xóa tab ${target.title} (session rỗng)` },
  }, cmds];
}

/** Key routing cho session modal — ưu tiên sau question/permission/grill. */
export function sessionTabsKey(msg: KeyMsg, model: RootModel): [RootModel, Cmd[]] | undefined {
  const state = model.sessions;
  if (!state.open || model.focus !== 'sessions') return undefined;
  const count = state.tabs.length;
  switch (msg.key) {
    case 'escape':
      return [{ ...model, focus: 'composer' as const, sessions: { ...state, open: false } }, []];
    case 'up':
    case 'left':
      if (!count) return [model, []];
      return [{ ...model, sessions: { ...state, selected: (state.selected + count - 1) % count } }, []];
    case 'down':
    case 'right':
      if (!count) return [model, []];
      return [{ ...model, sessions: { ...state, selected: (state.selected + 1) % count } }, []];
    case 'enter': {
      if (!count) return [model, []];
      return switchToTab(model, state.selected);
    }
    default: {
      // Số hiển thị trong modal theo đúng thứ tự đã sort (awaiting lên trước):
      // map về index gốc trước khi switch, kẻo sang nhầm tab.
      const digit = msg.text && /^[1-9]$/.test(msg.text) ? Number(msg.text) - 1 : -1;
      const ordered = modalTabOrder(state);
      if (digit >= 0 && digit < ordered.length) return switchToTab(model, ordered[digit]);
      const letter = (msg.text || (msg.key.length === 1 ? msg.key : '')).toLowerCase();
      if (letter === 'n') return createNewTab(model);
      if (letter === 'x' || letter === 'd') return smartCloseTab(model, state.selected, true);
      if (letter === 'h') return toggleHideSelected(model);
      return [model, []];
    }
  }
}

/** Xếp tab đang chờ user input lên trước (OpenCode v2 UX). Stable: giữ thứ tự gốc giữa các tab cùng loại. */
export function sortAwaitingFirst<T extends { tab: SessionTab }>(state: SessionTabsModel, list: T[]): T[] {
  const rank = (tab: SessionTab) => (tab.awaitingInput || (state.activeQuestionSessionId && tab.id === state.activeQuestionSessionId) ? 0 : 1);
  return [...list].sort((a, b) => rank(a.tab) - rank(b.tab));
}

/** Index gốc của các tab hiển thị (bỏ hidden), theo đúng thứ tự strip (awaiting lên trước, tối đa 6). */
export function visibleTabOrder(state: SessionTabsModel): number[] {
  return sortAwaitingFirst(state, state.tabs.map((tab, index) => ({ tab, index })))
    .filter(({ tab }) => !tab.hidden)
    .map(({ index }) => index);
}

/** Index gốc theo đúng thứ tự modal (awaiting lên trước, gồm cả tab hidden) — dùng cho phím số. */
export function modalTabOrder(state: SessionTabsModel): number[] {
  return sortAwaitingFirst(state, state.tabs.map((tab, index) => ({ tab, index }))).map(({ index }) => index);
}

/** Segment plain (chưa tô màu) của tab-strip — nguồn duy nhất cho cả render lẫn hit-test click chuột. */
export interface StripSegment { text: string; tab: number; zone: 'tab' | 'close' | 'new' | 'none' }
const STRIP_SEP: StripSegment = { text: ' │ ', tab: -1, zone: 'none' };

export function sessionStripSegments(state: SessionTabsModel, width: number): StripSegment[] {
  // Ưu tiên: tab đang chờ user input (awaitingInput) được ghim lên đầu strip (OpenCode v2 UX)
  const visible = visibleTabOrder(state).slice(0, 6).map((index) => ({ tab: state.tabs[index], index }));
  const suffix: StripSegment[] = [{ text: '+ new', tab: -1, zone: 'new' }, { text: ' · Ctrl+T', tab: -1, zone: 'none' }];
  const hiddenCount = state.tabs.length - state.tabs.filter(t => !t.hidden).length;
  const overflow = state.tabs.filter(t => !t.hidden).length - visible.length;
  const segs: StripSegment[] = [];
  visible.forEach(({ tab, index }, i) => {
    const isAwaiting = Boolean(tab.awaitingInput || (state.activeQuestionSessionId && tab.id === state.activeQuestionSessionId));
    const dot = isAwaiting ? '⚡' : tab.busy ? '●' : tab.id === state.activeId ? '●' : '○';
    const marker = tab.id === state.activeId ? '▸ ' : '  ';
    const fresh = isAwaiting ? ' ?' : tab.unread ? ` +${tab.unread}` : '';
    segs.push({ text: `${dot} ${marker}${i + 1}:${tab.title}${fresh} `, tab: index, zone: 'tab' });
    segs.push({ text: '×', tab: index, zone: 'close' });
  });
  if (overflow > 0) segs.push({ text: `+${overflow}`, tab: -1, zone: 'none' });
  if (hiddenCount > 0) segs.push({ text: `~${hiddenCount} ẩn`, tab: -1, zone: 'none' });
  // Bỏ bớt tab cuối khi chật — luôn giữ suffix "+ new" bấm được.
  const plainWidth = (list: StripSegment[]) => list.reduce((sum, s) => sum + displayWidth(s.text), 0); // sep đã nằm sẵn trong list
  // Nút × dính liền tab của nó (không chèn │ ở giữa) để đọc rõ "tab ×" là một cụm.
  const withSep = (list: StripSegment[]) => list.flatMap((s, i) => i && !(list[i - 1].zone === 'tab' && s.zone === 'close') ? [STRIP_SEP, s] : [s]);
  let body = withSep([...segs, ...suffix]);
  for (;;) {
    if (body.length <= suffix.length || plainWidth(body) <= width) break;
    let dropAt = -1;
    for (let i = body.length - 1; i >= 0; i--) if (body[i].zone === 'close') { dropAt = i; break; }
    if (dropAt < 0) break;
    // Gỡ cặp "tab ×" cuối cùng separator đi kèm (trước nó, hoặc sau nó khi cặp đứng đầu).
    const hasSepBefore = dropAt - 2 >= 0 && body[dropAt - 2].zone === 'none';
    const hasSepAfter = Boolean(body[dropAt + 1]) && body[dropAt + 1].zone === 'none';
    body.splice(hasSepBefore ? dropAt - 2 : dropAt - 1, hasSepBefore || hasSepAfter ? 3 : 2);
  }
  return body;
}

/** Dải tab 1 dòng, render ngay trên viewport — active sáng, busy dot vàng, × để ẩn. */
export function sessionTabStripView(state: SessionTabsModel, width: number): string {
  const row = sessionStripSegments(state, width).map(seg => {
    if (seg.zone === 'tab') {
      const tab = state.tabs[seg.tab];
      const isActive = tab.id === state.activeId;
      const isAwaiting = Boolean(tab.awaitingInput || (state.activeQuestionSessionId && tab.id === state.activeQuestionSessionId));
      const dot = isAwaiting ? color(tokyoNight.purple, '⚡') : tab.busy ? color(tokyoNight.yellow, '●') : isActive ? color(tokyoNight.green, '●') : color(tokyoNight.muted, '○');
      const rest = seg.text.slice(2); // giữ marker "▸ "/"  " + label, chỉ tách dot ra tô màu
      return dot + ' ' + (isAwaiting ? color(tokyoNight.yellow, rest) : isActive ? color(tokyoNight.cyan, rest) : color(tokyoNight.muted, rest));
    }
    if (seg.zone === 'close') return color(tokyoNight.muted, '×');
    if (seg.zone === 'new') return color(tokyoNight.blue, seg.text);
    return color(seg.text.includes('│') ? tokyoNight.border : tokyoNight.muted, seg.text);
  }).join('');
  return fit(row, width);
}

/** Hit-test click chuột trên strip (x là cột SGR 1-based). */
export function sessionStripHit(state: SessionTabsModel, width: number, x: number): { tab: number; zone: 'tab' | 'close' | 'new' } | undefined {
  if (x < 1 || x > width) return undefined;
  let cell = 0;
  for (const seg of sessionStripSegments(state, width)) {
    const w = displayWidth(seg.text);
    if (x - 1 >= cell && x - 1 < cell + w) {
      return seg.zone === 'none' ? undefined : { tab: seg.tab, zone: seg.zone };
    }
    cell += w;
  }
  return undefined;
}

/** Click chuột trên strip: tab → switch, × → ẩn tạm, + new → tạo tab. */
export function sessionStripClick(model: RootModel, hit: { tab: number; zone: 'tab' | 'close' | 'new' }): [RootModel, Cmd[]] {
  const withPaletteClosed = (m: RootModel): RootModel =>
    m.focus === 'palette' ? { ...m, focus: 'composer' as const, palette: { ...m.palette, open: false } } : m;
  if (hit.zone === 'new') return createNewTab(withPaletteClosed(model));
  if (hit.zone === 'close') return smartCloseTab(withPaletteClosed(model), hit.tab, model.sessions.open);
  const target = model.sessions.tabs[hit.tab];
  if (!target) return [model, []];
  if (target.id === model.sessions.activeId) {
    const tabs = model.sessions.tabs.map(t => t.id === target.id ? { ...t, unread: 0 } : t);
    return [withPaletteClosed({ ...model, focus: 'composer' as const, sessions: { ...model.sessions, open: false, tabs } }), []];
  }
  return switchToTab(withPaletteClosed(model), hit.tab);
}

/** Modal quản lý session — panel giữa màn hình, cùng ngôn ngữ visual với grill. */
export function sessionTabsView(state: SessionTabsModel, width: number, height: number): string[] {
  const panelWidth = Math.max(24, Math.min(width - 4, 72));
  const lines: string[] = [];
  const parallel = state.tabs.filter(t => t.busy).length;
  const awaitingCount = state.tabs.filter(t => t.awaitingInput || (state.activeQuestionSessionId && t.id === state.activeQuestionSessionId)).length;
  lines.push(color(tokyoNight.purple, `SESSIONS · ${state.tabs.length} tab${state.tabs.length === 1 ? '' : 's'}${parallel ? ` · ${parallel} đang chạy` : ''}${awaitingCount ? ` · ${awaitingCount} chờ input` : ''}`) + color(tokyoNight.muted, ' · Esc đóng'));
  lines.push('');
  if (!state.tabs.length) {
    lines.push(...wrap(color(tokyoNight.muted, 'Chưa có session. Nhấn n để tạo tab mới.'), panelWidth));
  } else {
    // Sắp xếp hiển thị modal: ưu tiên tab awaitingInput lên đầu (OpenCode v2 UX)
    const indexedTabs = sortAwaitingFirst(state, state.tabs.map((tab, originalIndex) => ({ tab, originalIndex })));

    indexedTabs.forEach(({ tab, originalIndex }, displayIndex) => {
      const isSelected = originalIndex === state.selected;
      const marker = isSelected ? color(tokyoNight.cyan, '› ') : '  ';
      const isAwaiting = Boolean(tab.awaitingInput || (state.activeQuestionSessionId && tab.id === state.activeQuestionSessionId));
      const dot = isAwaiting ? color(tokyoNight.purple, '⚡') : tab.hidden ? color(tokyoNight.muted, '○ ') : tab.busy ? color(tokyoNight.yellow, '● ') : tab.id === state.activeId ? color(tokyoNight.green, '● ') : color(tokyoNight.muted, '○ ');
      const count = tab.entries?.length ?? 0;
      const title = tab.hidden ? color(tokyoNight.muted, `${tab.title} (ẩn)`) : isAwaiting ? color(tokyoNight.yellow, `${tab.title} [CHỜ INPUT]`) : color(tokyoNight.text, tab.title);
      const meta = color(tokyoNight.muted, `${tab.id}${count ? ` · ${count} msgs` : ''}${tab.id === state.activeId ? ' · active' : ''}${isAwaiting ? ' · awaiting input' : ''}${tab.busy ? ' · busy' : ''}${tab.hidden ? ' · ẩn khỏi strip' : ''}${tab.unread ? ` · ${tab.unread} chưa đọc` : ''}`) + color(tokyoNight.cyan, ` · ${tab.model ?? state.defaultModel ?? 'default'}`);
      lines.push(...wrap(`${marker}${color(tokyoNight.cyan, `${displayIndex + 1}.`)} ${dot} ${title}`, panelWidth));
      lines.push(...wrap(`    ${meta}`, panelWidth));
    });
  }
  lines.push('');
  lines.push(color(tokyoNight.muted, '↑↓ move · Enter switch · n new · x/d xóa tab rỗng · h ẩn-hiện · 1-9 · Esc'));
  const bodyHeight = Math.min(height - 4, lines.length + 2);
  return lipGlossTheme.panel.render(lines.slice(0, Math.max(1, bodyHeight)).join('\n'), panelWidth, bodyHeight).map((row) => fit(row, panelWidth));
}
