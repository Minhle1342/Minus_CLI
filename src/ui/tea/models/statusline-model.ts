import type { RootModel } from '../types.js';
import { formatCompactionStatus } from '../../compaction-status.js';
import { color, fit } from '../styles/theme.js';
export function headerView(model: RootModel): string {
  return fit(color(36, ` MINUS · ${model.mode}`) + ` · ${model.sidebar.model} · ${model.sidebar.workspace}`, model.width);
}
export function statuslineView(model: RootModel): string {
  const status = model.status;
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][status.frame % 10];
  const state = status.aborting ? 'Stopping…' : status.busy ? `${spinner} ${status.phase || 'Working'}` : 'Ready';
  const detail = status.compaction ? formatCompactionStatus(status.compaction) : status.retry || status.notice;
  return fit(color(status.aborting ? 33 : 90, ` ${state} · ${status.step}/${Number.isFinite(status.maxSteps) ? status.maxSteps : '∞'} · ${detail || (model.leaderUntil ? 'Ctrl+X: C compact · E editor · Q quit · B sidebar · D diff' : 'Tab mode · Ctrl+P commands · Ctrl+X leader')}`), model.width);
}
