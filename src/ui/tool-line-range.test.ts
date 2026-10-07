import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolCompletionMetadata as format } from './tool-line-range.js';

test('search summaries replace latency with returned match coordinates', () => {
  assert.equal(format('search_text', {}, { matches: [{ line: 58 }, { startLine: 147, endLine: 175 }] }, 59), ' (startLine: 58, endLine: 175)');
});

test('read summaries prefer returned coordinates over requested ones', () => {
  assert.equal(format('read_file', { startLine: 1, endLine: 200 }, { startLine: 1, endLine: 64 }, 59), ' (startLine: 1, endLine: 64)');
  assert.equal(format('read_file', { startLine: 10, endLine: 20 }, {}, 59), ' (startLine: 10, endLine: 20)');
});

test('read-only results without coordinates do not fabricate a range', () => {
  assert.equal(format('search_text', {}, { matches: [] }, 59), '');
  assert.equal(format('search_codebase_fast', {}, { hits: [{ lines: [{ line: 58 }, { line: 62 }] }] }, 59), ' (startLine: 58, endLine: 62)');
});

test('mutation and command tools retain latency', () => {
  assert.equal(format('replace_text', {}, { line: 58 }, 59), ' (59ms)');
  assert.equal(format('run_command', {}, {}, 0), '');
});
