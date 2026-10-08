import type { DiffViewerModel } from '../types.js';
import { color, fit, wrap, joinHorizontal } from '../styles/theme.js';
export function diffView(model: DiffViewerModel, width: number, height: number): string[] {
  let hunk = -1;
  const lines = model.text.split('\n').filter(line => { if (line.startsWith('@@')) { hunk++; return true; } return hunk < 0 || !model.collapsed.includes(hunk); });
  const highlight = (line: string) => color(line.startsWith('+') ? 32 : line.startsWith('-') ? 31 : line.startsWith('@@') ? 36 : 37, line);
  let rows: string[];
  if (model.split && width >= 60) {
    const half = Math.floor(width / 2);
    rows = lines.flatMap(line => {
      const left = wrap(highlight(line.startsWith('+') && !line.startsWith('+++') ? '' : line), half);
      const right = wrap(highlight(line.startsWith('-') && !line.startsWith('---') ? '' : line), width - half);
      return joinHorizontal(left, right, half, width - half);
    });
  } else rows = lines.flatMap(line => wrap(highlight(line), width));
  rows = [color(36, 'Diff · S split/unified · H collapse hunk · ←/→ hunk · Esc close'), ...rows];
  return Array.from({ length: height }, (_, i) => fit(rows[i + model.offset] || (i === 1 && !model.text ? 'No diff yet. Use /diff or inspect a tool change.' : ''), width));
}
