import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update } from '../models/root-model.js';

test('viewport keeps each tool call and result visible without submit_solution control metadata', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['read_file', { path: 'src/a.ts' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['read_file', { content: 'export const answer = 42;' }, 5, { path: 'src/a.ts' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['submit_solution', { summary: 'Một câu trả lời dài' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['submit_solution', {
    success: true, submitted: true, summary: 'Một câu trả lời dài', timestamp: '2026-10-07T17:01:44.697Z',
    message: 'Internal final answer instruction', _untrusted_context: { level: 5 },
  }, 8, { summary: 'Một câu trả lời dài' }] }, model);

  assert.equal(model.viewport.entries.length, 4);
  assert.match(model.viewport.entries[0].text, /read_file.*src\/a\.ts/);
  assert.match(model.viewport.entries[1].text, /read_file[\s\S]*export const answer = 42/);
  assert.equal(model.viewport.entries[2].text, '● submit_solution');
  assert.match(model.viewport.entries[3].text, /Câu trả lời đã được gửi/);
  assert.doesNotMatch(model.viewport.entries[3].text, /_untrusted_context|timestamp|Internal final answer instruction/);
});

test('tool failures retain diagnostic output', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['run_command', {
    success: false, error: 'TS2307 missing module', stderr: 'compiler output', exitCode: 1,
  }, 12, {}] }, model);
  assert.match(model.viewport.entries[0].text, /✖ run_command/);
  assert.match(model.viewport.entries[0].text, /TS2307 missing module/);
  assert.match(model.viewport.entries[0].text, /compiler output/);
});
