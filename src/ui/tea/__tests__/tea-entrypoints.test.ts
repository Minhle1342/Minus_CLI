import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { parseTeaCommandLine } from '../cli-options.js';
import { startInteractiveTui, runHeadlessCli } from '../index.js';
import { KernelEventBus } from '../../../kernel/kernel.js';

class Input extends EventEmitter { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; } resume() {} pause() {} }
const fixture = () => {
  const input = new Input(); const writes: string[] = [];
  const output = { isTTY: true, columns: 80, rows: 24, write: (text: string) => { writes.push(text); return true; } };
  return { input, output, writes, kernel: { ctx: { events: new KernelEventBus() }, cancelCurrentTask() {} } };
};

test('run/headless prompts cannot become workspace paths; flags and legacy positional workspace survive', () => {
  assert.deepEqual(parseTeaCommandLine(['run', 'fix this', '--workspace', 'project', '--local']), { headless: true, prompt: 'fix this', cliWorkspace: 'project', cliSandbox: 'local' });
  assert.deepEqual(parseTeaCommandLine(['--headless', 'fix', 'this', '--model=gpt']), { headless: true, prompt: 'fix this', cliModel: 'gpt' });
  assert.deepEqual(parseTeaCommandLine(['project', '--docker']), { headless: false, cliWorkspace: 'project', cliSandbox: 'docker' });
});

test('interactive input supports normal prompts, isolated questions, abort and clean quit', async () => {
  const f = fixture(); let aborted = 0;
  const tui = startInteractiveTui(f.kernel, { input: f.input, output: f.output, captureOutput: false, onAbort: () => { aborted++; } });
  const prompt = tui.readPrompt(); f.input.emit('data', 'hello\r'); assert.equal(await prompt, 'hello');
  tui.setBusy(true);
  const question = tui.question('Approve?'); f.input.emit('data', 'n\r'); assert.equal(await question, 'n');
  f.input.emit('data', '\x03'); await new Promise(resolve => setImmediate(resolve)); assert.equal(aborted, 1);
  tui.setBusy(false);
  const waiting = tui.readPrompt(); f.input.emit('data', '\x18q'); assert.equal(await waiting, '/exit');
  assert.equal(f.input.isRaw, false);
  assert.equal(f.kernel.ctx.events.listenerCount('model:thought'), 0);
});

test('explicit authentication status remains visible while the terminal is busy', async () => {
  const f = fixture();
  const tui = startInteractiveTui(f.kernel, { input: f.input, output: f.output });
  try {
    tui.setBusy(true);
    tui.program.send({ type: 'log', text: 'Using existing ChatGPT/Codex credentials.' });
    tui.program.render();
    assert.match(f.writes.join('').replace(/\x1b\[[0-9;]*m/g, ''), /Using existing ChatGPT\/Codex credentials/);
  } finally { tui.close(); }
});

test('headless streams plain answers, propagates failure, unbinds and has no terminal control sequences', async () => {
  const f = fixture(); const writes: string[] = [];
  await runHeadlessCli(f.kernel, 'hello', { captureOutput: false, write: text => writes.push(text), submit: async (_prompt, signal) => { assert.equal(signal.aborted, false); f.kernel.ctx.events.emit('model:final_answer', '\x1b[31manswer\x1b[0m'); } });
  assert.equal(writes.join(''), 'answer\n');
  assert.equal(f.kernel.ctx.events.listenerCount('model:final_answer'), 0);
  await assert.rejects(runHeadlessCli(f.kernel, 'hello', { captureOutput: false, submit: async () => { throw new Error('failed'); } }), /failed/);
});


test('run command is consumed once and prompt can start with run', () => {
  assert.equal(parseTeaCommandLine(['run', 'run', 'tests']).prompt, 'run tests');
});

test('stopping Program restores the owning terminal capture and resolves pending input', async () => {
  const f = fixture(); const original = process.stdout.write;
  const tui = startInteractiveTui(f.kernel, { input: f.input, output: f.output });
  const waiting = tui.readPrompt();
  tui.program.stop();
  const restored = process.stdout.write === original;
  tui.close();
  assert.equal(restored, true);
  assert.equal(await waiting, '/exit');
});

test('headless diagnostics remain on stderr and stdout contains only answers', async () => {
  const f = fixture(); const out: string[] = [], err: string[] = [];
  const originalOut = process.stdout.write, originalErr = process.stderr.write;
  process.stdout.write = ((text: string) => { out.push(text); return true; }) as typeof originalOut;
  process.stderr.write = ((text: string) => { err.push(text); return true; }) as typeof originalErr;
  try {
    await runHeadlessCli(f.kernel, 'hello', { submit: async () => {
      process.stderr.write('diagnostic');
      f.kernel.ctx.events.emit('model:final_answer', 'answer');
    } });
  } finally { process.stdout.write = originalOut; process.stderr.write = originalErr; }
  assert.equal(out.join(''), 'answer\n');
  assert.equal(err.join(''), 'diagnostic');
});
