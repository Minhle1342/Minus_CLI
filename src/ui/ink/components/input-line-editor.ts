/**
 * Pure helper functions for Text Input line editing and cursor management
 * Provides readline-compliant cursor movement, deletion, and insertion.
 */

export interface LineEditorState {
  value: string;
  cursorOffset: number;
}

/**
 * Sanitize input text, normalizing newlines and tabs for single-line TUI prompt
 */
export function sanitizeInput(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\t/g, '  ');
}

/**
 * Insert text at the current cursor offset
 */
export function insertText(state: LineEditorState, rawText: string): LineEditorState {
  const sanitized = sanitizeInput(rawText);
  if (!sanitized) return state;

  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  const before = state.value.slice(0, offset);
  const after = state.value.slice(offset);

  return {
    value: before + sanitized + after,
    cursorOffset: offset + sanitized.length,
  };
}

/**
 * Delete one character backward (Backspace)
 */
export function deleteBackward(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  if (offset <= 0) return state;

  const before = state.value.slice(0, offset - 1);
  const after = state.value.slice(offset);

  return {
    value: before + after,
    cursorOffset: offset - 1,
  };
}

/**
 * Delete one character forward (Delete key)
 */
export function deleteForward(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  if (offset >= state.value.length) return state;

  const before = state.value.slice(0, offset);
  const after = state.value.slice(offset + 1);

  return {
    value: before + after,
    cursorOffset: offset,
  };
}

/**
 * Delete word backward (Ctrl+W)
 */
export function deleteWordBackward(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  if (offset <= 0) return state;

  const textBefore = state.value.slice(0, offset);
  // Match trailing whitespaces then non-whitespaces, or just whitespaces
  const match = textBefore.match(/(\S+|\s+)\s*$/);
  const deleteCount = match ? match[0].length : 1;
  const newOffset = Math.max(0, offset - deleteCount);

  const before = state.value.slice(0, newOffset);
  const after = state.value.slice(offset);

  return {
    value: before + after,
    cursorOffset: newOffset,
  };
}

/**
 * Delete from cursor to beginning of line (Ctrl+U)
 */
export function deleteToStart(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  return {
    value: state.value.slice(offset),
    cursorOffset: 0,
  };
}

/**
 * Delete from cursor to end of line (Ctrl+K)
 */
export function deleteToEnd(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  return {
    value: state.value.slice(0, offset),
    cursorOffset: offset,
  };
}

/**
 * Move cursor with boundary protections
 */
export function moveCursor(
  state: LineEditorState,
  direction: 'left' | 'right' | 'home' | 'end' | 'wordLeft' | 'wordRight'
): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);

  switch (direction) {
    case 'left':
      return { ...state, cursorOffset: Math.max(0, offset - 1) };
    case 'right':
      return { ...state, cursorOffset: Math.min(state.value.length, offset + 1) };
    case 'home':
      return { ...state, cursorOffset: 0 };
    case 'end':
      return { ...state, cursorOffset: state.value.length };
    case 'wordLeft': {
      const textBefore = state.value.slice(0, offset);
      const match = textBefore.match(/(\S+|\s+)\s*$/);
      const jump = match ? match[0].length : 1;
      return { ...state, cursorOffset: Math.max(0, offset - jump) };
    }
    case 'wordRight': {
      const textAfter = state.value.slice(offset);
      const match = textAfter.match(/^\s*(\S+|\s+)/);
      const jump = match ? match[0].length : 1;
      return { ...state, cursorOffset: Math.min(state.value.length, offset + jump) };
    }
  }
}
