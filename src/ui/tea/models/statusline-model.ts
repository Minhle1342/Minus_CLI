import type { RootModel } from '../types.js';
import { formatCompactionStatus } from '../../compaction-status.js';
import { color, fit, spinnerFrame, tokyoNight } from '../styles/theme.js';
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
    ? 'Ctrl+X: C compact · E editor · Q quit · B sidebar · D diff · S sessions · ? help'
    : 'Tab mode · Ctrl+P commands · Ctrl+T sessions · Ctrl+X ? leader';
  // P1: unpinned transcript surfaces a scroll-back hint instead of silently hiding new output.
  const scrollHint = model.viewport.offset > 0 ? `↑ ${model.viewport.offset} new · PgDn to end` : '';
  // Tokyo Night: trạng thái working cyan, stopping vàng, hint cuộn vàng, còn lại muted (giữ nguyên plain-text).
  const stopping = status.aborting && status.stoppingUntil;
  const segs: string[] = [];
  if (state) segs.push(color(stopping ? tokyoNight.yellow : tokyoNight.cyan, state));
  // Tool đang chạy ở tab đang xem + tiến độ step (dữ liệu đã có sẵn trong model).
  if (model.sidebar.tools.length) {
    const [first, ...restTools] = model.sidebar.tools;
    segs.push(color(tokyoNight.green, `⚙ ${first}${restTools.length ? ` +${restTools.length}` : ''}`));
  }
  if (status.busy && status.step > 0) {
    segs.push(color(tokyoNight.muted, `Step ${status.step}${Number.isFinite(status.maxSteps) ? `/${status.maxSteps}` : ''}`));
  }
  if (scrollHint) segs.push(color(tokyoNight.yellow, scrollHint));
  const rest = scrollHint ? detail : (detail || keys);
  if (rest) segs.push(color(Boolean(status.retry) && rest === status.retry ? tokyoNight.yellow : tokyoNight.muted, rest));
  return fit(` ${segs.join(color(tokyoNight.muted, ' · '))}`, model.width);
}
