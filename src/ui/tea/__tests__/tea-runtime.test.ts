import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Program } from '../core/program.js';
import { KeyDecoder } from '../core/input.js';
import { createRootModel } from '../models/root-model.js';
import { openExternalEditor } from '../external-editor.js';
import { readFile, writeFile } from 'node:fs/promises';

class Input extends EventEmitter {
  isTTY = true; isRaw = false;
  setRawMode(raw: boolean) { this.isRaw = raw; return this; }
  resume() { return this; }
  pause() { return this; }
}
const fixture = () => {
  const input = new Input(); const writes: string[] = []; const signals = new EventEmitter();
  const output = { isTTY: true, columns: 80, rows: 24, write: (text: string) => { writes.push(text); return true; } };
  const program = new Program(createRootModel(), { input, output, signals, execute: async () => {} });
  return { input, output, writes, signals, program };
};

test('program owns alternate screen/raw mode, coalesces tokens, restores all listeners', async () => {
  const { program, input, writes, signals } = fixture();
  program.start();
  assert.equal(input.isRaw, true);
  assert.ok(writes.join('').includes('\x1b[?1049h'));
  const before = writes.length;
  for (let i = 0; i < 1000; i++) program.send({ type: 'kernel', event: 'model:thought', args: ['x'] });
  assert.equal(writes.length, before);
  program.render();
  assert.equal(writes.length, before + 1);
  assert.equal(program.model.viewport.thinking.length, 1000);
  program.stop(); program.stop();
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.ok(writes.join('').endsWith('\x1b[?25h\x1b[?1049l'));
});

test('decoder handles fragmented keys and paste without submitting pasted newlines', () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.feed('\x1b['), []);
  assert.equal(decoder.feed('A')[0].key, 'up');
  assert.deepEqual(decoder.feed('\x1b[200~first\n'), []);
  const paste = decoder.feed('second\x1b[201~')[0];
  assert.equal(paste.key, 'paste'); assert.equal(paste.text, 'first\nsecond');
  assert.equal(decoder.feed('\x18')[0].key, 'ctrl+x');
  assert.equal(decoder.feed('\x00')[0].key, 'ctrl+space');
});

test('external editor reads changes, restores terminal on child failure and removes temporary file', async () => {
  let suspended = 0, restored = 0, file = '';
  const terminal = { suspend: () => { suspended++; }, resume: () => { restored++; } };
  const result = await openExternalEditor('draft', terminal, { editor: 'editor --wait', launch: async (_command, args) => {
    file = args.at(-1)!; assert.equal(await readFile(file, 'utf8'), 'draft'); await writeFile(file, 'edited\ntext');
  } });
  assert.equal(result, 'edited\ntext');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await assert.rejects(openExternalEditor('draft', terminal, { editor: 'editor', launch: async () => { throw new Error('child failed'); } }), /child failed/);
  assert.equal(suspended, 2); assert.equal(restored, 2);
});

test('suspending and resuming program preserves task state and redraws after resize', () => {
  const { program, input, writes } = fixture(); program.start();
  program.send({ type: 'compose', text: 'draft' });
  program.suspend(); assert.equal(input.isRaw, false);
  program.send({ type: 'resize', width: 60, height: 10 });
  const count = writes.length; program.render(); assert.equal(writes.length, count);
  program.resume(); assert.equal(input.isRaw, true);
  assert.equal(program.model.composer.value, 'draft');
  program.stop();
});
