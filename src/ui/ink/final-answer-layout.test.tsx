import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { App } from './components/App.js';
import { TuiStore } from './tui-store.js';
import { stripAnsiForDisplay, getVisibleWidth } from '../cli-ui.js';

describe('Final answer rendered by Ink', () => {
  for (const columns of [24, 60, 80, 120]) {
    it(`preserves multi-row table data and long prose at ${columns} terminal columns`, () => {
      const store = new TuiStore();
      const longPath = 'src/' + 'long_path_'.repeat(20) + 'END.ts';
      store.dispatch({ type: 'FINAL_ANSWER', answer: [
        '| Tool | Path | Status |',
        '|---|---|---|',
        `| read_file | ${longPath} | Ready |`,
        '| write_file | other.ts | Done |',
        '',
        'A long ordinary paragraph '.repeat(12) + 'PROSE_END',
      ].join('\n') });

      const rendered = stripAnsiForDisplay(renderToString(<App store={store} />, { columns }));
      const lines = rendered.split('\n');
      const firstRecord = lines.findIndex(line => line.includes('[1]'));
      const lastAnswer = lines.findIndex((line, index) => index > firstRecord && line.includes('└'));
      assert.ok(firstRecord >= 0 && lastAnswer > firstRecord);
      const answerLines = lines.slice(firstRecord, lastAnswer);
      for (const line of answerLines) assert.ok(getVisibleWidth(line) <= columns, `Overflow: ${line}`);
      const content = answerLines.map(line => line.replace(/^│\s?/, '').replace(/\s?│$/, '')).join('').replace(/\s/g, '');
      assert.ok(content.includes(longPath), 'No part of a long path may be truncated');
      assert.ok(content.includes('read_file'));
      assert.ok(content.includes('write_file'));
      assert.ok(content.includes('[2]'));
      assert.ok(content.includes('PROSE_END'), 'Normal prose must still wrap rather than truncate');
    });
  }
});
