import type { RootModel } from '../types.js';
import { formatCompactionStatus } from '../../compaction-status.js';
import { color, displayWidth, fit, spinnerFrame, tokyoNight } from '../styles/theme.js';

export function headerView(model: RootModel): string {
  return fit(color(36, ` MINUS · ${model.mode}`) + ` · ${model.sidebar.model} · ${model.sidebar.workspace}`, model.width);
}

export interface StatuslineSegment {
  text: string;
  styled: string;
  kind: 'state' | 'tool' | 'step' | 'scroll' | 'subagent' | 'rest';
}

export function statuslineSegments(model: RootModel): StatuslineSegment[] {
  const status = model.status;
  const spinner = spinnerFrame(status.frame);
  const state = status.aborting ? (status.stoppingUntil ? 'Stopping…' : '') : status.busy ? `${spinner} ${status.phase || 'Working'}` : '';
  const isCompactionActive = status.compaction && (!status.compactionUntil || Date.now() < status.compactionUntil);
  const detail = isCompactionActive ? formatCompactionStatus(status.compaction!) : status.retry || (status.notice === 'Stopping…' ? '' : status.notice);
  const keys = model.leaderUntil
    ? 'Ctrl+X: C compact · E editor · Q quit · B sidebar · D diff · S sessions · ? help'
    : 'Tab mode · Ctrl+P commands · Ctrl+T sessions · Ctrl+X ? leader';
  const scrollHint = model.viewport.offset > 0 ? `↑ ${model.viewport.offset} new · PgDn to end` : '';
  const stopping = status.aborting && status.stoppingUntil;

  const segs: StatuslineSegment[] = [];
  if (state) segs.push({ text: state, styled: color(stopping ? tokyoNight.yellow : tokyoNight.cyan, state), kind: 'state' });
  if (model.sidebar.tools.length) {
    const [first, ...restTools] = model.sidebar.tools;
    const txt = `⚙ ${first}${restTools.length ? ` +${restTools.length}` : ''}`;
    segs.push({ text: txt, styled: color(tokyoNight.green, txt), kind: 'tool' });
  }
  if (status.busy && status.step > 0) {
    const txt = `Step ${status.step}${Number.isFinite(status.maxSteps) ? `/${status.maxSteps}` : ''}`;
    segs.push({ text: txt, styled: color(tokyoNight.muted, txt), kind: 'step' });
  }
  if (scrollHint) {
    segs.push({ text: scrollHint, styled: color(tokyoNight.yellow, scrollHint), kind: 'scroll' });
  }

  // Dynamic Subagent Indicator
  const subagentTabs = model.sessions.tabs.filter(t => t.subagent);
  const runningCount = subagentTabs.filter(t => t.busy).length;
  if (runningCount > 0) {
    const txt = runningCount > 1 ? `● Subagent working (${runningCount})` : '● Subagent working';
    segs.push({ text: txt, styled: color(tokyoNight.purple, txt), kind: 'subagent' });
  } else if (subagentTabs.length > 0) {
    const txt = '✓ Subagent (All done)';
    segs.push({ text: txt, styled: color(tokyoNight.green, txt), kind: 'subagent' });
  }

  const rest = scrollHint ? detail : (detail || keys);
  if (rest) {
    const clr = Boolean(status.retry) && rest === status.retry ? tokyoNight.yellow : tokyoNight.muted;
    segs.push({ text: rest, styled: color(clr, rest), kind: 'rest' });
  }

  return segs;
}

export function statuslineView(model: RootModel): string {
  const segs = statuslineSegments(model);
  const styled = segs.map(s => s.styled).join(color(tokyoNight.muted, ' · '));
  return fit(` ${styled}`, model.width);
}

export function statuslineSubagentHit(model: RootModel, x: number): boolean {
  if (x < 1 || x > model.width) return false;
  const segs = statuslineSegments(model);
  let cell = 1; // starts with leading space ' '
  const sepWidth = 3; // ' · '
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const w = displayWidth(s.text);
    if (s.kind === 'subagent') {
      if (x >= cell && x < cell + w) {
        return true;
      }
    }
    cell += w + sepWidth;
  }
  return false;
}
