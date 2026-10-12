import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update } from '../models/root-model.js';
import { updateComposer, createComposer } from '../models/composer-model.js';
import { statuslineView } from '../models/statusline-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import { KernelTEAAdapter, KERNEL_EVENT_NAMES } from '../kernel-bridge.js';
import { KernelEventBus } from '../../../kernel/kernel.js';
import type { Msg } from '../types.js';

const key = (key: string, text?: string): Msg => ({ type: 'key', key, text, now: 10 });

test('leader compact, editor, quit, sidebar and diff route to effects/state', () => {
  for (const [keyName, effect] of [['c', 'compact'], ['e', 'editor'], ['q', 'quit']] as const) {
    const initial = createRootModel();
    const [armed] = update(key('ctrl+x'), initial);
    const [next, commands] = update(key(keyName), armed);
    assert.equal(commands[0].type, effect);
    assert.equal(next.leaderUntil, 0);
    assert.equal(initial.leaderUntil, 0);
  }
  let [model] = update(key('ctrl+x'), createRootModel());
  [model] = update(key('b'), model);
  assert.equal(model.sidebar.visible, true);
  [model] = update(key('ctrl+x'), model);
  [model] = update(key('d'), model);
  assert.equal(model.diff.visible, true);
});

test('leader expires, Tab toggles mode, and Ctrl+P captures focus', () => {
  let [model] = update(key('ctrl+x'), createRootModel());
  [model] = update({ type: 'tick', now: 5000 }, model);
  [model] = update(key('c', 'c'), model);
  assert.equal(model.composer.value, 'c');
  [model] = update(key('tab'), model);
  assert.equal(model.mode, 'PLAN');
  [model] = update(key('ctrl+p'), model);
  assert.equal(model.focus, 'palette');
  [model] = update(key('text', 'ctx'), model);
  assert.equal(model.palette.query, 'ctx');
  assert.equal(model.composer.value, 'c');
  [model] = update(key('escape'), model);
  assert.equal(model.focus, 'composer');
});

test('ordered kernel tokens are lossless, abort freezes them, settlement releases busy state', () => {
  let model = createRootModel();
  [model] = update({ type: 'busy', busy: true }, model);
  for (let i = 0; i < 1000; i++) {
    [model] = update({ type: 'kernel', event: 'model:thought', args: ['x'] }, model);
  }
  assert.equal(model.viewport.thinking, 'x'.repeat(1000));
  let commands;
  [model, commands] = update(key('ctrl+c'), model);
  assert.equal(commands[0].type, 'abort');
  assert.equal(model.status.aborting, true);
  [model] = update({ type: 'kernel', event: 'model:thought', args: ['late'] }, model);
  assert.equal(model.viewport.thinking, 'x'.repeat(1000));
  [model] = update({ type: 'busy', busy: false }, model);
  assert.equal(model.status.aborting, false);
  assert.equal(model.status.busy, false);
});

test('composer preserves multiline paste, graphemes, history and completion suffix', () => {
  let composer = createComposer();
  composer = updateComposer(composer, key('paste', 'a\n👩‍💻'));
  composer = updateComposer(composer, key('backspace'));
  assert.equal(composer.value, 'a\n');
  composer = { ...composer, value: 'new', cursorOffset: 3, history: ['old'] };
  composer = updateComposer(composer, key('up'));
  assert.equal(composer.value, 'old');
  composer = updateComposer(composer, key('down'));
  assert.equal(composer.value, 'new');
});

test('palette selects slash commands and dialogs isolate permission answers', () => {
  let model = createRootModel({ commands: [{ id: '/help', label: 'Help', description: 'Commands' }] });
  [model] = update(key('ctrl+p'), model);
  const [next, effects] = update(key('enter'), model);
  assert.equal(next.focus, 'composer');
  assert.deepEqual(effects, [{ type: 'submit', text: '/help' }]);
  [model] = update({ type: 'question', prompt: 'Approve? [y/n]', active: true }, next);
  [model] = update(key('text', 'n'), model);
  const [, answers] = update(key('enter'), model);
  assert.deepEqual(answers, [{ type: 'answer', text: 'n' }]);
});

