import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLI, getVisibleWidth } from './cli-ui.js';

describe('Stacked tables for Ink final answers', () => {
  const headers = ['Tên', 'Mô tả', 'Đường dẫn', 'Unicode', 'Trạng thái', 'Ghi chú'];
  const values = ['read_file', 'Nội dung dài cần được hiển thị đầy đủ', 'src/' + 'long_path_'.repeat(15), '中文 👩‍💻 e\u0301', 'Sẵn sàng', 'first<br>second'];
  const markdown = [headers.join(' | '), headers.map(() => '---').join(' | '), values.join(' | ')].join('\n');

  for (const width of [12, 24, 56, 76, 116]) {
    it(`keeps every label and value within ${width} content cells`, () => {
      const output = CLI.formatMarkdownTables(markdown, { width, layout: 'stacked' });
      assert.ok(!output.includes('│'), 'There must be no padded columns for Ink to misalign');
      for (const line of output.split('\n')) {
        assert.ok(getVisibleWidth(line) <= width, `Overflow: ${line}`);
      }
      const compact = output.replace(/\s/g, '');
      for (const header of headers) assert.ok(compact.includes(header.replace(/\s/g, '') + ':'));
      for (const value of values) assert.ok(compact.includes(value.replace(/<br>/g, '').replace(/\s/g, '')));
    });
  }

  it('preserves prose and fenced tables rather than truncating the answer', () => {
    const prose = 'Normal prose '.repeat(30);
    const code = '```text\n| A | B |\n|---|---|\n| C | D |\n```';
    const output = CLI.formatMarkdownTables(`${prose}\n${code}\n${markdown}`, { width: 36, layout: 'stacked' });
    assert.ok(output.startsWith(prose));
    assert.ok(output.includes(code));
  });

  it('preserves escaped and inline-code pipes and empty cells', () => {
    const output = CLI.formatMarkdownTables('| A | B | C |\n|---|---|---|\n| x\\|y | `a | b` | |', { width: 36, layout: 'stacked' });
    assert.ok(output.includes('x|y'));
    assert.ok(output.includes('`a | b`'));
    assert.ok(output.includes('C:\n  '));
  });

  it('retains column labels when a table has no data rows', () => {
    const output = CLI.formatMarkdownTables('| A | B |\n|---|---|', { width: 24, layout: 'stacked' });
    assert.ok(output.includes('A:'));
    assert.ok(output.includes('B:'));
  });

  it('keeps the existing grid as the default for non-Ink callers', () => {
    const output = CLI.formatMarkdownTables('| A | B |\n|---|---|\n| C | D |');
    assert.ok(output.startsWith('┌'));
    assert.ok(output.includes('│ C │ D │'));
  });
});
