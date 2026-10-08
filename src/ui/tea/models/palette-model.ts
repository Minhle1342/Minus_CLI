import type { PaletteItem, PaletteModel } from '../types.js';
import { color, fit, lipGlossTheme, tokyoNight } from '../styles/theme.js';
export function fuzzyScore(query: string, value: string): number {
  let cursor = 0, score = 0;
  for (const char of query.toLowerCase()) {
    const index = value.toLowerCase().indexOf(char, cursor);
    if (index < 0) return Infinity;
    score += index - cursor; cursor = index + 1;
  }
  return score;
}
/** P1: bold the subsequence characters that matched the query; plain fallback when the hit came from label/description. */
export function highlightMatch(value: string, query: string): string {
  if (!query) return value;
  const q = query.toLowerCase();
  let qi = 0;
  let out = '';
  for (const ch of value) {
    if (qi < q.length && ch.toLowerCase() === q[qi]) { out += '[1m' + ch + '[0m'; qi++; }
    else out += ch;
  }
  return qi === q.length ? out : value;
}
export function paletteItems(model: PaletteModel): PaletteItem[] {
  return model.items.map(item => ({ item, score: Math.min(fuzzyScore(model.query, item.id), fuzzyScore(model.query, item.label + ' ' + item.description)) }))
    .filter(row => Number.isFinite(row.score)).sort((a, b) => a.score - b.score).map(row => row.item);
}
export function paletteView(model: PaletteModel, width: number, height: number): string[] {
  const items = paletteItems(model);
  const start = Math.max(0, model.selected - Math.max(0, height - 5));
  const rows = items.slice(start, start + Math.max(0, height - 4)).map((item, i) => {
    // P1: matched-id highlight + description so rows scan faster than id-only text.
    const id = highlightMatch(item.id, model.query);
    const desc = item.description ? color(tokyoNight.muted, ` · ${item.description}`) : '';
    return `${start + i === model.selected ? '›' : ' '} ${id}  ${item.label}${desc}`;
  });
  const header = `Command palette · ${items.length} match${items.length === 1 ? '' : 'es'} · Esc close`;
  const footer = items.length ? 'Enter to run' : `No match for "${model.query}" — keep typing or Esc`;
  return lipGlossTheme.panel.render([header, '> ' + model.query, ...rows, footer].join('\n'), width, height).map(row => fit(row, width));
}
