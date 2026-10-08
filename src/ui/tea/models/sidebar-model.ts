import type { SidebarModel } from '../types.js';
import { lipGlossTheme, fit, color, tokyoNight } from '../styles/theme.js';
export function sidebarView(model: SidebarModel, width: number, height: number): string[] {
  // P0: surface context pressure — percent + warning tone at 80%/90%.
  const ratio = model.maxTokens > 0 ? model.tokens / model.maxTokens : 0;
  const pct = `${Math.round(ratio * 100)}%`;
  const pctTone = ratio >= 0.9 ? tokyoNight.red : ratio >= 0.8 ? tokyoNight.yellow : tokyoNight.text;
  const contextLine = `${color(pctTone, pct)} · ${model.tokens.toLocaleString()} / ${model.maxTokens.toLocaleString()} tokens`;
  const rows = ['SESSION', model.session || 'New session', ...model.sessions.slice(0, 6), '', 'CONTEXT', contextLine, '', `ACTIVE TOOLS${model.tools.length ? ` (${model.tools.length})` : ''}`, ...model.tools, '', `MODIFIED FILES${model.files.length ? ` (${model.files.length})` : ''}`, ...model.files, '', 'MEMORY', ...model.invariants];
  const panel = lipGlossTheme.panel.render(rows.join('\n'), width, height);
  return Array.from({ length: height }, (_, i) => fit(panel[i] || '', width));
}
