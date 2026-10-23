import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { createDiffViewer, diffView, visibleDiffLines } from '../models/diff-model.js';
import { createFileView, fileView, loadFileView, MAX_FILE_LINES } from '../models/file-view-model.js';
import { formatAnswer, highlightCode } from '../models/viewport-model.js';
import { color, stripTerminalControls, tokyoNight } from '../styles/theme.js';
import type { Msg } from '../types.js';

const key = (k: string, text?: string): Msg => ({ type: 'key', key: k, text, now: 10 });
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

test('diff renders only the visible window and keeps header stats', () => {
  const text = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ...Array.from({ length: 500 }, (_, i) => `+line ${i}`)].join('\n');
  const rows = diffView({ ...createDiffViewer(), text }, 80, 10).map(plain);
  assert.equal(rows.length, 10);
  assert.match(rows[0], /Hunk 1\/1 · \+500 -0/);
  assert.match(rows[4], /line 0/);
  assert.doesNotMatch(rows.join('\n'), /line 100/);
  assert.match(plain(diffView({ ...createDiffViewer(), text, offset: 100 }, 80, 10)[1]), /line 97/);
});

test('collapsed hunks drop their lines from the scroll model', () => {
  const text = '@@ -1 +1 @@\n+one\n@@ -9 +9 @@\n+two';
  assert.deepEqual(visibleDiffLines({ ...createDiffViewer(), text, collapsed: [0] }), ['@@ -1 +1 @@', '@@ -9 +9 @@', '+two']);
});

test('file view shows line numbers and clamps the offset', () => {
  const text = Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const rows = fileView({ ...createFileView(), visible: true, path: 'src/a.ts', text, offset: 999 }, 60, 6).map(plain);
  assert.equal(rows.length, 6);
  assert.match(rows[0], /file · src\/a\.ts/i);
  assert.match(rows[1], /^46│const v45 = 45;/);
  assert.match(rows[5], /^50│const v49 = 49;/);
});

test('loadFileView refuses escapes, caps lines, and flags truncation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-file-'));
  try {
    fs.writeFileSync(path.join(root, 'big.ts'), Array.from({ length: MAX_FILE_LINES + 3 }, (_, i) => `l${i}`).join('\n'));
    const view = loadFileView(root, 'big.ts');
    assert.equal(view.truncated, true);
    assert.equal(view.text.split('\n').length, MAX_FILE_LINES);
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    assert.throws(() => loadFileView(root, 'bin.dat'), /Binary file/);
    assert.throws(() => loadFileView(root, '../outer.ts'), /outside workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('highlight caps giant lines and long code blocks', () => {
  const long = 'const x = 1; // ' + 'a'.repeat(600);
  assert.equal(highlightCode(long), color(tokyoNight.text, long));
  const block = '```ts\n' + Array.from({ length: 2005 }, () => 'const x = 1;').join('\n') + '\n```';
  const lines = formatAnswer(block, 80).split('\n');
  assert.equal(lines[lines.length - 1], color(tokyoNight.text, 'const x = 1;'));
});

test('sidebar selection opens files and the file overlay closes on Escape', () => {
  let [model] = update({ type: 'metadata', data: { files: ['src/a.ts', 'src/b.ts'] } }, createRootModel({ width: 100, height: 30 }));
  [model] = update({ type: 'action', action: 'sidebar' }, model);
  assert.equal(model.focus, 'sidebar');
  assert.equal(model.sidebar.visible, true);
  [model] = update(key('down'), model);
  const [, commands] = update(key('enter'), model);
  assert.deepEqual(commands, [{ type: 'file-open', path: 'src/b.ts' }]);
  [model] = update({ type: 'file', path: 'src/b.ts', text: 'const b = 1;' }, model);
  assert.equal(model.focus, 'file');
  assert.equal(model.file.visible, true);
  assert.match(stripTerminalControls(view(model)), /src\/b\.ts/);
  [model] = update(key('escape'), model);
  assert.equal(model.file.visible, false);
  assert.equal(model.focus, 'composer');
});
