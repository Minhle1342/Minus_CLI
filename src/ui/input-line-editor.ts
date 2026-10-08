/**
 * Pure helper functions for Text Input line editing and cursor management
 * Provides readline-compliant cursor movement, deletion, and insertion.
 */

export interface LineEditorState {
  value: string;
  cursorOffset: number;
}

/**
 * Helper to get the grapheme cluster length at the end of a substring
 */
export function getPrevGraphemeLength(text: string): number {
  if (!text) return 0;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const segments = Array.from(segmenter.segment(text));
      if (segments.length > 0) {
        return segments[segments.length - 1].segment.length;
      }
    } catch {
      // Fallback below
    }
  }
  // Surrogate pair fallback
  const len = text.length;
  if (len >= 2) {
    const code = text.charCodeAt(len - 1);
    const prevCode = text.charCodeAt(len - 2);
    if (code >= 0xDC00 && code <= 0xDFFF && prevCode >= 0xD800 && prevCode <= 0xDBFF) {
      return 2;
    }
  }
  return 1;
}

/**
 * Helper to get the grapheme cluster length at the start of a substring
 */
export function getNextGraphemeLength(text: string): number {
  if (!text) return 0;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const segments = Array.from(segmenter.segment(text));
      if (segments.length > 0) {
        return segments[0].segment.length;
      }
    } catch {
      // Fallback below
    }
  }
  // Surrogate pair fallback
  if (text.length >= 2) {
    const code = text.charCodeAt(0);
    const nextCode = text.charCodeAt(1);
    if (code >= 0xD800 && code <= 0xDBFF && nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
      return 2;
    }
  }
  return 1;
}

/**
 * Sanitize input text, normalizing newlines and tabs for single-line TUI prompt,
 * stripping bracketed paste mode tokens, ANSI escape sequences, and non-printable control characters.
 */
export function sanitizeInput(text: string): string {
  return text
    // Strip bracketed paste mode tokens and ANSI escape sequences
    .replace(/\x1b\[(?:200~|201~|[0-9;]*[a-zA-Z~])/g, '')
    // Strip trailing carriage returns/newlines from paste payloads
    .replace(/[\r\n]+$/, '')
    // Replace remaining internal newlines with space for single-line prompt
    .replace(/[\r\n]+/g, ' ')
    // Expand tabs
    .replace(/\t/g, '  ')
    // Remove non-printable control characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
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
 * Delete one character/grapheme backward (Backspace)
 */
export function deleteBackward(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  if (offset <= 0) return state;

  const before = state.value.slice(0, offset);
  const after = state.value.slice(offset);
  const deleteCount = getPrevGraphemeLength(before);
  const newOffset = Math.max(0, offset - deleteCount);

  return {
    value: state.value.slice(0, newOffset) + after,
    cursorOffset: newOffset,
  };
}

/**
 * Delete one character/grapheme forward (Delete key)
 */
export function deleteForward(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  if (offset >= state.value.length) return state;

  const before = state.value.slice(0, offset);
  const after = state.value.slice(offset);
  const deleteCount = getNextGraphemeLength(after);

  return {
    value: before + after.slice(deleteCount),
    cursorOffset: offset,
  };
}

/**
 * Delete word backward (Ctrl+W) recognizing words, punctuation, and paths
 */
export function deleteWordBackward(state: LineEditorState): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);
  if (offset <= 0) return state;

  const textBefore = state.value.slice(0, offset);
  // Match trailing whitespaces or word characters (letters/numbers/underscores) or punctuation symbols
  const match = textBefore.match(/(\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)\s*$/u);
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
 * Move cursor with boundary protections and granular word boundary support
 */
export function moveCursor(
  state: LineEditorState,
  direction: 'left' | 'right' | 'home' | 'end' | 'wordLeft' | 'wordRight'
): LineEditorState {
  const offset = Math.min(Math.max(0, state.cursorOffset), state.value.length);

  switch (direction) {
    case 'left': {
      const before = state.value.slice(0, offset);
      const jump = getPrevGraphemeLength(before);
      return { ...state, cursorOffset: Math.max(0, offset - jump) };
    }
    case 'right': {
      const after = state.value.slice(offset);
      const jump = getNextGraphemeLength(after);
      return { ...state, cursorOffset: Math.min(state.value.length, offset + jump) };
    }
    case 'home':
      return { ...state, cursorOffset: 0 };
    case 'end':
      return { ...state, cursorOffset: state.value.length };
    case 'wordLeft': {
      const textBefore = state.value.slice(0, offset);
      const match = textBefore.match(/(\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)\s*$/u);
      const jump = match ? match[0].length : 1;
      return { ...state, cursorOffset: Math.max(0, offset - jump) };
    }
    case 'wordRight': {
      const textAfter = state.value.slice(offset);
      const match = textAfter.match(/^\s*(\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)/u);
      const jump = match ? match[0].length : 1;
      return { ...state, cursorOffset: Math.min(state.value.length, offset + jump) };
    }
  }
}
