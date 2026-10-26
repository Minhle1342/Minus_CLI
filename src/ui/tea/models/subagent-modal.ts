import type { Cmd, KeyMsg, RootModel, SubagentsModalModel } from '../types.js';
import { color, fit, lipGlossTheme, tokyoNight, wrap } from '../styles/theme.js';
import { switchToTab } from './viewport-model.js';

export function createSubagentsModal(): SubagentsModalModel {
  return { open: false, selected: 0 };
}

export function subagentsModalView(model: RootModel, width: number, height: number): string[] {
  const panelWidth = Math.max(28, Math.min(width - 4, 76));
  const subagentTabs = model.sessions.tabs.filter(t => t.subagent);
  const activeCount = subagentTabs.filter(t => t.busy).length;
  const lines: string[] = [];

  const title = `SUBAGENTS · ${subagentTabs.length} agent${subagentTabs.length === 1 ? '' : 's'}${activeCount ? ` · ${activeCount} running` : ' · all completed'}`;
  lines.push(color(tokyoNight.purple, title) + color(tokyoNight.muted, ' · Esc to close'));
  lines.push('');

  if (!subagentTabs.length) {
    lines.push(...wrap(color(tokyoNight.muted, 'No subagents spawned yet.'), panelWidth));
  } else {
    subagentTabs.forEach((tab, index) => {
      const isSelected = index === model.subagents.selected;
      const marker = isSelected ? color(tokyoNight.cyan, '› ') : '  ';
      const dot = tab.busy ? color(tokyoNight.yellow, '● ') : color(tokyoNight.green, '✓ ');
      const titleText = isSelected ? color(tokyoNight.cyan, tab.title) : color(tokyoNight.text, tab.title);
      const msgCount = tab.entries?.length ?? 0;
      const meta = color(tokyoNight.muted, `${tab.id}${msgCount ? ` · ${msgCount} entries` : ''}${tab.busy ? ' · running' : ' · finished'}`);

      lines.push(...wrap(`${marker}${dot}${titleText}`, panelWidth));
      lines.push(...wrap(`    ${meta}`, panelWidth));
    });
  }

  lines.push('');
  lines.push(color(tokyoNight.muted, '↑↓ move · Enter view transcript · Esc close'));

  const bodyHeight = Math.min(height - 4, lines.length + 2);
  return lipGlossTheme.panel.render(lines.slice(0, Math.max(1, bodyHeight)).join('\n'), panelWidth, bodyHeight).map(row => fit(row, panelWidth));
}

export function subagentsModalKey(msg: KeyMsg, model: RootModel): [RootModel, Cmd[]] | undefined {
  if (!model.subagents?.open || model.focus !== 'subagents') return undefined;
  const subagents = model.sessions.tabs.filter(t => t.subagent);
  const count = subagents.length;

  switch (msg.key) {
    case 'escape':
      return [{ ...model, focus: 'composer' as const, subagents: { ...model.subagents, open: false } }, []];
    case 'up':
    case 'left':
      if (!count) return [model, []];
      return [{ ...model, subagents: { ...model.subagents, selected: (model.subagents.selected + count - 1) % count } }, []];
    case 'down':
    case 'right':
      if (!count) return [model, []];
      return [{ ...model, subagents: { ...model.subagents, selected: (model.subagents.selected + 1) % count } }, []];
    case 'enter': {
      if (!count) return [model, []];
      const targetSubagent = subagents[Math.min(model.subagents.selected, count - 1)];
      const targetIndex = model.sessions.tabs.findIndex(t => t.id === targetSubagent.id);
      if (targetIndex < 0) return [model, []];

      const prevActiveSessionId = !model.sessions.tabs.find(t => t.id === model.sessions.activeId)?.subagent
        ? model.sessions.activeId
        : model.previousActiveSessionId;

      const [nextModel, cmds] = switchToTab({ ...model, subagents: { ...model.subagents, open: false } }, targetIndex);
      return [{ ...nextModel, previousActiveSessionId: prevActiveSessionId ?? model.sessions.activeId }, cmds];
    }
    default:
      return [model, []];
  }
}
