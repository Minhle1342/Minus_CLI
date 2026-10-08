import type { PaletteItem, PaletteModel } from '../types.js';
import { fit, lipGlossTheme } from '../styles/theme.js';
export function fuzzyScore(query: string, value: string): number {
  let cursor = 0, score = 0;
  for (const char of query.toLowerCase()) {
    const index = value.toLowerCase().indexOf(char, cursor);
    if (index < 0) return Infinity;
    score += index - cursor; cursor = index + 1;
  }
  return score;
}
export function paletteItems(model: PaletteModel): PaletteItem[] {
  return model.items.map(item => ({ item, score: Math.min(fuzzyScore(model.query, item.id), fuzzyScore(model.query, item.label + ' ' + item.description)) }))
    .filter(row => Number.isFinite(row.score)).sort((a, b) => a.score - b.score).map(row => row.item);
}
export function paletteView(model: PaletteModel, width: number, height: number): string[] {
  const items = paletteItems(model);
  const start = Math.max(0, model.selected - Math.max(0, height - 5));
  const rows = items.slice(start, start + Math.max(0, height - 4)).map((item, i) => `${start + i === model.selected ? '›' : ' '} ${item.id}  ${item.label}`);
  return lipGlossTheme.panel.render(['Command palette · Esc to close', '> ' + model.query, ...rows, items.length ? 'Enter to run' : 'No matching commands'].join('\n'), width, height).map(row => fit(row, width));
}
