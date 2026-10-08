import type { RootModel } from '../types.js';
import { formatCompactionStatus } from '../../compaction-status.js';
import { color, fit, spinnerFrame } from '../styles/theme.js';
export function headerView(model: RootModel): string {
  return fit(color(36, ` MINUS · ${model.mode}`) + ` · ${model.sidebar.model} · ${model.sidebar.workspace}`, model.width);
}
export function statuslineView(model: RootModel): string {
  const status = model.status;
  const spinner = spinnerFrame(status.frame);
  const state = status.aborting ? (status.stoppingUntil ? 'Stopping…' : '') : status.busy ? `${spinner} ${status.phase || 'Working'}` : '';
  const isCompactionActive = status.compaction && (!status.compactionUntil || Date.now() < status.compactionUntil);
  const detail = isCompactionActive ? formatCompactionStatus(status.compaction!) : status.retry || (status.notice === 'Stopping…' ? '' : status.notice);
  // P0: leader is always discoverable — idle shows `Ctrl+X ?`, active lists keys incl. `? help`.
  const keys = model.leaderUntil
    ? 'Ctrl+X: C compact · E editor · Q quit · B sidebar · D diff · ? help'
    : 'Tab mode · Ctrl+P commands · Ctrl+X ? leader';
  // P1: unpinned transcript surfaces a scroll-back hint instead of silently hiding new output.
  const scrollHint = model.viewport.offset > 0 ? `↑ ${model.viewport.offset} new · PgDn to end` : '';
  const tail = scrollHint ? (detail ? `${scrollHint} · ${detail}` : scrollHint) : (detail || keys);
  return fit(color(status.aborting && status.stoppingUntil ? 33 : 90, ` ${state ? `${state} · ` : ''}${tail}`), model.width);
}
