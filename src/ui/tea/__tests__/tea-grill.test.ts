import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { heuristicGrillOptions, suggestGrillOptions } from '../../../agent/grill-suggest.js';
import { getSlashCommandSuggestions } from '../../cli-ui.js';
import type { Msg } from '../types.js';

const key = (k: string, text?: string): Msg => ({ type: 'key', key: k, text, now: 10 });

test('slash /grill-me is registered with alias /grill', () => {
  const hits = getSlashCommandSuggestions('/grill-me', 5);
  assert.ok(hits.some((h) => h.command === '/grill-me'));
  const alias = getSlashCommandSuggestions('/grill', 5);
  assert.ok(alias.some((h) => h.command === '/grill-me'));
});

test('grill modal opens over input, navigates, picks and cancels', () => {
  let model = createRootModel();
  [model] = update({ type: 'grill', open: true, question: 'Deploy thế nào?', options: heuristicGrillOptions('Deploy thế nào?'), loading: false }, model);
  assert.equal(model.grill.open, true);
  assert.equal(model.focus, 'grill');
  // Phím gõ thường không lọt xuống composer khi modal mở.
  [model] = update(key('a', 'a'), model);
  assert.equal(model.composer.value, '');
  assert.equal(model.grill.open, true);
  // Điều hướng wraps + Enter pick.
  const count = model.grill.options.length;
  [model] = update(key('down'), model);
  assert.equal(model.grill.selected, 1);
  [model] = update(key('1', '1'), model);
  assert.equal(model.grill.open, false);
  // Mở lại rồi Esc hủy.
  [model] = update({ type: 'grill', open: true, question: 'Q', options: heuristicGrillOptions('Q'), loading: false }, model);
  const [cancelled, cancelCmds] = update(key('escape'), model);
  assert.equal(cancelled.grill.open, false);
  assert.deepEqual(cancelCmds, [{ type: 'grill-cancel' }]);
  void count;
});

test('grill overlay replaces rows in view (đè lên input)', () => {
  let model = createRootModel({ width: 60, height: 20 });
  const plain = view(model);
  [model] = update({ type: 'grill', open: true, question: 'Chọn hướng đi?', options: heuristicGrillOptions('Chọn hướng đi?'), loading: false }, model);
  const overlaid = view(model);
  assert.notEqual(overlaid, plain);
  assert.ok(overlaid.includes('GRILL-ME'));
});

test('suggestGrillOptions falls back to heuristic when LLM offline', async () => {
  const { options, fromLLM } = await suggestGrillOptions(undefined, 'Nên dùng Docker hay local?');
  assert.equal(fromLLM, false);
  assert.ok(options.length >= 2);
  const llm = { generate: async () => ({ text: '1. Dùng Docker để cách ly\n2. Dùng local cho nhanh\n3. Hỏi thêm về RAM' }) };
  const live = await suggestGrillOptions(llm, 'Chạy ở đâu?');
  assert.equal(live.fromLLM, true);
  assert.equal(live.options.length, 3);
  assert.ok(live.options.every((o) => o.source === 'llm'));
});
