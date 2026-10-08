import type { SidebarModel } from '../types.js';
import { lipGlossTheme, fit } from '../styles/theme.js';
export function sidebarView(model: SidebarModel, width: number, height: number): string[] {
  const rows = ['SESSION', model.session || 'New session', ...model.sessions.slice(0, 6), '', 'CONTEXT', `${model.tokens.toLocaleString()} / ${model.maxTokens.toLocaleString()} tokens`, '', 'ACTIVE TOOLS', ...model.tools, '', 'MODIFIED FILES', ...model.files, '', 'MEMORY', ...model.invariants];
  const panel = lipGlossTheme.panel.render(rows.join('\n'), width, height);
  return Array.from({ length: height }, (_, i) => fit(panel[i] || '', width));
}
