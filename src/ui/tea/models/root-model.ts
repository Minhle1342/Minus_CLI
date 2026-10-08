import type { RootModel, Msg, Cmd, PaletteItem, Action } from '../types.js';
import { createComposer, updateComposer, composerView, composerDisplay } from './composer-model.js';
import { appendEntry, viewportView, viewportLines } from './viewport-model.js';
import { sidebarView } from './sidebar-model.js';
import { paletteItems, paletteView } from './palette-model.js';
import { diffView } from './diff-model.js';
import { headerView, statuslineView } from './statusline-model.js';
import { toolCallEntry, toolResultEntry } from './tool-entry.js';
import { selectionKey, selectionRows, type SelectionLayout } from './selection.js';
import { fit, wrap, joinHorizontal, joinVertical, paintCanvas, color, tokyoNight } from '../styles/theme.js';

const defaultCommands: PaletteItem[] = [
  { id: '/help', label: 'Help', description: 'Show commands' },
  ...(['compact', 'editor', 'quit', 'sidebar', 'diff', 'mode', 'clear'] as const).map(action => ({ id: action, label: action, description: 'Session action', action })),
];

/** Shared layout budget: keeps view() and the mouse-scroll math in sync. */
function isCompactHeight(height: number): boolean { return height < 24; }
function composerCap(height: number): number { return isCompactHeight(height) ? 3 : 5; }
function hintCap(height: number): number { return isCompactHeight(height) ? 2 : 4; }
/** P0: narrow terminals get a slimmer side-by-side panel instead of losing context entirely. */
export function sidebarWidthFor(width: number, visible: boolean, height: number): number {
  if (!visible || height < 12) return 0;
  if (width >= 80) return Math.min(32, Math.floor(width / 3));
  if (width < 40) return 0;
  return Math.min(24, Math.floor(width / 2));
}
function composerHeightFor(height: number, width: number, value: string): number {
  return Math.min(composerCap(height), Math.max(1, Math.floor((height - 2) / 3)), wrap('› ' + value, width).length);
}
export function createRootModel(options: { width?: number; height?: number; commands?: PaletteItem[] } = {}): RootModel {
  return { width: Math.max(1, options.width ?? 80), height: Math.max(1, options.height ?? 24), mode: 'IMPLEMENT', focus: 'composer', leaderUntil: 0,
    composer: createComposer(), viewport: { entries: [], thinking: '', answerStream: '', offset: 0, pinned: true, collapsed: false },
    sidebar: { visible: false, workspace: '', model: '', session: '', sessions: [], tools: [], files: [], invariants: [], tokens: 0, maxTokens: 128000 },
    palette: { open: false, query: '', selected: 0, items: options.commands || defaultCommands }, diff: { visible: false, text: '', offset: 0, split: false, collapsed: [], hunk: 0 },
    status: { busy: false, aborting: false, step: 0, maxSteps: Infinity, phase: '', retry: '', notice: '', compaction: null, frame: 0 }, question: { active: false, prompt: '', selected: 0 } };
}
export function init(options?: Parameters<typeof createRootModel>[0]): [RootModel, Cmd[]] { return [createRootModel(options), []]; }
function action(model: RootModel, actionName: Action): [RootModel, Cmd[]] {
  switch (actionName) {
    case 'sidebar': return [{ ...model, sidebar: { ...model.sidebar, visible: !model.sidebar.visible } }, []];
    case 'diff': return [{ ...model, diff: { ...model.diff, visible: !model.diff.visible }, focus: model.diff.visible ? 'composer' : 'diff' }, []];
    case 'palette': return [{ ...model, palette: { ...model.palette, open: true, query: '', selected: 0 }, focus: 'palette' }, []];
    case 'mode': { if (model.status.busy) return [{ ...model, status: { ...model.status, notice: 'Switch mode after the current task finishes.' } }, []]; const mode = model.mode === 'IMPLEMENT' ? 'PLAN' : 'IMPLEMENT'; return [{ ...model, mode }, [{ type: 'mode', mode }]]; }
    case 'clear': return [{ ...model, viewport: { ...model.viewport, entries: [], thinking: '', answerStream: '', offset: 0 } }, []];
    case 'compact': case 'editor': return model.status.busy ? [{ ...model, status: { ...model.status, notice: 'Wait for the current task to finish.' } }, []] : [model, [{ type: actionName }]];
    case 'quit': return [model, [{ type: 'quit' }]];
  }
}
function archiveThinking(model: RootModel): RootModel {
  if (!model.viewport.thinking) return model;
  return { ...model, viewport: { ...appendEntry(model.viewport, { kind: 'thought', text: model.viewport.thinking }), thinking: '' } };
}
function reduce(msg: Msg, model: RootModel): [RootModel, Cmd[]] {
  if (['compose', 'question', 'action', 'diff'].includes(msg.type)) model = { ...model, selection: undefined, composer: { ...model.composer, selection: undefined } };
  const log = (text: string, kind: 'log' | 'tool' | 'step' | 'answer' = 'log'): [RootModel, Cmd[]] => [{ ...model, viewport: appendEntry(model.viewport, { kind, text }) }, []];
  switch (msg.type) {
    case 'resize': return [{ ...model, selection: undefined, composer: { ...model.composer, selection: undefined }, width: Math.max(1, msg.width), height: Math.max(1, msg.height) }, []];
    case 'tick': return [{ ...model, leaderUntil: msg.now >= model.leaderUntil ? 0 : model.leaderUntil, status: { ...model.status, frame: model.status.frame + 1,
      ...(model.status.noticeUntil && msg.now >= model.status.noticeUntil ? { notice: '', noticeUntil: undefined } : {}),
      ...(model.status.stoppingUntil && msg.now >= model.status.stoppingUntil ? { stoppingUntil: undefined } : {}),
    } }, []];
    case 'action': return action(model, msg.action);
    case 'log': return msg.text.trim() ? log(msg.text) : [model, []];
    case 'notice': return [{ ...model, status: { ...model.status, notice: msg.text } }, []];
    case 'busy': return [{ ...model, status: { ...model.status, busy: msg.busy, aborting: msg.busy ? model.status.aborting : false, retry: '', notice: msg.busy ? '' : model.status.aborting ? 'Task cancelled' : model.status.notice } }, []];
    case 'compose': return [{ ...model, composer: { ...model.composer, value: msg.text, cursorOffset: msg.text.length } }, []];
    case 'completions': return [{ ...model, composer: { ...model.composer, completions: msg.values, selected: 0 } }, []];
    case 'diff': return [{ ...model, diff: { ...model.diff, text: msg.text, visible: msg.reveal ?? model.diff.visible, offset: 0, collapsed: [], hunk: 0 } }, []];
    case 'metadata': return [{ ...model, sidebar: { ...model.sidebar, ...msg.data } }, []];
    case 'compaction': return [{ ...model, status: { ...model.status, compaction: msg.status } }, []];
    case 'question': return [{ ...model, viewport: msg.active ? { ...appendEntry(model.viewport, { kind: msg.permission ? 'permission' : 'log', text: msg.prompt, permission: msg.permission }), offset: 0, pinned: true } : model.viewport, focus: 'composer', palette: { ...model.palette, open: false }, composer: msg.active ? createComposer() : model.question.draft || createComposer(), question: msg.active ? { active: true, prompt: msg.prompt, draft: model.composer, permission: msg.permission, selected: 0 } : { active: false, prompt: '', selected: 0 } }, []];
    case 'kernel': {
      switch (msg.event) {
        case 'model:thought': return model.status.aborting ? [model, []] : [{ ...model, viewport: { ...model.viewport, thinking: model.viewport.thinking + msg.args[0] }, status: { ...model.status, retry: '' } }, []];
        case 'model:token': return model.status.aborting ? [model, []] : [{ ...model, viewport: { ...model.viewport, answerStream: model.viewport.answerStream + msg.args[0] } }, []];
        case 'model:final_answer': { const next = archiveThinking(model); return [{ ...next, viewport: { ...appendEntry(next.viewport, { kind: 'answer', text: msg.args[0] }), answerStream: '' }, status: { ...next.status, retry: '' } }, []]; }
        case 'model:thinking:start': return [{ ...archiveThinking(model), status: { ...model.status, phase: 'Thinking' } }, []];
        case 'model:thinking:end': return [archiveThinking(model), []];
        case 'step:before': return [{ ...archiveThinking(model), status: { ...model.status, step: msg.args[0], maxSteps: msg.args[1], phase: msg.args[2] || 'Working' } }, []];
        case 'step:after': return [model, []];
        case 'tool:before': return [{ ...model, sidebar: { ...model.sidebar, tools: [...model.sidebar.tools, msg.args[0]] }, viewport: appendEntry(model.viewport, { kind: 'tool', text: toolCallEntry(msg.args[0], msg.args[1]) }) }, []];
        case 'tool:after': {
          const [name, result, duration, args] = msg.args;
          const target = args?.path || args?.filePath || args?.targetFile;
          const diff = result.diff || result.patch;
          return [{ ...model, sidebar: { ...model.sidebar, tools: model.sidebar.tools.filter(t => t !== name), files: target && /write|replace|edit|patch/.test(name) ? [...new Set([...model.sidebar.files, String(target)])] : model.sidebar.files },
            diff: typeof diff === 'string' ? { ...model.diff, text: diff } : model.diff,
            viewport: appendEntry(model.viewport, { kind: 'tool', text: toolResultEntry(name, result, duration) }) }, []];
        }
        case 'tool:error': return log(`✖ ${msg.args[0]}: ${String(msg.args[1]?.message || msg.args[1])}`, 'tool');
        case 'model:usage': return [{ ...model, sidebar: { ...model.sidebar, tokens: msg.args[0].promptTokens || msg.args[0].totalTokens || 0 } }, []];
        case 'model:retry': { const retry = msg.args[0]; return [{ ...model, status: { ...model.status, retry: retry ? `Retry ${retry.attempt}/${retry.maxRetries} in ${Math.ceil(retry.delayMs / 1000)}s · ${retry.message || ''}` : '' } }, []]; }
        case 'workspace:changed': return [{ ...model, sidebar: { ...model.sidebar, workspace: msg.args[1] } }, []];
        case 'model:changed': return [{ ...model, sidebar: { ...model.sidebar, model: msg.args[0] } }, []];
        case 'agent:abort': case 'abort': return [{ ...model, status: { ...model.status, aborting: model.status.busy } }, []];
        case 'agent:status': case 'agent/status': {
          const record = msg.args[0];
          if (!['root', 'main', 'primary', 'interactive-agent', 'coding-agent'].includes(record.id)) return [model, []];
          if (['idle', 'stopped', 'error'].includes(record.status)) return [{ ...model, status: { ...model.status, aborting: false, phase: record.status } }, []];
          return [model, []];
        }
        case 'kernel:disposed': return [model, [{ type: 'quit' }]];
        case 'kernel:init': case 'plugin:registered': case 'router:decision': case 'gate:exploration_sufficiency': case 'gate:reproduction_advisory': case 'model:request_telemetry': case 'tools:batch': case 'model:steered': return [model, []];
      }
    }
    case 'key': {
      const selected = selectionKey(msg, model, selectionLayout(model));
      if (selected) return selected;
      if (model.selection && !msg.key.startsWith('mouse+')) model = { ...model, selection: undefined };
      if (msg.key === 'mouse+up' || msg.key === 'mouse+down') {
        model = { ...model, selection: undefined, composer: { ...model.composer, selection: undefined } };
        if (model.height <= 2 || model.focus === 'palette') return [model, []];
        const composerHeight = composerHeightFor(model.height, model.width, composerDisplay(model.composer).value);
        const completionCount = model.composer.completionDismissed ? 0 : Math.min(4, model.composer.completions.length);
        const hintCount = Math.min(hintCap(model.height), completionCount, Math.max(0, model.height - composerHeight - 4));
        const questionCount = questionView(model, composerHeight).length;
        const bodyHeight = Math.max(0, model.height - 2 - composerHeight - hintCount - questionCount);
        const sidebarWidth = sidebarWidthFor(model.width, model.sidebar.visible, model.height);
        const mainWidth = model.width - sidebarWidth;
        const delta = msg.key === 'mouse+up' ? 3 : -3;
        if (model.diff.visible) {
          const maxOffset = Math.max(0, model.diff.text.split('\n').length + 1 - bodyHeight);
          const offset = Math.max(0, Math.min(maxOffset, model.diff.offset + delta));
          return offset === model.diff.offset ? [model, []] : [{ ...model, diff: { ...model.diff, offset } }, []];
        }
        const maxOffset = Math.max(0, viewportLines(model.viewport, mainWidth).length - bodyHeight);
        const offset = Math.max(0, Math.min(maxOffset, model.viewport.offset + delta));
        return offset === model.viewport.offset ? [model, []] : [{ ...model, viewport: { ...model.viewport, offset, pinned: offset === 0 } }, []];
      }
      if (model.question.active) {
        if (msg.key === 'ctrl+x') return [{ ...model, leaderUntil: msg.now + 1200 }, []];
        if (model.leaderUntil > msg.now) {
          const next = { ...model, leaderUntil: 0 };
          if (msg.key === 'd' || msg.key === 'b') return action(next, msg.key === 'd' ? 'diff' : 'sidebar');
          if (msg.key === '?') return [{ ...next, focus: 'palette' as const, palette: { ...next.palette, open: true, query: '', selected: 0 } }, []];
          return [next, []];
        }
        if (msg.key === 'pageup' || msg.key === 'pagedown') {
          if (model.diff.visible) return [{ ...model, diff: { ...model.diff, offset: Math.max(0, model.diff.offset + (msg.key === 'pageup' ? -10 : 10)) } }, []];
          const [next, commands] = reduce(msg, { ...model, question: { ...model.question, active: false } });
          return [{ ...next, question: model.question }, commands];
        }
        if (msg.key === 'enter') {
          // Permission: confirm the highlighted option (↑↓ navigated). Values match
          // the downstream mapping in src/index.ts (y → approve, a → approve_all_session, else reject).
          if (model.question.permission) {
            const sel = Math.min(model.question.selected, PERMISSION_OPTIONS.length - 1);
            return [model, [{ type: 'answer', text: PERMISSION_OPTIONS[sel].value }]];
          }
          return [model, [{ type: 'answer', text: model.composer.value }]];
        }
        if (['escape', 'ctrl+c'].includes(msg.key)) return [model, [{ type: 'answer', text: '\x03' }]];
        if (model.question.permission) {
          const sel = Math.min(model.question.selected, PERMISSION_OPTIONS.length - 1);
          if (msg.key === 'up' || msg.key === 'left') return [{ ...model, question: { ...model.question, selected: (sel + PERMISSION_OPTIONS.length - 1) % PERMISSION_OPTIONS.length } }, []];
          if (msg.key === 'down' || msg.key === 'right') return [{ ...model, question: { ...model.question, selected: (sel + 1) % PERMISSION_OPTIONS.length } }, []];
          // Letter shortcuts jump the highlight without confirming; Enter confirms.
          const letter = (msg.text || (msg.key.length === 1 ? msg.key : '')).toLowerCase();
          const jump = PERMISSION_OPTIONS.findIndex(opt => opt.key === letter);
          if (jump >= 0) return [{ ...model, question: { ...model.question, selected: jump } }, []];
          return [model, []];
        }
        return [{ ...model, composer: updateComposer(model.composer, msg) }, []];
      }
      if (msg.key === 'ctrl+c' || (msg.key === 'escape' && model.status.busy && model.focus === 'composer')) {
        if (model.status.aborting) return [model, []];
        if (!model.status.busy) return action(model, 'quit');
        return [{ ...model, status: { ...model.status, aborting: true, notice: 'Stopping…' } }, [{ type: 'abort' }]];
      }
      if (model.focus === 'palette') {
        if (msg.key === 'escape') return [{ ...model, focus: 'composer', palette: { ...model.palette, open: false } }, []];
        const items = paletteItems(model.palette);
        if (msg.key === 'enter') {
          // P1: empty result keeps the palette open so the query survives refinement.
          if (!items.length) return [model, []];
          const item = items[Math.min(model.palette.selected, items.length - 1)];
          const next = { ...model, focus: 'composer' as const, palette: { ...model.palette, open: false } };
          return item.action ? action(next, item.action) : [next, [{ type: 'submit', text: item.id }]];
        }
        // P1: selection wraps around the list edges.
        if (msg.key === 'up' || msg.key === 'down') {
          if (!items.length) return [model, []];
          const selected = (model.palette.selected + (msg.key === 'up' ? -1 : 1) + items.length) % items.length;
          return [{ ...model, palette: { ...model.palette, selected } }, []];
        }
        const query = msg.key === 'backspace' ? Array.from(model.palette.query).slice(0, -1).join('') : model.palette.query + (msg.text || '');
        return [{ ...model, palette: { ...model.palette, query, selected: 0 } }, []];
      }
      if (msg.key === 'ctrl+x') return [{ ...model, leaderUntil: msg.now + 1200 }, []];
      if (model.leaderUntil > msg.now) {
        const routes: Record<string, Action> = { c: 'compact', e: 'editor', q: 'quit', b: 'sidebar', d: 'diff' };
        const next = { ...model, leaderUntil: 0 };
        if (msg.key === '?') return action(next, 'palette');
        return routes[msg.key.toLowerCase()] ? action(next, routes[msg.key.toLowerCase()]) : [next, []];
      }
      if (msg.key === 'ctrl+p') return action(model, 'palette');
      if (msg.key === 'tab') return action(model, 'mode');
      if (msg.key === 'ctrl+o') return [{ ...model, viewport: { ...model.viewport, collapsed: !model.viewport.collapsed } }, []];
      if (model.focus === 'diff') {
        if (msg.key === 'escape') return [{ ...model, focus: 'composer', diff: { ...model.diff, visible: false } }, []];
        if (msg.key === 's') return [{ ...model, diff: { ...model.diff, split: !model.diff.split } }, []];
        if (msg.key === 'h') return [{ ...model, diff: { ...model.diff, collapsed: model.diff.collapsed.includes(model.diff.hunk) ? model.diff.collapsed.filter(h => h !== model.diff.hunk) : [...model.diff.collapsed, model.diff.hunk] } }, []];
        if (msg.key === 'left' || msg.key === 'right') return [{ ...model, diff: { ...model.diff, hunk: Math.max(0, model.diff.hunk + (msg.key === 'left' ? -1 : 1)) } }, []];
        if (['up', 'down', 'pageup', 'pagedown'].includes(msg.key)) return [{ ...model, diff: { ...model.diff, offset: Math.max(0, model.diff.offset + (msg.key.endsWith('up') ? -1 : 1) * (msg.key.startsWith('page') ? 10 : 1)) } }, []];
        return [model, []];
      }
      if (msg.key === 'pageup' || msg.key === 'pagedown') {
        const mainWidth = Math.max(1, model.width - sidebarWidthFor(model.width, model.sidebar.visible, model.height));
        const maxOffset = Math.max(0, viewportLines(model.viewport, mainWidth).length - Math.max(1, model.height - 6));
        const delta = (msg.key.endsWith('up') ? 1 : -1) * Math.max(1, model.height - 6);
        const offset = Math.max(0, Math.min(maxOffset, model.viewport.offset + delta));
        return [{ ...model, viewport: { ...model.viewport, offset, pinned: offset === 0 } }, []];
      }
      if (msg.key === 'ctrl+space' && model.composer.completions.length) {
        const item = model.composer.completions[model.composer.selected];
        return [{ ...model, composer: { ...model.composer, value: item.value, cursorOffset: item.cursor ?? item.value.length, completions: [] } }, []];
      }
      if ((msg.key === ' ' || (msg.key === 'text' && msg.text === ' ')) && !model.composer.completionDismissed && !model.composer.selection) {
        const selected = model.composer.completionDismissed ? undefined : model.composer.completions[model.composer.selected];
        if (selected) {
          const cursor = selected.cursor ?? selected.value.length;
          const suffix = selected.value.slice(cursor);
          const separator = suffix.startsWith(' ') ? '' : ' ';
          return [{ ...model, composer: { ...model.composer, value: selected.value.slice(0, cursor) + separator + suffix,
            cursorOffset: cursor + 1, completions: [], selected: 0, completionDismissed: true } }, []];
        }
      }
      if (msg.key === 'enter') {
        const session = model.composer.completionDismissed ? undefined : model.composer.completions[model.composer.selected];
        const text = session?.kind === 'session' ? session.value.trim() : model.composer.value.trim();
        if (!text) return [model, []];
        const composer = { ...createComposer(), history: [...model.composer.history.slice(-199), text] };
        return [{ ...model, composer, viewport: { ...appendEntry(model.viewport, { kind: 'user', text }), offset: 0, pinned: true } }, [{ type: 'submit', text }]];
      }
      const composer = updateComposer(model.composer, msg);
      const commands: Cmd[] = composer.value !== model.composer.value || composer.cursorOffset !== model.composer.cursorOffset ? [{ type: 'complete', value: composer.value, cursor: composer.cursorOffset }] : [];
      return [{ ...model, composer }, commands];
    }
  }
}
export function update(msg: Msg, model: RootModel): [RootModel, Cmd[]] {
  let [next, commands] = reduce(msg, model);
  const now = msg.type === 'tick' || msg.type === 'key' ? msg.now : Date.now();
  if (next.status.notice !== model.status.notice || msg.type === 'notice') {
    next = { ...next, status: { ...next.status, noticeUntil: next.status.notice ? now + 3000 : undefined } };
  }
  if (next.status.aborting !== model.status.aborting) {
    next = { ...next, status: { ...next.status, stoppingUntil: next.status.aborting ? now + 3000 : undefined } };
  }
  if (!model.viewport.pinned && next.viewport !== model.viewport && next.viewport.offset === model.viewport.offset) {
    const width = model.width - sidebarWidthFor(model.width, model.sidebar.visible, model.height);
    const addedLines = viewportLines(next.viewport, width).length - viewportLines(model.viewport, width).length;
    return [{ ...next, viewport: { ...next.viewport, offset: Math.max(0, next.viewport.offset + addedLines) } }, commands];
  }
  return [next, commands];
}
/** Permission answer options. Values match the downstream mapping in src/index.ts. */
export const PERMISSION_OPTIONS = [
  { value: 'y', key: 'y', label: 'Allow once', tone: tokyoNight.green },
  { value: 'a', key: 'a', label: 'Allow for session', tone: tokyoNight.blue },
  { value: 'n', key: 'n', label: 'Reject', tone: tokyoNight.red },
];
function questionView(model: RootModel, composerHeight: number): string[] {
  if (!model.question.active) return [];
  if (model.question.permission) {
    const sel = Math.min(model.question.selected, PERMISSION_OPTIONS.length - 1);
    const rows = PERMISSION_OPTIONS.flatMap((opt, i) => {
      const marker = i === sel ? color(tokyoNight.cyan, '› ') : '  ';
      return wrap(marker + color(opt.tone, `[${opt.key}] ${opt.label}`), model.width);
    });
    rows.push(...wrap(color(tokyoNight.muted, '↑↓ move · Enter confirm · Wheel scroll · Ctrl+X D diff · Esc cancel'), model.width));
    // P0 budget kept: permission block gets up to 8 rows so options + footer are never sliced.
    const available = model.height - composerHeight - 3;
    if (available <= 0) return rows.slice(0, 1);
    return rows.slice(0, Math.max(2, Math.min(8, available)));
  }
  const rows = wrap(model.question.prompt + '\nPgUp/PgDn review · Ctrl+X D diff', model.width);
  const available = model.height - composerHeight - 3;
  if (available <= 0) return rows.slice(0, 1);
  return rows.slice(-Math.max(1, Math.min(4, available)));
}

