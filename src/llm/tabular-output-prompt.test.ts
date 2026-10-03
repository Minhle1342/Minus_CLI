import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPT_SECTIONS, SECTION_TABULAR_OUTPUT, needsTabularOutput, detectPromptContext } from './prompt-sections.js';
import { PromptAssembler } from './prompt-assembler.js';
import { createStandardSystemPrompt } from './prompts.js';

describe('On-demand table output instructions', () => {
  for (const request of [
    'Trình bày dữ liệu dạng bảng',
    'Lập bảng thống kê kết quả kiểm thử',
    'Cho tôi bảng so sánh các model',
    'Xuất bảng Markdown gồm tên, giá và trạng thái',
    'Present results as a table',
    'List tools in a Markdown table',
    'Create a feature matrix for these models',
    'Tabulate monthly revenue',
    'Create a table showing test statuses',
    'Lập bảng tên và trạng thái các công cụ',
  ]) {
    it(`loads guidance for: ${request}`, () => {
      assert.equal(needsTabularOutput(request), true);
      // Follow the same detection -> assembly path used by AgentLoop.
      const prompt = createStandardSystemPrompt(detectPromptContext(undefined, undefined, request));
      assert.ok(prompt.includes(SECTION_TABULAR_OUTPUT));
    });
  }

  for (const request of [
    undefined, '', 'Explain this function', 'Fix the table renderer',
    'Create table users in SQL', 'Sửa bảng users trong database',
    'Add an HTML table component', 'Compare these implementations in prose',
    'Explain the variable `comparison table`',
    'Review this code:\n```text\ncomparison table\n```',
    'Comparison table is unnecessary; do not use tables',
    'So sánh model, không dùng bảng so sánh',
  ]) {
    it(`does not load guidance for: ${request ?? '(no task)'}`, () => {
      assert.equal(needsTabularOutput(request), false);
      assert.ok(!createStandardSystemPrompt({ request }).includes(SECTION_TABULAR_OUTPUT));
    });
  }

  it('uses only the dynamic tail and removes guidance on the next non-tabular turn', () => {
    const assembler = new PromptAssembler();
    for (const section of DEFAULT_PROMPT_SECTIONS) assembler.register(section);
    const plain = assembler.assembleTiered({ request: 'Explain this function' });
    const table = assembler.assembleTiered({ request: 'List tools in a Markdown table' });
    const next = assembler.assembleTiered({ request: 'Fix a bug' });
    assert.equal(table.stablePrefix, plain.stablePrefix);
    assert.ok(table.t3DynamicTail.includes(SECTION_TABULAR_OUTPUT));
    assert.ok(!plain.fullPrompt.includes(SECTION_TABULAR_OUTPUT));
    assert.ok(!next.fullPrompt.includes(SECTION_TABULAR_OUTPUT));
  });

  it('specifies the contract consumed by the new TUI layout', () => {
    assert.ok(SECTION_TABULAR_OUTPUT.includes('Escape literal pipes in cells as \\|'));
    assert.ok(SECTION_TABULAR_OUTPUT.includes('vertical record with column labels'));
    assert.ok(SECTION_TABULAR_OUTPUT.includes('Never truncate'));
    assert.ok(SECTION_TABULAR_OUTPUT.includes('same number of cells'));
  });
});