test('bridge forwards every kernel event and unsubscribes exactly its listeners', () => {
  const events = new KernelEventBus();
  const sent: Msg[] = [];
  const adapter = new KernelTEAAdapter(events, msg => sent.push(msg));
  const dispose = adapter.bind();
  for (const name of KERNEL_EVENT_NAMES) assert.equal(events.listenerCount(name), 1);
  events.emit('model:thought', 'first');
  events.emit('model:final_answer', 'done');
  assert.deepEqual(sent.map(m => m.type === 'kernel' ? m.event : ''), ['model:thought', 'model:final_answer']);
  dispose(); dispose();
  for (const name of KERNEL_EVENT_NAMES) assert.equal(events.listenerCount(name), 0);
});

test('compaction notice displays on statusline and auto-hides after 3s', () => {
  let model = createRootModel();
  const startTime = 1000;
  // 1. When compaction is skipped, compactionUntil is scheduled for ~3s
  [model] = update({ type: 'compaction', status: { scope: 'turn', state: 'skipped' } }, model);
  assert.equal(model.status.compaction?.state, 'skipped');
  assert.ok(model.status.compactionUntil && model.status.compactionUntil > Date.now());

  // 2. When tick arrives after 3000ms, compaction notice is cleared
  const expiryTime = model.status.compactionUntil!;
  [model] = update({ type: 'tick', now: expiryTime + 10 }, model);
  assert.equal(model.status.compaction, null);
  assert.equal(model.status.compactionUntil, undefined);

  // 3. Running compaction does not set auto-hide timer
  [model] = update({ type: 'compaction', status: { scope: 'turn', state: 'running' } }, model);
  assert.equal(model.status.compaction?.state, 'running');
  assert.equal(model.status.compactionUntil, undefined);
});

test('/model and /modal trigger hot-model-switch Cmd during busy state without polluting transcript', () => {
  let model = createRootModel();
  [model] = update({ type: 'busy', busy: true }, model);
  assert.equal(model.status.busy, true);

  // 1. Gõ /model claude-3-5-sonnet khi đang busy
  [model] = update({ type: 'compose', text: '/model claude-3-5-sonnet' }, model);
  const [modelAfterSubmit, effects] = update(key('enter'), model);

  // Effects phát hot-model-switch với model target
  assert.deepEqual(effects, [{ type: 'hot-model-switch', model: 'claude-3-5-sonnet' }]);
  // Ô nhập được reset
  assert.equal(modelAfterSubmit.composer.value, '');
  // Viewport entries không bị thêm /model như user message
  assert.equal(modelAfterSubmit.viewport.entries.length, 0);

  // 2. Gõ /model không kèm tên khi đang busy
  [model] = update({ type: 'compose', text: '/model' }, modelAfterSubmit);
  const [, effectsNoArgs] = update(key('enter'), model);
  assert.deepEqual(effectsNoArgs, [{ type: 'hot-model-switch', model: '' }]);

  // 3. Gõ /modal có tên khi đang busy
  [model] = update({ type: 'compose', text: '/modal gpt-4o' }, modelAfterSubmit);
  const [, effectsModal] = update(key('enter'), model);
  assert.deepEqual(effectsModal, [{ type: 'hot-model-switch', model: 'gpt-4o' }]);

  // 4. Khi KHÔNG busy (idle), /model vẫn submit bình thường
  let idleModel = createRootModel();
  [idleModel] = update({ type: 'compose', text: '/model claude-3-5-sonnet' }, idleModel);
  const [idleAfter, idleEffects] = update(key('enter'), idleModel);
  assert.deepEqual(idleEffects, [{ type: 'submit', text: '/model claude-3-5-sonnet' }]);
  assert.equal(idleAfter.viewport.entries.length, 1);
});

test('statusline surfaces tool + step + retry statuses besides phase', () => {
  let model = createRootModel({ width: 120, height: 24 });
  [model] = update({ type: 'busy', busy: true }, model);
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['run_command', {}] }, model);
  [model] = update({ type: 'kernel', event: 'step:before', args: [3, 10] }, model);
  [model] = update({ type: 'kernel', event: 'model:retry', args: [{ attempt: 1, maxRetries: 3, delayMs: 1000 }] }, model);
  const text = stripTerminalControls(statuslineView(model));
  assert.ok(text.includes('run_command'), text);
  assert.ok(text.includes('Step 3/10'), text);
  assert.ok(text.includes('Retry 1/3'), text);
  const ansi = statuslineView(model);
  assert.ok(ansi.includes('158;206;106'), 'tool segment green');
  assert.ok(ansi.includes('224;175;104'), 'retry segment yellow');
});


