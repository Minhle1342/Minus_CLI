import assert from 'node:assert/strict';
import { test } from 'node:test';
import stringWidth from 'string-width';
import { createRootModel, update, view } from '../models/root-model.js';
import { stripTerminalControls } from '../styles/theme.js';

test('views fit 80x24, 120x40 and tiny/resized terminals with Unicode and ANSI', () => {
  for (const [width, height] of [[80, 24], [120, 40], [9, 3], [1, 1], [0, 0]]) {
    let model = createRootModel({ width, height });
    [model] = update({ type: 'log', text: '\x1b[31mXin chào 👩‍💻 中文\x1b[0m\n' + 'long '.repeat(50) }, model);
    const rendered = view(model);
    const lines = rendered.split('\n');
    assert.equal(lines.length, Math.max(1, height));
    for (const line of lines) assert.ok(stringWidth(line) <= Math.max(1, width), line);
    assert.equal(stripTerminalControls(rendered).includes('\x1b'), false);
  }
});

test('view is pure and palette/sidebar/diff render within constraints', () => {
  let model = createRootModel({ width: 120, height: 40 });
  [model] = update({ type: 'action', action: 'sidebar' }, model);
  [model] = update({ type: 'diff', text: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+const x = 1;' }, model);
  [model] = update({ type: 'action', action: 'diff' }, model);
  const before = JSON.stringify(model);
  assert.match(view(model), /const x/);
  assert.equal(JSON.stringify(model), before);
  [model] = update({ type: 'action', action: 'palette' }, model);
  assert.match(view(model), /Command palette/);
});
