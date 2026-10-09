import { deleteBackward, deleteForward, deleteWordBackward, moveCursor, getNextGraphemeLength } from '../../input-line-editor.js';
import type { ComposerModel, KeyMsg, Msg } from '../types.js';
import { color, displayWidth, fit, paintInput, tokyoNight, wrap } from '../styles/theme.js';
export const INPUT_PLACEHOLDER = 'Work with Minus';
export function createComposer(): ComposerModel {
  return { value: '', cursorOffset: 0, history: [], historyIndex: -1, draft: '', completions: [], selected: 0, completionDismissed: false };
}
export function updateComposer(state: ComposerModel, msg: Msg): ComposerModel {
  if (msg.type !== 'key') return state;
  if (state.selection && state.selection.anchor !== state.selection.head) {
    const start = Math.min(state.selection.anchor, state.selection.head);
    const end = Math.max(state.selection.anchor, state.selection.head);
    if (['delete', 'backspace', 'text', 'paste', 'shift+enter', 'alt+enter', 'ctrl+j'].includes(msg.key) || (msg.text && !msg.key.startsWith('mouse+'))) {
      const removed = { ...state, value: state.value.slice(0, start) + state.value.slice(end), cursorOffset: start, selection: undefined,
        pastedBlocks: (state.pastedBlocks || []).flatMap(block => block.end <= start ? [block] : block.start >= end ? [{ ...block, start: block.start - (end - start), end: block.end - (end - start) }] : []), completions: [] };
      return ['delete', 'backspace'].includes(msg.key) ? removed : updateComposer(removed, msg);
    }
  }
  let edit = { value: state.value, cursorOffset: state.cursorOffset };
  const before = state.value.slice(0, state.cursorOffset);
  const after = state.value.slice(state.cursorOffset);
  switch (msg.key) {
    case 'text': case 'paste': case 'shift+enter': case 'alt+enter': case 'ctrl+j': {
      // P1: Ctrl+J is a newline fallback for terminals where Shift+Enter never arrives.
      const text = msg.key.includes('enter') || msg.key === 'ctrl+j' ? '\n' : (msg.text || '').replace(/\r\n?/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      edit = { value: before + text + after, cursorOffset: state.cursorOffset + text.length }; break;
    }
    case 'backspace': {
      const block = state.pastedBlocks?.find(block => block.end === edit.cursorOffset);
      edit = block ? { value: state.value.slice(0, block.start) + after, cursorOffset: block.start } : deleteBackward(edit); break;
    }
    case 'delete': {
      const block = state.pastedBlocks?.find(block => block.start === edit.cursorOffset);
      edit = block ? { value: before + state.value.slice(block.end), cursorOffset: block.start } : deleteForward(edit); break;
    }
    case 'ctrl+w': edit = deleteWordBackward(edit); break;
    case 'ctrl+u': { const start = before.lastIndexOf('\n') + 1; edit = { value: state.value.slice(0, start) + after, cursorOffset: start }; break; }
    case 'ctrl+k': { const end = after.indexOf('\n'); edit = { value: before + (end < 0 ? '' : after.slice(end)), cursorOffset: state.cursorOffset }; break; }
    case 'left': case 'right': {
      const block = state.pastedBlocks?.find(block => msg.key === 'left' ? block.end === edit.cursorOffset : block.start === edit.cursorOffset);
      edit = block ? { ...edit, cursorOffset: msg.key === 'left' ? block.start : block.end } : moveCursor(edit, msg.key); break;
    }
    case 'home': case 'ctrl+a': edit.cursorOffset = before.lastIndexOf('\n') + 1; break;
    case 'end': case 'ctrl+e': edit.cursorOffset += after.indexOf('\n') < 0 ? after.length : after.indexOf('\n'); break;
    case 'up': case 'down': {
      if (state.completions.length && !state.completionDismissed) return { ...state, selected: Math.max(0, Math.min(state.completions.length - 1, state.selected + (msg.key === 'up' ? -1 : 1))) };
      if (state.value.includes('\n')) {
        const start = before.lastIndexOf('\n') + 1;
        const column = state.cursorOffset - start;
        if (msg.key === 'up' && start > 0) { const previous = state.value.lastIndexOf('\n', start - 2) + 1; edit.cursorOffset = Math.min(start - 1, previous + column); }
        if (msg.key === 'down' && after.includes('\n')) { const next = state.cursorOffset + after.indexOf('\n') + 1; const end = state.value.indexOf('\n', next); edit.cursorOffset = Math.min(end < 0 ? state.value.length : end, next + column); }
        break;
      }
      const index = msg.key === 'up' ? Math.min(state.history.length - 1, state.historyIndex + 1) : Math.max(-1, state.historyIndex - 1);
      const draft = state.historyIndex === -1 ? state.value : state.draft;
      const value = index < 0 ? draft : state.history[state.history.length - 1 - index] || draft;
      return { ...state, draft, historyIndex: index, value, cursorOffset: value.length, pastedBlocks: [] };
    }
    case 'escape': return { ...state, completions: [], completionDismissed: true };
    default: if (msg.text) return updateComposer(state, { ...msg, key: 'text' } as KeyMsg); return state;
  }
  let pastedBlocks = state.pastedBlocks || [];
  if (edit.value !== state.value) {
    let start = 0;
    while (start < state.value.length && start < edit.value.length && state.value[start] === edit.value[start]) start++;
    let end = state.value.length;
    let nextEnd = edit.value.length;
    while (end > start && nextEnd > start && state.value[end - 1] === edit.value[nextEnd - 1]) { end--; nextEnd--; }
    const delta = edit.value.length - state.value.length;
    pastedBlocks = pastedBlocks.flatMap(block => block.end <= start ? [block] : block.start >= end ? [{ ...block, start: block.start + delta, end: block.end + delta }] : []);
    if (msg.key === 'paste') {
      const text = edit.value.slice(state.cursorOffset, edit.cursorOffset);
      if (text.split('\n').length > 2) pastedBlocks = [...pastedBlocks, { start: state.cursorOffset, end: edit.cursorOffset, text }].sort((a, b) => a.start - b.start);
    }
  }
  return { ...state, ...edit, pastedBlocks, selection: undefined, completions: [], selected: 0, completionDismissed: false };
}
/** Project pasted blocks into labels without changing the submitted value. */
export function composerDisplay(state: ComposerModel): { value: string; cursorOffset: number } {
  let value = '';
  let offset = 0;
  let cursorOffset = state.cursorOffset;
  for (const block of state.pastedBlocks || []) {
    if (block.start < offset || state.value.slice(block.start, block.end) !== block.text) continue;
    value += state.value.slice(offset, block.start);
    const label = `[Pasted ~${block.text.split('\n').length} lines]`;
    if (state.cursorOffset >= block.end) cursorOffset += label.length - (block.end - block.start);
    else if (state.cursorOffset > block.start) cursorOffset = value.length + label.length;
    value += label;
    offset = block.end;
  }
  return { value: value + state.value.slice(offset), cursorOffset };
}
export function composerView(state: ComposerModel, width: number, height: number): string[] {
  state = { ...state, ...composerDisplay(state) };
  const before = state.value.slice(0, state.cursorOffset);
  const length = getNextGraphemeLength(state.value.slice(state.cursorOffset));
  const cell = state.value.slice(state.cursorOffset, state.cursorOffset + length) || ' ';
  // P1: underline + cyan cursor cell — reverse-only blocks read as selection.
  const pastedLabel = (text: string) => color(tokyoNight.text, text).replace(/\[Pasted ~\d+ lines\]/g,
    label => '\x1b[48;2;224;175;104m' + color(tokyoNight.background, label) + '\x1b[0m' + '\x1b[38;2;192;202;245m');
  const cursorText = pastedLabel(before)
    + '[4m' + color(tokyoNight.cyan, cell)
    + pastedLabel(state.value.slice(state.cursorOffset + length));
  const placeholder = state.value === '';
  const inputText = placeholder
    ? '\x1b[4m' + color(tokyoNight.cyan, INPUT_PLACEHOLDER.slice(0, 1)) + color(tokyoNight.muted, INPUT_PLACEHOLDER.slice(1))
    : cursorText;
  const lines = wrap(color(tokyoNight.blue, '› ') + inputText, width);
  const cursorRow = wrap('› ' + before, width).length - 1;
  const start = Math.max(0, cursorRow - height + 1);
  // Wrap-continuation marker: every visual row that continues on the next row ends with ¬.
  const rows = lines.slice(start, start + height).map((line, i) => {
    const continued = start + i < lines.length - 1;
    if (continued && width > 1) {
      const truncated = wrap(line, width - 1)[0] || '';
      return fit(truncated, width - 1) + color(tokyoNight.muted, '¬');
    }
    return fit(line, width);
  });
  // P1: multiline position indicator (cur/total) on the last visible row.
  if (lines.length > 1 && rows.length && width > 8) {
    const label = ` ${cursorRow + 1}/${lines.length}`;
    const budget = Math.max(0, width - displayWidth(label));
    const content = rows[rows.length - 1].replace(/\s+$/, '');
    const truncated = wrap(content, Math.max(1, budget))[0] || '';
    rows[rows.length - 1] = fit(truncated, budget) + color(tokyoNight.muted, label);
  }
  return rows.map(paintInput);
}
