import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAnswer, formatAnswerInline, viewportLines } from '../models/viewport-model.js';
import { displayWidth, tokyoNight } from '../styles/theme.js';
import type { ViewportModel } from '../types.js';

test('formatAnswerInline: renders italic with * and _ without breaking snake_case or math', () => {
  const italicStar = formatAnswerInline('This is *italic text* here', tokyoNight.text);
  assert.match(italicStar, /\x1b\[3m.*italic text.*\x1b\[23m/);

  const italicUnderscore = formatAnswerInline('This is _emphasized text_ here', tokyoNight.text);
  assert.match(italicUnderscore, /\x1b\[3m.*emphasized text.*\x1b\[23m/);

  // snake_case should NOT become italic
  const snakeCase = formatAnswerInline('const user_profile_id = 123;', tokyoNight.text);
  assert.doesNotMatch(snakeCase, /\x1b\[3m.*profile.*\x1b\[23m/);

  // math with spaces should NOT become italic
  const math = formatAnswerInline('Formula: 3 * 5 * 2 = 30', tokyoNight.text);
  assert.doesNotMatch(math, /\x1b\[3m.*5.*\x1b\[23m/);
});

test('formatAnswerInline: renders bold + italic (*** and ___)', () => {
  const boldItalic = formatAnswerInline('Important: ***super critical*** point', tokyoNight.text);
  assert.match(boldItalic, /\x1b\[1;3m.*super critical.*\x1b\[22;23m/);

  const boldItalicUnder = formatAnswerInline('Notice: ___underlined strong___', tokyoNight.text);
  assert.match(boldItalicUnder, /\x1b\[1;3m.*underlined strong.*\x1b\[22;23m/);
});

test('formatAnswerInline: renders strikethrough (~~text~~)', () => {
  const strike = formatAnswerInline('Status: ~~outdated feature~~ updated', tokyoNight.text);
  assert.match(strike, /\x1b\[9m.*outdated feature.*\x1b\[29m/);
});

test('formatAnswerInline: renders images (![alt](url))', () => {
  const img = formatAnswerInline('Look at ![Architecture Diagram](https://example.com/arch.png)', tokyoNight.text);
  assert.match(img, /🖼 Architecture Diagram/);
  assert.match(img, /https:\/\/example\.com\/arch\.png/);
});

test('formatAnswerInline: decodes HTML entities and renders inline tags (<kbd>, <mark>, <u>)', () => {
  const entities = formatAnswerInline('&lt;div&gt; &amp; &quot;hello&#39;s&quot;', tokyoNight.text);
  assert.match(entities, /<div>/);
  assert.match(entities, /&/);
  assert.match(entities, /"hello's"/);

  const kbd = formatAnswerInline('Press <kbd>Ctrl+C</kbd> to cancel', tokyoNight.text);
  assert.match(kbd, /\[Ctrl\+C\]/);

  const mark = formatAnswerInline('This is <mark>highlighted</mark>', tokyoNight.text);
  assert.match(mark, /highlighted/);

  const underline = formatAnswerInline('This is <u>underlined</u>', tokyoNight.text);
  assert.match(underline, /\x1b\[4m.*underlined.*\x1b\[24m/);
});

test('formatAnswer: renders blockquotes (> quote)', () => {
  const text = '> Đây là một câu trích dẫn quan trọng\n> Dòng trích dẫn thứ hai';
  const rendered = formatAnswer(text);
  assert.match(rendered, /▎ .*Đây là một câu trích dẫn quan trọng/);
  assert.match(rendered, /▎ .*Dòng trích dẫn thứ hai/);
});

test('formatAnswer: renders horizontal rules (---, ***, ___)', () => {
  const text = 'Phần 1\n---\nPhần 2\n***\nPhần 3';
  const rendered = formatAnswer(text);
  assert.match(rendered, /─{10,}/);
});

test('formatAnswer: renders task list checkboxes (- [ ] and - [x])', () => {
  const text = [
    '- [ ] Task chưa hoàn thành',
    '- [x] Task đã hoàn thành',
    '- [X] Task hoa hoàn thành',
    '- Bullet bình thường',
  ].join('\n');
  const rendered = formatAnswer(text);
  assert.match(rendered, /☐ .*Task chưa hoàn thành/);
  assert.match(rendered, /☑ .*Task đã hoàn thành/);
  assert.match(rendered, /☑ .*Task hoa hoàn thành/);
  assert.match(rendered, /Bullet bình thường/);
});

test('viewportLines: renders complete markdown answer in viewport model', () => {
  const model: ViewportModel = {
    offset: 0,
    thinking: '',
    answerStream: '',
    pinned: false,
    collapsed: false,
    entries: [
      {
        kind: 'answer',
        text: [
          '# Báo cáo tổng kết',
          '',
          '> Trích dẫn kết quả nghiệm thu',
          '',
          '---',
          '',
          '- [x] Sửa lỗi *italic* và **bold**',
          '- [ ] Thêm test cho ~~strikethrough~~',
          '',
          'Nhấn <kbd>Ctrl+S</kbd> để lưu. Xem ![Sơ đồ](https://example.com/img.png).',
        ].join('\n'),
      },
    ],
  };

  const lines = viewportLines(model, 80);
  const fullText = lines.join('\n');

  assert.match(fullText, /Báo cáo tổng kết/);
  assert.match(fullText, /▎ .*Trích dẫn kết quả nghiệm thu/);
  assert.match(fullText, /─{10,}/);
  assert.match(fullText, /☑ .*Sửa lỗi/);
  assert.match(fullText, /☐ .*Thêm test/);
  assert.match(fullText, /\[Ctrl\+S\]/);
  assert.match(fullText, /🖼 Sơ đồ/);
});

test('formatAnswer: renders markdown tables with <br> and inline code with aligned borders (no jagged indent)', () => {
  const tableMarkdown = [
    '| Các tệp mã nguồn chính (Source Files) |',
    '| --- |',
    '| • `src/agent/completed-turn-compaction-policy.ts`<br>• `src/agent/context-compactor.ts`<br>• `crates/minus_core/src/context/mod.rs` (Native Rust Core) |',
    '| • `src/agent/context-budget-manager.ts`<br>• `src/agent/request-budget.ts` |',
  ].join('\n');

  const rendered = formatAnswer(tableMarkdown, 80);
  const lines = rendered.split('\n');

  // Verify that <br> is stripped/normalized
  assert.doesNotMatch(rendered, /<br\s*\/?>/i, 'Must not render literal <br> tags');

  // Verify all table lines have matching display width (no jagged right border)
  const tableLines = lines.filter(l => l.includes('│') || l.includes('╭') || l.includes('├') || l.includes('╰'));
  assert.ok(tableLines.length >= 6, 'Must contain top, header, separator, rows, bottom');
  const expectedWidth = displayWidth(tableLines[0]);
  for (const line of tableLines) {
    assert.equal(
      displayWidth(line),
      expectedWidth,
      `Table line must have consistent display width ${expectedWidth}: "${line}"`,
    );
  }
});

