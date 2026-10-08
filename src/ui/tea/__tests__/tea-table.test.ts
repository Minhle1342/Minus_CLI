import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Table, renderTable, formatSubmitSolutionTable, formatMarkdownTablesWithTea } from '../styles/table.js';
import { createRootModel, update } from '../models/root-model.js';
import { viewportLines } from '../models/viewport-model.js';

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

test('formatMarkdownTablesWithTea: parses markdown table and wraps in rounded unicode borders', () => {
  const markdown = [
    '| ID / Mã định danh | Tên Subagent | Mô hình |',
    '| :--- | :--- | :--- |',
    '| subagent-deepseek-r1-math | DeepSeek-R1 Math | deepseek-ai/DeepSeek-R1 |',
    '| subagent-qwen25-coder | Qwen2.5-Coder | Qwen/Qwen2.5-Coder-32B |',
  ].join('\n');

  const rendered = formatMarkdownTablesWithTea(markdown, 80);
  assert.ok(rendered.includes('╭'), 'Must start with rounded top-left border');
  assert.ok(rendered.includes('╮'), 'Must have rounded top-right border');
  assert.ok(rendered.includes('╰'), 'Must have rounded bottom-left border');
  assert.ok(rendered.includes('╯'), 'Must have rounded bottom-right border');
  assert.ok(rendered.includes('ID / Mã định danh'));
  assert.ok(rendered.includes('DeepSeek-R1 Math'));
  assert.ok(rendered.includes('Qwen2.5-Coder'));
});

test('viewport: final answer containing markdown table renders with rounded unicode borders in viewport', () => {
  let model = createRootModel({ width: 100, height: 30 });
  const tableAnswer = [
    'Báo cáo danh sách subagent:',
    '| ID | Tên | Domain |',
    '| :--- | :--- | :--- |',
    '| r1-math | Math Specialist | Mathematics |',
    '| swe-arch | Architecture | Refactoring |',
  ].join('\n');

  [model] = update({ type: 'kernel', event: 'model:final_answer', args: [tableAnswer] }, model);
  const lines = viewportLines(model.viewport, 100);
  const fullText = lines.join('\n');

  assert.ok(fullText.includes('╭'), 'Viewport must render rounded top border');
  assert.ok(fullText.includes('╮'), 'Viewport must render rounded top-right border');
  assert.ok(fullText.includes('╰'), 'Viewport must render rounded bottom-left border');
  assert.ok(fullText.includes('╯'), 'Viewport must render rounded bottom-right border');
  assert.ok(fullText.includes('r1-math'));
  assert.ok(fullText.includes('swe-arch'));
});

test('formatSubmitSolutionTable: formats submit_solution as structured TEA table', () => {
  const table = formatSubmitSolutionTable({
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
  });

  assert.match(table, /╭.*┬.*╮/, 'Must contain TEA table top border');
  assert.match(table, /Loại giải pháp/);
  assert.match(table, /Sửa lỗi logic trong parser/);
  assert.match(table, /Thiếu dấu kiểm tra điều kiện/);
  assert.match(table, /src\/parser\.ts/);
  assert.match(table, /automated_test_pass/);
  assert.match(table, /100\/100/);
  assert.match(table, /╰.*┴.*╯/, 'Must contain TEA table bottom border');
});

test('viewport: toolResultEntry hides submit_solution result to avoid duplicate display', () => {
  let model = createRootModel();
  [model] = update({ type: 'kernel', event: 'tool:before', args: ['submit_solution', { summary: 'Sửa lỗi logic' }] }, model);
  [model] = update({ type: 'kernel', event: 'tool:after', args: ['submit_solution', {
    success: true,
    submitted: true,
    summary: 'Sửa lỗi logic trong parser',
    rootCause: 'Thiếu dấu kiểm tra điều kiện',
    filesModified: ['src/parser.ts'],
  }, 10, { summary: 'Sửa lỗi logic' }] }, model);

  const entry = model.viewport.entries[1];
  assert.ok(entry, 'Viewport must have tool result entry');
  assert.match(entry.text, /✔ submit_solution \[OK\]/);
  assert.match(entry.text, /Câu trả lời đã được gửi/);
  assert.doesNotMatch(entry.text, /╭.*┬.*╮/, 'Must NOT contain duplicate table in tool result entry');
  assert.doesNotMatch(entry.text, /Sửa lỗi logic trong parser/, 'Must hide result body from tool result entry');
});
