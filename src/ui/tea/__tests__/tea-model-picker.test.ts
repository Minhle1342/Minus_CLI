import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { modelPickerLayout } from '../models/model-picker-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import type { ModelPickerOption, Msg } from '../types.js';

const key = (k: string, text?: string, mouse?: { x: number; y: number }): Msg => ({ type: 'key', key: k, text, mouse, now: 10 });

const opts: ModelPickerOption[] = [
  { id: '0', name: 'auto-fallback', provider: 'Router', desc: 'Auto-rotates on 429s', recommended: true },
  { id: '1', name: 'gemini-3.7-flash', provider: 'Google AI Studio', desc: 'Ultra-fast coding', current: true },
  { id: '8', name: 'groq/llama-3.3-70b-versatile', provider: 'Groq Cloud (Free)', desc: 'Llama 3.3 70B on LPU' },
  { id: '30', name: 'pollinations/openai', provider: 'Pollinations.ai (Zero-Key)', desc: 'GPT-4o-mini free' },
];

test('model-picker modal opens over viewport, preselects current, navigates, picks and cancels', () => {
  let model = createRootModel();
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  assert.equal(model.modelPicker.open, true);
  assert.equal(model.focus, 'model-picker');
  assert.equal(model.modelPicker.selected, 1);
  // Phím gõ thường đi vào chuỗi lọc, không lọt xuống composer khi modal mở.
  [model] = update(key('a', 'a'), model);
  assert.equal(model.composer.value, '');
  assert.equal(model.modelPicker.query, 'a');
  assert.equal(model.modelPicker.open, true);
  // Mở lại để có state sạch cho điều hướng.
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  // Điều hướng wraps + Enter pick.
  [model] = update(key('down'), model);
  assert.equal(model.modelPicker.selected, 2);
  [model] = update(key('up'), model);
  assert.equal(model.modelPicker.selected, 1);
  const [picked, pickCmds] = update(key('enter'), model);
  assert.equal(picked.modelPicker.open, false);
  assert.deepEqual(pickCmds, [{ type: 'model-pick', id: '1', name: 'gemini-3.7-flash' }]);
  // Mở lại rồi Esc hủy.
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  const [cancelled, cancelCmds] = update(key('escape'), model);
  assert.equal(cancelled.modelPicker.open, false);
  assert.deepEqual(cancelCmds, [{ type: 'model-cancel' }]);
});

test('model-picker overlay replaces rows in view (đè lên viewport)', () => {
  let model = createRootModel({ width: 60, height: 20 });
  const plain = view(model);
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  const overlaid = view(model);
  assert.notEqual(overlaid, plain);
  assert.ok(overlaid.includes('MODELS'));
  assert.ok(overlaid.includes('gemini-3.7-flash'));
});

test('model-picker mouse click on option row picks it', () => {
  let model = createRootModel({ width: 80, height: 24 });
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  const layout = modelPickerLayout(model.modelPicker, model.width, model.height);
  const rowIndex = layout.rowOption.findIndex((o) => o === 2);
  assert.ok(rowIndex >= 0);
  const [picked, cmds] = update(key('mouse+press', undefined, { x: 5, y: layout.startRow + rowIndex + 1 }), model);
  assert.equal(picked.modelPicker.open, false);
  assert.deepEqual(cmds, [{ type: 'model-pick', id: '8', name: 'groq/llama-3.3-70b-versatile' }]);
});

test('model-picker mouse wheel moves highlight without picking', () => {
  let model = createRootModel({ width: 80, height: 24 });
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  assert.equal(model.modelPicker.selected, 1);
  [model] = update(key('mouse+down', undefined, { x: 5, y: 10 }), model);
  assert.equal(model.modelPicker.selected, 2);
  assert.equal(model.modelPicker.open, true);
  [model] = update(key('mouse+up', undefined, { x: 5, y: 10 }), model);
  assert.equal(model.modelPicker.selected, 1);
});

test('model-picker typing filters fuzzy, backspace edits, Esc clears first', () => {
  let model = createRootModel({ width: 80, height: 24 });
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  [model] = update(key('g', 'g'), model);
  [model] = update(key('r', 'r'), model);
  [model] = update(key('o', 'o'), model);
  assert.equal(model.modelPicker.query, 'gro');
  assert.ok(stripTerminalControls(view(model)).includes('groq/llama-3.3-70b-versatile'));
  const [picked, cmds] = update(key('enter'), model);
  assert.deepEqual(cmds, [{ type: 'model-pick', id: '8', name: 'groq/llama-3.3-70b-versatile' }]);
  assert.equal(picked.modelPicker.open, false);
  // Esc đầu xóa query, Esc tiếp mới hủy.
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  [model] = update(key('x', 'x'), model);
  assert.equal(model.modelPicker.query, 'x');
  [model] = update(key('escape'), model);
  assert.equal(model.modelPicker.query, '');
  assert.equal(model.modelPicker.open, true);
  const [cancelled, cancelCmds] = update(key('escape'), model);
  assert.equal(cancelled.modelPicker.open, false);
  assert.deepEqual(cancelCmds, [{ type: 'model-cancel' }]);
});

test('model-picker empty filter keeps modal open on Enter, selected row is bg-highlighted', () => {
  let model = createRootModel({ width: 80, height: 24 });
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  [model] = update(key('z', 'z'), model);
  [model] = update(key('z', 'z'), model);
  [model] = update(key('z', 'z'), model);
  const [kept, cmds] = update(key('enter'), model);
  assert.equal(kept.modelPicker.open, true);
  assert.deepEqual(cmds, []);
  assert.ok(view(model).includes('No match'));
  // Dòng đang chọn có nền highlight (focus indicator nhìn thấy được).
  [model] = update({ type: 'model-picker', open: true, options: opts }, model);
  assert.ok(view(model).includes('48;2;65;72;104m'));
});
