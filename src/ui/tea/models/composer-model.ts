import { deleteBackward, deleteForward, deleteWordBackward, moveCursor, getNextGraphemeLength } from '../../input-line-editor.js';
import type { ComposerModel, KeyMsg, Msg } from '../types.js';
import { color, fit, tokyoNight, wrap } from '../styles/theme.js';
export function createComposer(): ComposerModel {
  return { value: '', cursorOffset: 0, history: [], historyIndex: -1, draft: '', completions: [], selected: 0, completionDismissed: false };
}
export function updateComposer(state: ComposerModel, msg: Msg): ComposerModel {
  if (msg.type !== 'key') return state;
  let edit = { value: state.value, cursorOffset: state.cursorOffset };
  const before = state.value.slice(0, state.cursorOffset);
  const after = state.value.slice(state.cursorOffset);
  switch (msg.key) {
    case 'text': case 'paste': case 'shift+enter': case 'alt+enter': {
      const text = msg.key.includes('enter') ? '\n' : (msg.text || '').replace(/\r\n?/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      edit = { value: before + text + after, cursorOffset: state.cursorOffset + text.length }; break;
    }
    case 'backspace': edit = deleteBackward(edit); break;
    case 'delete': edit = deleteForward(edit); break;
    case 'ctrl+w': edit = deleteWordBackward(edit); break;
    case 'ctrl+u': { const start = before.lastIndexOf('\n') + 1; edit = { value: state.value.slice(0, start) + after, cursorOffset: start }; break; }
    case 'ctrl+k': { const end = after.indexOf('\n'); edit = { value: before + (end < 0 ? '' : after.slice(end)), cursorOffset: state.cursorOffset }; break; }
    case 'left': case 'right': edit = moveCursor(edit, msg.key); break;
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
      return { ...state, draft, historyIndex: index, value, cursorOffset: value.length };
    }
    case 'escape': return { ...state, completions: [], completionDismissed: true };
    default: if (msg.text) return updateComposer(state, { ...msg, key: 'text' } as KeyMsg); return state;
  }
  return { ...state, ...edit, completions: [], selected: 0, completionDismissed: false };
}
export function composerView(state: ComposerModel, width: number, height: number): string[] {
  const before = state.value.slice(0, state.cursorOffset);
  const length = getNextGraphemeLength(state.value.slice(state.cursorOffset));
  const cursorText = color(tokyoNight.text, before)
    + color(7, state.value.slice(state.cursorOffset, state.cursorOffset + length) || ' ')
    + color(tokyoNight.text, state.value.slice(state.cursorOffset + length));
  const lines = wrap(color(tokyoNight.blue, '› ') + cursorText, width);
  const cursorRow = wrap('› ' + before, width).length - 1;
  const start = Math.max(0, cursorRow - height + 1);
  return lines.slice(start, start + height).map(line => fit(line, width));
}
