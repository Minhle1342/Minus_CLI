import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  LineEditorState,
  sanitizeInput,
  insertText,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteToStart,
  deleteToEnd,
  moveCursor,
  getPrevGraphemeLength,
  getNextGraphemeLength,
} from './input-line-editor.js';

describe('Input Line Editor Unit Tests (Unicode, Word Boundaries, ANSI)', () => {
  describe('1. Unicode & Emoji Deletion & Movement', () => {
    it('deleteBackward: should delete multi-byte emoji cleanly without dangling surrogates', () => {
      const state: LineEditorState = { value: 'Hello 🚀 World', cursorOffset: 8 }; // Right after 🚀
      const next = deleteBackward(state);
      assert.strictEqual(next.value, 'Hello  World');
      assert.strictEqual(next.cursorOffset, 6);
      assert.strictEqual(next.value.includes('\uD83D'), false, 'Must not leave dangling high surrogate');
    });

    it('deleteForward: should delete multi-byte emoji in front of cursor', () => {
      const state: LineEditorState = { value: 'Hello 🚀 World', cursorOffset: 6 }; // Right before 🚀
      const next = deleteForward(state);
      assert.strictEqual(next.value, 'Hello  World');
      assert.strictEqual(next.cursorOffset, 6);
      assert.strictEqual(next.value.includes('\uDE80'), false, 'Must not leave dangling low surrogate');
    });

    it('moveCursor: left and right over emoji should jump entire grapheme', () => {
      const state: LineEditorState = { value: 'A🚀B', cursorOffset: 3 }; // Right after 🚀
      const left = moveCursor(state, 'left');
      assert.strictEqual(left.cursorOffset, 1, 'Should jump before 🚀');

      const right = moveCursor(left, 'right');
      assert.strictEqual(right.cursorOffset, 3, 'Should jump after 🚀');
    });

    it('getPrevGraphemeLength and getNextGraphemeLength: handle ASCII and Emoji correctly', () => {
      assert.strictEqual(getPrevGraphemeLength('abc'), 1);
      assert.strictEqual(getPrevGraphemeLength(''), 0);
      assert.strictEqual(getPrevGraphemeLength('🚀'), 2);
      assert.strictEqual(getNextGraphemeLength('🚀'), 2);
      assert.strictEqual(getNextGraphemeLength('abc'), 1);
      assert.strictEqual(getNextGraphemeLength(''), 0);
    });
  });

  describe('2. ANSI Escape Sequence Stripping & Sanitization', () => {
    it('sanitizeInput: should strip ANSI color codes', () => {
      const ansi = '\u001b[31mRed\u001b[0m \u001b[1;32mBold Green\u001b[0m';
      const clean = sanitizeInput(ansi);
      assert.strictEqual(clean, 'Red Bold Green');
    });

    it('sanitizeInput: should strip non-printable control characters', () => {
      const dirty = 'Hello\u0007\u0000World';
      const clean = sanitizeInput(dirty);
      assert.strictEqual(clean, 'HelloWorld');
    });

    it('sanitizeInput: should normalize newlines and tabs', () => {
      const multi = 'Line 1\r\n\tLine 2\nLine 3';
      const clean = sanitizeInput(multi);
      assert.strictEqual(clean, 'Line 1   Line 2 Line 3');
    });

    it('sanitizeInput: should strip bracketed paste mode wrapper sequences', () => {
      const pasted = '\x1b[200~npm run test\x1b[201~';
      const clean = sanitizeInput(pasted);
      assert.strictEqual(clean, 'npm run test');
    });

    it('sanitizeInput: should strip trailing newlines from paste text without leaving spaces at end', () => {
      const withTrailing = 'git commit -m "fix issue"\r\n';
      const clean = sanitizeInput(withTrailing);
      assert.strictEqual(clean, 'git commit -m "fix issue"');

      const multiTrailing = '\x1b[200~Line 1\r\nLine 2\r\n\x1b[201~';
      const cleanMulti = sanitizeInput(multiTrailing);
      assert.strictEqual(cleanMulti, 'Line 1 Line 2');
    });
  });

  describe('3. Word Boundary Navigation & Deletion on Paths and Commands', () => {
    it('moveCursor wordLeft: should jump across path segments step by step', () => {
      const pathStr = '@src/ui/ink/InputPromptBar.tsx';
      let state: LineEditorState = { value: pathStr, cursorOffset: pathStr.length };

      // End -> .tsx
      state = moveCursor(state, 'wordLeft');
      assert.strictEqual(state.cursorOffset, 27); // at '.'

      // . -> InputPromptBar
      state = moveCursor(state, 'wordLeft');
      assert.strictEqual(state.cursorOffset, 26); // after 'InputPromptBar'

      state = moveCursor(state, 'wordLeft');
      assert.strictEqual(state.cursorOffset, 12); // before 'InputPromptBar'
    });

    it('moveCursor wordRight: should jump forward across punctuation and words', () => {
      const pathStr = '@src/ui/index.ts';
      let state: LineEditorState = { value: pathStr, cursorOffset: 0 };

      state = moveCursor(state, 'wordRight');
      assert.strictEqual(state.cursorOffset, 1); // after '@'

      state = moveCursor(state, 'wordRight');
      assert.strictEqual(state.cursorOffset, 4); // after 'src'

      state = moveCursor(state, 'wordRight');
      assert.strictEqual(state.cursorOffset, 5); // after '/'
    });

    it('deleteWordBackward: should delete CLI arguments and options precisely', () => {
      const cmd = 'npm run test --filter=agent';
      let state: LineEditorState = { value: cmd, cursorOffset: cmd.length };

      // Deletes 'agent'
      state = deleteWordBackward(state);
      assert.strictEqual(state.value, 'npm run test --filter=');

      // Deletes '='
      state = deleteWordBackward(state);
      assert.strictEqual(state.value, 'npm run test --filter');

      // Deletes 'filter'
      state = deleteWordBackward(state);
      assert.strictEqual(state.value, 'npm run test --');

      // Deletes '--'
      state = deleteWordBackward(state);
      assert.strictEqual(state.value, 'npm run test ');
    });
  });

  describe('4. Line Boundaries and Basic Editing Invariants', () => {
    it('deleteToStart and deleteToEnd', () => {
      const state: LineEditorState = { value: 'console.log("hello");', cursorOffset: 11 };
      const toStart = deleteToStart(state);
      assert.strictEqual(toStart.value, '("hello");');
      assert.strictEqual(toStart.cursorOffset, 0);

      const toEnd = deleteToEnd(state);
      assert.strictEqual(toEnd.value, 'console.log');
      assert.strictEqual(toEnd.cursorOffset, 11);
    });

    it('insertText at arbitrary offsets', () => {
      let state: LineEditorState = { value: '', cursorOffset: 0 };
      state = insertText(state, 'git checkout');
      assert.strictEqual(state.value, 'git checkout');
      assert.strictEqual(state.cursorOffset, 12);

      // Move cursor and insert in middle
      state = moveCursor(state, 'home');
      state = insertText(state, 'sudo ');
      assert.strictEqual(state.value, 'sudo git checkout');
      assert.strictEqual(state.cursorOffset, 5);
    });
  });

  describe('5. InputPromptBar Component Verification', () => {
    it('InputPromptBar should instantiate cleanly with initial history and custom workspace', async () => {
      const React = await import('react');
      const { InputPromptBar } = await import('./InputPromptBar.js');
      const elem = React.createElement(InputPromptBar, {
        onSubmit: () => {},
        initialHistory: ['/help', 'git status', '@src/index.ts'],
        maxHistory: 50,
        disabled: false,
        workspacePath: process.cwd(),
      });
      assert.strictEqual(React.isValidElement(elem), true);
    });

    it('InputPromptBar should instantiate in disabled mode without crashing', async () => {
      const React = await import('react');
      const { InputPromptBar } = await import('./InputPromptBar.js');
      const elem = React.createElement(InputPromptBar, {
        onSubmit: () => {},
        disabled: true,
      });
      assert.strictEqual(React.isValidElement(elem), true);
    });
  });
});

