import type { DiffViewerModel } from '../types.js';
import { color, fit, tokyoNight, wrap } from '../styles/theme.js';
export function createDiffViewer(): DiffViewerModel {
  return { visible: false, text: '', offset: 0, split: false, collapsed: [], hunk: 0 };
}
interface ParsedDiff { lines: string[]; hunkCount: number; added: number; removed: number }
let parsedText = '';
let parsed: ParsedDiff = { lines: [], hunkCount: 0, added: 0, removed: 0 };
/** Parse once per text: every frame used to re-split the whole diff three times. */
function parseDiff(text: string): ParsedDiff {
  if (text === parsedText) return parsed;
  const lines = text.split('\n');
  let hunkCount = 0, added = 0, removed = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) hunkCount++;
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  parsedText = text;
  parsed = { lines, hunkCount, added, removed };
  return parsed;
}
let visibleText = '';
let visibleCollapsed = '';
let visible: string[] = [];
/** Visible source lines (collapsed hunks removed) — cached so scrolling stays O(1). */
export function visibleDiffLines(model: DiffViewerModel): string[] {
  const collapsed = model.collapsed.join(',');
  if (model.text !== visibleText || collapsed !== visibleCollapsed) {
    let hunk = -1;
    visible = parseDiff(model.text).lines.filter(line => {
      if (line.startsWith('@@')) { hunk++; return true; }
      return hunk < 0 || !model.collapsed.includes(hunk);
    });
    visibleText = model.text;
    visibleCollapsed = collapsed;
  }
  return visible;
}
export function diffView(model: DiffViewerModel, width: number, height: number): string[] {
  if (height <= 0) return [];
  const { hunkCount, added, removed } = parseDiff(model.text);
  // P1: file headers (+++ / ---) read as metadata (cyan), not as added/removed content.
  const highlight = (line: string) => color(line.startsWith('+++') || line.startsWith('---') ? 36 : line.startsWith('+') ? 32 : line.startsWith('-') ? 31 : line.startsWith('@@') ? 36 : 37, line);
  const bodyHeight = height - 1;
  // Only the visible window is wrapped: wrapping the whole diff every frame was the hot spot.
  const window = visibleDiffLines(model).slice(model.offset, model.offset + bodyHeight);
  let rows: string[];
  if (model.split && width >= 60) {
    // P1: visible gutter between panes instead of bare concatenation.
    const half = Math.floor((width - 1) / 2);
    const rightWidth = width - half - 1;
    const gutter = color(tokyoNight.border, '│');
    rows = window.flatMap(line => {
      const left = wrap(highlight(line.startsWith('+') && !line.startsWith('+++') ? '' : line), half);
      const right = wrap(highlight(line.startsWith('-') && !line.startsWith('---') ? '' : line), rightWidth);
      const count = Math.max(left.length, right.length);
      return Array.from({ length: count }, (_, i) => fit(left[i] || '', half) + gutter + fit(right[i] || '', rightWidth));
    });
  } else rows = window.flatMap(line => wrap(highlight(line), width));
  // P1: hunk position + change stats in the header.
  const position = hunkCount ? `Hunk ${Math.min(model.hunk + 1, hunkCount)}/${hunkCount} · +${added} -${removed} · ` : '';
  const header = color(36, `Diff · ${position}S split/unified · H collapse hunk · ←/→ hunk · Esc close`);
  return Array.from({ length: height }, (_, i) => fit(i === 0 ? header : rows[i - 1] || (!model.text && i === 1 ? 'No diff yet. Use /diff or inspect a tool change.' : ''), width));
}
