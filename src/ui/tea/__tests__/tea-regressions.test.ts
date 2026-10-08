import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update } from '../models/root-model.js';
import { viewportView } from '../models/viewport-model.js';
import { editorArguments } from '../external-editor.js';
import { composerView } from '../models/composer-model.js';
import { stripTerminalControls, displayWidth } from '../styles/theme.js';

test('answer streaming appends in one buffer and final answer replaces it exactly once', () => {
  let model = createRootModel();
  for (let i = 0; i < 1000; i++) [model] = update({ type: 'kernel', event: 'model:token', args: ['x'] }, model);
  assert.equal((model.viewport as any).answerStream, 'x'.repeat(1000));
  assert.equal(model.viewport.entries.length, 0);
  [model] = update({ type: 'kernel', event: 'model:final_answer', args: ['final'] }, model);
  assert.equal((model.viewport as any).answerStream, '');
  assert.equal(model.viewport.entries.filter(entry => entry.kind === 'answer').length, 1);
});

test('scroll pin holds the visible lines while new output arrives', () => {
  let model = createRootModel({ width: 80, height: 24 });
  for (let i = 0; i < 30; i++) [model] = update({ type: 'log', text: 'row ' + i }, model);
  [model] = update({ type: 'key', key: 'pageup', now: 1 }, model);
  const before = viewportView(model.viewport, 80, 20);
  [model] = update({ type: 'log', text: 'new output' }, model);
  assert.deepEqual(viewportView(model.viewport, 80, 20), before);
});

test('composer draws whole grapheme at cursor and no terminal control commands from payload', () => {
  let model = createRootModel();
  [model] = update({ type: 'compose', text: '👩‍💻中文' }, model);
  model.composer.cursorOffset = 0;
  const rendered = composerView(model.composer, 80, 2).join('\n');
  // P1 cursor: underline + cyan cell (not a reverse-only block).
  assert.ok(rendered.includes('\x1b[4m'));
  assert.ok(rendered.includes('👩‍💻'));
  assert.ok(displayWidth(rendered) <= 80);
  assert.equal(stripTerminalControls('\x1b]0;evil\x07hello\x1b[2J'), 'hello');
});

test('busy tasks cannot change execution permission mode', () => {
  let [model] = update({ type: 'busy', busy: true }, createRootModel());
  let commands;
  [model, commands] = update({ type: 'key', key: 'tab', now: 10 }, model);
  assert.equal(model.mode, 'IMPLEMENT');
  assert.equal(commands.length, 0);
});

test('kernel tool/usage/retry/workspace status and diff are projected', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'step:before', args: [2, 10] }, model);
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['replace_text', { path: 'a.ts' }] }, model);
  assert.deepEqual(model.sidebar.tools, ['replace_text']);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['replace_text', { diff: '+new' }, 12, { path: 'a.ts' }] }, model);
  assert.deepEqual(model.sidebar.tools, []); assert.deepEqual(model.sidebar.files, ['a.ts']); assert.equal(model.diff.text, '+new');
  [model] = update({ type: 'kernel', event: 'model:usage', args: [{ promptTokens: 42 } as any] }, model);
  assert.equal(model.sidebar.tokens, 42);
  [model] = update({ type: 'kernel', event: 'model:retry', args: [{ attempt: 1, maxRetries: 3, delayMs: 1000 }] }, model);
  assert.match(model.status.retry, /Retry 1\/3/);
  [model] = update({ type: 'kernel', event: 'workspace:changed', args: ['a', 'b'] }, model);
  assert.equal(model.sidebar.workspace, 'b');
});

test('editor argument parser preserves quoted executable paths and flags', () => {
  assert.deepEqual(editorArguments('"C:\\Program Files\\Editor\\editor.exe" --wait'), ['C:\\Program Files\\Editor\\editor.exe', '--wait']);
});


test('approval diff can be toggled and paged without consuming answer input', () => {
  let model = createRootModel();
  [model] = update({ type: 'diff', text: '+change' }, model);
  [model] = update({ type: 'question', prompt: 'Approve? [y/n]', active: true }, model);
  [model] = update({ type: 'key', key: 'ctrl+x', now: 1 }, model);
  [model] = update({ type: 'key', key: 'd', text: 'd', now: 2 }, model);
  assert.equal(model.diff.visible, true);
  assert.equal(model.composer.value, '');
  [model] = update({ type: 'key', key: 'pagedown', now: 3 }, model);
  assert.equal(model.diff.offset, 10);
  [model] = update({ type: 'key', key: 'y', text: 'y', now: 4 }, model);
  const [, commands] = update({ type: 'key', key: 'enter', now: 5 }, model);
  assert.deepEqual(commands, [{ type: 'answer', text: 'y' }]);
});

test('tool errors and output remain available in expandable transcript', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['run_command', { error: 'TS2307 missing module', output: 'compiler output' }, 12, {}] }, model);
  assert.match(model.viewport.entries.at(-1)!.text, /TS2307 missing module/);
  assert.match(model.viewport.entries.at(-1)!.text, /compiler output/);
});

test('permission answers navigate options with arrows and confirm with enter', () => {
  const permission = { toolName: 'write_file', target: 'a.ts', summary: 'Write file', riskLevel: 'high', category: 'file_write' };
  let model = createRootModel();
  [model] = update({ type: 'question', prompt: 'Allow?', active: true, permission }, model);
  assert.equal(model.question.selected, 0);
  [model] = update({ type: 'key', key: 'down', now: 1 }, model);
  [model] = update({ type: 'key', key: 'down', now: 2 }, model);
  assert.equal(model.question.selected, 2);
  const [, commands] = update({ type: 'key', key: 'enter', now: 3 }, model);
  assert.deepEqual(commands, [{ type: 'answer', text: 'n' }]);
  // Letter shortcuts jump the highlight without confirming; composer stays isolated.
  [model] = update({ type: 'question', prompt: 'Allow?', active: true, permission }, model);
  [model] = update({ type: 'key', key: 'text', text: 'a', now: 4 }, model);
  assert.equal(model.question.selected, 1);
  assert.equal(model.composer.value, '');
  const [, answers] = update({ type: 'key', key: 'enter', now: 5 }, model);
  assert.deepEqual(answers, [{ type: 'answer', text: 'a' }]);
});