function selectionLayout(model: RootModel): SelectionLayout {
  const composerHeight = composerHeightFor(model.height, model.width, composerDisplay(model.composer).value);
  const hintLimit = Math.min(hintCap(model.height), Math.max(0, model.height - composerHeight - 4));
  const hintCount = model.composer.completionDismissed ? 0 : Math.min(hintLimit, model.composer.completions.length);
  const questionCount = questionView(model, composerHeight).length;
  const bodyHeight = Math.max(0, model.height - 2 - composerHeight - hintCount - questionCount);
  return { composerHeight, bodyHeight, composerTop: model.height - composerHeight, mainWidth: model.width - sidebarWidthFor(model.width, model.sidebar.visible, model.height) };
}

export function view(model: RootModel): string {
  const { width, height } = model;
  if (height <= 2) return Array.from({ length: height }, (_, i) => paintCanvas(fit(i === 0 ? 'MINUS ' + model.mode : model.composer.value, width))).join('\n');
  // P0: compact budget on short terminals — cap composer at 3 and hints at 2
  // so bodyHeight cannot collapse to 0 when question + hints are active.
  const composerHeight = composerHeightFor(height, width, composerDisplay(model.composer).value);
  const hintLimit = Math.min(hintCap(height), Math.max(0, height - composerHeight - 4));
  const hintStart = Math.max(0, model.composer.selected - hintLimit + 1);
  const hints = model.composer.completionDismissed ? [] : model.composer.completions
    .slice(hintStart, hintStart + hintLimit)
    .map((item, index) => fit(`${model.composer.selected === hintStart + index ? '›' : ' '} ${item.label} · ${item.kind === 'session' ? 'Enter resume' : 'Space complete'}`, width));
  const questionRows = questionView(model, composerHeight);
  const bodyHeight = Math.max(0, height - 2 - composerHeight - hints.length - questionRows.length);
  const sidebarWidth = sidebarWidthFor(width, model.sidebar.visible, height);
  const mainWidth = width - sidebarWidth;
  const selectedViewport = model.selection?.target === 'viewport' ? model.selection : undefined;
  const main = model.focus === 'palette' ? paletteView(model.palette, mainWidth, bodyHeight) : model.diff.visible ? diffView(model.diff, mainWidth, bodyHeight) : viewportView(selectedViewport ? { ...model.viewport, offset: selectedViewport.viewportOffset ?? model.viewport.offset } : model.viewport, mainWidth, bodyHeight, selectedViewport?.sourceLines);
  const body = sidebarWidth ? joinHorizontal(main, sidebarView(model.sidebar, sidebarWidth, bodyHeight), mainWidth, sidebarWidth) : main;
  const displayedComposer = model.selection?.target === 'composer' ? { ...model.composer, cursorOffset: model.selection.composerCursor ?? model.composer.cursorOffset } : model.composer;
  const rows = selectionRows(model, joinVertical([headerView(model)], body, questionRows, hints, composerView(displayedComposer, width, composerHeight), [statuslineView(model)]), selectionLayout(model));
  return Array.from({ length: height }, (_, i) => paintCanvas(fit(rows[i] || '', width))).join('\n');
}
