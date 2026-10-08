import type { ViewportModel, TranscriptEntry } from '../types.js';
import { color, fit, stripTerminalControls, tokyoNight, wrap } from '../styles/theme.js';
import { formatMarkdownTablesWithTea } from '../styles/table.js';
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
  return stripTerminalControls(text).split('\n').map((line, index) => {
    if (index === 0) return color(line.startsWith('✖') ? tokyoNight.red : tokyoNight.cyan, line);
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
  }).join('\n');
}

/** Render prose delimiters as color; quoted strings inside code remain literal. */
function formatAnswerInline(body: string, base: string, depth = 0): string {
  if (depth > 8) return color(base, body);
  const tokens = /(?<!\\)(\*\*[^\n]+?\*\*|__[^\n]+?__|`[^`\n]+`|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])|\[[^\]\n]+\]\([^)\n]+\))/gu;
  let styled = '';
  let offset = 0;
  for (const match of body.matchAll(tokens)) {
    const at = match.index ?? 0;
    styled += color(base, body.slice(offset, at));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      styled += formatAnswerInline(token.slice(2, -2), tokyoNight.yellow, depth + 1);
    } else if (token.startsWith('`') || token.startsWith("'")) {
      styled += color(tokyoNight.green, token.slice(1, -1));
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      styled += formatAnswerInline(link[1], tokyoNight.blue, depth + 1)
        + color(tokyoNight.muted, ` (${link[2]})`);
    }
    offset = at + token.length;
  }
  return styled + color(base, body.slice(offset));
}

function formatAnswer(text: string, width = 80): string {
  const tableProcessed = formatMarkdownTablesWithTea(text, Math.max(20, width - 4));
  const lines = stripTerminalControls(tableProcessed).split('\n');
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
        return formatAnswerInline(cell, tokyoNight.text);
      }).join(color(tokyoNight.border, '│'))];
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    if (heading) {
      firstContentLine = false;
      return [formatAnswerInline(heading[1], tokyoNight.purple)];
    }

    const bullet = /^(\s*(?:[-*•]|\d+\.))(\s+)/.exec(line);
    const marker = bullet ? color(tokyoNight.blue, bullet[1]) + bullet[2] : '';
    const body = bullet ? line.slice(bullet[0].length) : line;
    const base = firstContentLine ? tokyoNight.cyan : tokyoNight.text;
    if (line.trim()) firstContentLine = false;
    return [marker + formatAnswerInline(body, base)];
  }).join('\n');
}

function permissionLines(request: PermissionCard, width: number): string[] {
  const risk = request.riskLevel.toUpperCase();
  const riskColor = /HIGH|CRITICAL/.test(risk) ? tokyoNight.red : risk === 'MEDIUM' ? tokyoNight.yellow : tokyoNight.green;
  const fields = [
    color(tokyoNight.purple, 'Permission request') + '  ' + color(riskColor, `[${risk}]`),
    color(tokyoNight.muted, 'Tool     ') + color(tokyoNight.cyan, stripTerminalControls(request.toolName)),
    color(tokyoNight.muted, 'Category ') + color(tokyoNight.text, stripTerminalControls(request.category).replace(/_/g, ' ')),
    color(tokyoNight.muted, 'Target   ') + color(tokyoNight.blue, stripTerminalControls(request.target)),
    ...(request.summary ? ['', color(tokyoNight.text, stripTerminalControls(request.summary))] : []),
    ...(request.suggestedTool ? [color(tokyoNight.yellow, 'Suggested tool: ') + color(tokyoNight.cyan, stripTerminalControls(request.suggestedTool))] : []),
  ];
  if (width < 6) return fields.flatMap(line => wrap(line, width));
  const innerWidth = width - 4;
  const edge = (text: string) => color(tokyoNight.border, text);
  return [edge('╭' + '─'.repeat(width - 2) + '╮'),
    ...fields.flatMap(line => wrap(line, innerWidth)).map(line => edge('│') + ' ' + fit(line, innerWidth) + ' ' + edge('│')),
    edge('╰' + '─'.repeat(width - 2) + '╯')];
}

export function viewportLines(model: ViewportModel, width: number): string[] {
  const lines = model.entries.flatMap(entry => {
    let widths = cachedLines.get(entry);
    if (!widths) { widths = new Map(); cachedLines.set(entry, widths); }
    let rendered = widths.get(width);
    if (!rendered) {
      const prefix = entry.kind === 'user' ? 'You › ' : entry.kind === 'answer' ? 'Minus › ' : entry.kind === 'thought' ? 'Thinking › ' : '';
      const prefixColor = entry.kind === 'user' ? tokyoNight.blue : entry.kind === 'answer' ? tokyoNight.purple : tokyoNight.muted;
      const textColor = entry.kind === 'thought' ? tokyoNight.muted : entry.kind === 'tool' ? tokyoNight.cyan : entry.kind === 'step' ? tokyoNight.yellow : tokyoNight.text;
      const body = entry.kind === 'answer' ? formatAnswer(entry.text, width)
        : entry.kind === 'tool' ? formatTool(entry.text)
        : color(textColor, stripTerminalControls(entry.text));
      rendered = entry.kind === 'permission' && entry.permission
        ? permissionLines(entry.permission, width)
        : wrap(color(prefixColor, prefix) + body, width);
      widths.set(width, rendered);
    }
    if (model.collapsed && ['thought', 'tool', 'step'].includes(entry.kind)) {
      if (rendered.length <= 1) return rendered;
      const label = entry.kind === 'thought' ? 'Thinking' : entry.kind === 'tool' ? 'Tool' : 'Step';
      const labelColor = entry.kind === 'thought' ? tokyoNight.muted : entry.kind === 'tool' ? tokyoNight.cyan : tokyoNight.yellow;
      const badge = color(tokyoNight.purple, '▸ ') + color(labelColor, label)
        + color(tokyoNight.muted, ` · ${rendered.length - 1} lines hidden · `);
      const summary = stripTerminalControls(entry.text).split('\n')[0].trim();
      const summaryColor = summary.startsWith('✖') ? tokyoNight.red : entry.kind === 'thought' ? tokyoNight.muted : tokyoNight.text;
      return wrap(badge + color(summaryColor, summary), width).slice(0, 1);
    }
    return [...rendered, ''];
  });
  if (model.thinking) lines.push(...wrap(color(tokyoNight.muted, '… Thinking › ' + stripTerminalControls(model.thinking)), width));
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
