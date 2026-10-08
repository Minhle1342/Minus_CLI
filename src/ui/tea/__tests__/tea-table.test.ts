import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Table, renderTable, formatSubmitSolutionTable } from '../styles/table.js';
import { createRootModel, update } from '../models/root-model.js';

test('Table: renders rounded unicode box-drawing table with correct column headers and rows', () => {
  const table = new Table({ width: 60 });
  table.headers('Thuộc tính', 'Giá trị');
  table.row('Trạng thái', 'Thành công');
  table.row('Ghi chú', 'Kiểm tra bảng TEA');
  const rendered = table.render();

  assert.ok(rendered.includes('╭'), 'Table must have rounded top-left corner');
  assert.ok(rendered.includes('╮'), 'Table must have rounded top-right corner');
  assert.ok(rendered.includes('╰'), 'Table must have rounded bottom-left corner');
  assert.ok(rendered.includes('╯'), 'Table must have rounded bottom-right corner');
  assert.ok(rendered.includes('Thuộc tính'), 'Table must include header cell');
  assert.ok(rendered.includes('Giá trị'), 'Table must include header cell');
  assert.ok(rendered.includes('Thành công'), 'Table must include row cell');
  assert.ok(rendered.includes('Kiểm tra bảng TEA'), 'Table must include row cell');
});

test('renderTable: formats multi-column table within constraints', () => {
  const headers = ['Cột 1', 'Cột 2', 'Cột 3'];
  const rows = [
    ['Dữ liệu 1', 'Dữ liệu 2', 'Dữ liệu 3'],
    ['A', 'B', 'C'],
  ];
  const rendered = renderTable(headers, rows, { width: 50 });
  assert.ok(rendered.includes('Cột 1'));
  assert.ok(rendered.includes('Dữ liệu 3'));
  assert.ok(rendered.includes('├'));
  assert.ok(rendered.includes('┼'));
});

test('viewport: toolResultEntry formats submit_solution as structured TEA table', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['submit_solution', { summary: 'Sửa lỗi logic' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['submit_solution', {
    success: true,
    submitted: true,
    summary: 'Sửa lỗi logic trong parser',
    rootCause: 'Thiếu dấu kiểm tra điều kiện',
    filesModified: ['src/parser.ts'],
    verificationMethod: 'automated_test_pass',
    verificationEvidence: 'npm test passed',
    groundingScore: 100,
    timestamp: '2026-10-08T15:20:00.000Z',
    message: 'Task completed',
  }, 10, { summary: 'Sửa lỗi logic' }] }, model);

  const entry = model.viewport.entries[1];
  assert.ok(entry, 'Viewport must have tool result entry');
  assert.match(entry.text, /Câu trả lời đã được gửi/);
  assert.match(entry.text, /╭.*┬.*╮/, 'Must contain TEA table top border');
  assert.match(entry.text, /Loại giải pháp/);
  assert.match(entry.text, /Sửa lỗi logic trong parser/);
  assert.match(entry.text, /Thiếu dấu kiểm tra điều kiện/);
  assert.match(entry.text, /src\/parser\.ts/);
  assert.match(entry.text, /automated_test_pass/);
  assert.match(entry.text, /100\/100/);
  assert.match(entry.text, /╰.*┴.*╯/, 'Must contain TEA table bottom border');
  assert.doesNotMatch(entry.text, /Task completed|2026-10-08T15:20:00.000Z/, 'Control metadata must stay excluded');
});
