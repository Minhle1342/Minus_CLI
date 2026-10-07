import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI, getVisibleWidth, stripAnsiForDisplay } from './cli-ui.js';
import { compactionStatus, formatCompactionStatus } from './compaction-status.js';

test('turn and step transitions update one reactive status rather than append history', () => {
  const received: string[] = [];
  const unsubscribe = compactionStatus.subscribe((status) => { if (status) received.push(formatCompactionStatus(status)); });
  try {
    CLI.startCompaction('turn');
    CLI.renderAutoCompactionNotice(512, 1200);
    assert.deepEqual(received, ['Đang compact turn…', 'Compact turn hoàn tất · −512 tok · còn 1200 tok']);
    CLI.startCompaction('step');
    CLI.finishCompaction('skipped');
    assert.match(received.at(-1)!, /step không áp dụng/);
    CLI.finishCompaction('failed');
    assert.equal(received.length, 4, 'cleanup must not overwrite a completed status');
  } finally { unsubscribe(); compactionStatus.set(null); }
});

test('TTY overwrites the running row and emits exactly one final newline, within terminal width', () => {
  const output: string[] = [];
  const write = process.stdout.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 30 });
  process.stdout.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as typeof write;
  try {
    CLI.startCompaction('step');
    CLI.renderAutoCompactionNotice(10000, 20000);
    assert.equal(output.join('').split('\n').length - 1, 1);
    assert.ok(output[0].startsWith('\r\x1b[2K'));
    assert.ok(output[1].startsWith('\r\x1b[2K'));
    for (const chunk of output) assert.ok(getVisibleWidth(stripAnsiForDisplay(chunk).replace(/[\r\n]/g, '')) <= 29);
  } finally {
    process.stdout.write = write;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty); else delete (process.stdout as any).isTTY;
    if (columns) Object.defineProperty(process.stdout, 'columns', columns); else delete (process.stdout as any).columns;
    compactionStatus.set(null);
  }
});

test('Ink subscriptions suppress direct terminal writes and failures never report completion', () => {
  const write = process.stdout.write;
  let writes = 0;
  const unsubscribe = compactionStatus.subscribe(() => {});
  process.stdout.write = (() => { writes++; return true; }) as typeof write;
  try {
    CLI.startCompaction('turn');
    CLI.finishCompaction('failed');
    assert.equal(writes, 0);
    assert.match(formatCompactionStatus(compactionStatus.get()!), /thất bại/);
  } finally { process.stdout.write = write; unsubscribe(); compactionStatus.set(null); }
});
