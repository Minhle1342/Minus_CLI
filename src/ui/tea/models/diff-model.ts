import type { DiffViewerModel } from '../types.js';
import { color, fit, tokyoNight, wrap } from '../styles/theme.js';
export function createDiffViewer(): DiffViewerModel {
  return { visible: false, text: '', offset: 0, split: false, collapsed: [], hunk: 0 };
}
export function diffView(model: DiffViewerModel, width: number, height: number): string[] {
  let hunk = -1;
  const lines = model.text.split('\n').filter(line => { if (line.startsWith('@@')) { hunk++; return true; } return hunk < 0 || !model.collapsed.includes(hunk); });
  // P1: file headers (+++ / ---) read as metadata (cyan), not as added/removed content.
  const highlight = (line: string) => color(line.startsWith('+++') || line.startsWith('---') ? 36 : line.startsWith('+') ? 32 : line.startsWith('-') ? 31 : line.startsWith('@@') ? 36 : 37, line);
  let rows: string[];
  if (model.split && width >= 60) {
    // P1: visible gutter between panes instead of bare concatenation.
    const half = Math.floor((width - 1) / 2);
    const rightWidth = width - half - 1;
    const gutter = color(tokyoNight.border, '│');
    rows = lines.flatMap(line => {
      const left = wrap(highlight(line.startsWith('+') && !line.startsWith('+++') ? '' : line), half);
      const right = wrap(highlight(line.startsWith('-') && !line.startsWith('---') ? '' : line), rightWidth);
      const count = Math.max(left.length, right.length);
      return Array.from({ length: count }, (_, i) => fit(left[i] || '', half) + gutter + fit(right[i] || '', rightWidth));
    });
  } else rows = lines.flatMap(line => wrap(highlight(line), width));
  // P1: hunk position + change stats in the header.
  const hunkCount = model.text ? model.text.split('\n').filter(line => line.startsWith('@@')).length : 0;
  const added = model.text.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = model.text.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  const position = hunkCount ? `Hunk ${Math.min(model.hunk + 1, hunkCount)}/${hunkCount} · +${added} -${removed} · ` : '';
  rows = [color(36, `Diff · ${position}S split/unified · H collapse hunk · ←/→ hunk · Esc close`), ...rows];
  return Array.from({ length: height }, (_, i) => fit(rows[i + model.offset] || (i === 1 && !model.text ? 'No diff yet. Use /diff or inspect a tool change.' : ''), width));
}
