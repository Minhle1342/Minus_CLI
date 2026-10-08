import { EventEmitter } from 'node:events';
import type { KernelEventBus } from '../../kernel/kernel.js';
import { copyToClipboard } from './clipboard.js';
import { compactionStatus } from '../compaction-status.js';
import { Program, type TerminalInput, type TerminalOutput } from './core/program.js';
import { createRootModel } from './models/root-model.js';
import { KernelTEAAdapter } from './kernel-bridge.js';
import { openExternalEditor } from './external-editor.js';
import { stripTerminalControls } from './styles/theme.js';
import type { Cmd, Completion, Mode, PaletteItem, SidebarModel, TranscriptEntry, PermissionCard } from './types.js';
export { parseTeaCommandLine } from './cli-options.js';
export { Table, renderTable, formatSubmitSolutionTable } from './styles/table.js';
export interface TeaKernel { ctx: { events: KernelEventBus }; cancelCurrentTask?(): void }
export interface InteractiveOptions {
  input?: TerminalInput; output?: TerminalOutput; captureOutput?: boolean; mouse?: boolean;
  commands?: PaletteItem[]; metadata?: Partial<SidebarModel>; transcript?: TranscriptEntry[];
  onAbort?(): void; onQuit?(): void; onCompact?(): Promise<void>;
  onMode?(mode: Mode): void; complete?(value: string, cursor: number): Completion[] | Promise<Completion[]>;
}

/** Async input port for command handlers; terminal ownership stays in Program. */
export class TeaTerminal extends EventEmitter {
  readonly program: Program;
  private closed = false;
  private pending?: (text: string) => void;
  private questionResolver?: (text: string | undefined) => void;
  private queued: string[] = [];
  private restoreOutput?: () => void;
  constructor(private readonly kernel: TeaKernel, private readonly options: InteractiveOptions) {
    super();
    const input = options.input || process.stdin;
    const terminal = options.output || process.stdout;
    const rawWrite = terminal.write.bind(terminal);
    const output: TerminalOutput = { get isTTY() { return terminal.isTTY; }, get columns() { return terminal.columns; }, get rows() { return terminal.rows; }, write: rawWrite, on: terminal.on?.bind(terminal), off: terminal.off?.bind(terminal) };
    const model = createRootModel({ width: terminal.columns, height: terminal.rows, commands: options.commands });
    model.sidebar = { ...model.sidebar, ...options.metadata }; model.viewport.entries = options.transcript || [];
    this.program = new Program(model, { input, output, mouse: options.mouse ?? true, onStop: () => this.close(), execute: cmd => this.execute(cmd), subscriptions: [send => new KernelTEAAdapter(kernel.ctx.events, send).bind(), send => compactionStatus.subscribe(status => send({ type: 'compaction', status }))] });
    try {
      this.program.start();
      if (options.captureOutput !== false) this.restoreOutput = captureTerminalOutput(text => {
        if (!this.program.model.status.busy) this.program.send({ type: 'log', text });
      }, text => this.program.send({ type: 'log', text }));
      this.program.send({ type: 'compaction', status: compactionStatus.get() });
    } catch (error) { this.close(); throw error; }
  }
  get model() { return this.program.model; }
  get line(): string { return this.model.composer.value; }
  set line(value: string) { this.program.send({ type: 'compose', text: value }); }
  get cursor(): number { return this.model.composer.cursorOffset; }
  resetComposer(): void { this.line = ''; }
  setBusy(busy: boolean): void { this.program.send({ type: 'busy', busy }); }
  setMetadata(data: Partial<SidebarModel>): void { this.program.send({ type: 'metadata', data }); }
  setDiff(text: string, reveal = false): void { this.program.send({ type: 'diff', text, reveal }); }
  clear(): void { this.program.send({ type: 'action', action: 'clear' }); }
  readPrompt(): Promise<string> {
    if (this.closed) return Promise.resolve('/exit');
    const next = this.queued.shift(); if (next !== undefined) return Promise.resolve(next);
    return new Promise(resolve => { this.pending = resolve; });
  }
  question(prompt: string, signal?: AbortSignal): Promise<string> {
    return this.ask(prompt, signal).then(value => value ?? 'n');
  }
  ask(prompt: string, signal?: AbortSignal, permission?: PermissionCard): Promise<string | undefined> {
    if (this.closed || signal?.aborted) return Promise.resolve(undefined);
    if (this.questionResolver) throw new Error('A terminal question is already active');
    this.program.send({ type: 'question', prompt: stripTerminalControls(prompt), active: true, permission });
    return new Promise(resolve => {
      const cancel = () => this.answer(undefined);
      this.questionResolver = value => { signal?.removeEventListener('abort', cancel); this.program.send({ type: 'question', prompt: '', active: false }); resolve(value); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  dismissQuestion(): void { this.answer(undefined); }
  private answer(value: string | undefined): void { const resolve = this.questionResolver; this.questionResolver = undefined; resolve?.(value); }
  private submit(text: string): void {
    if (this.pending) { const resolve = this.pending; this.pending = undefined; resolve(text); }
    else if (this.model.status.busy) this.emit('line', text);
    else this.queued.push(text);
  }
  private async execute(cmd: Cmd): Promise<void> {
    switch (cmd.type) {
      case 'copy': await copyToClipboard(cmd.text); this.program.send({ type: 'notice', text: 'Copied selection to clipboard' }); break;
      case 'submit': this.submit(cmd.text); break;
      case 'answer': this.answer(cmd.text === '\x03' ? undefined : cmd.text); break;
      case 'abort': (this.options.onAbort || (() => this.kernel.cancelCurrentTask?.()))(); break;
      case 'quit': this.options.onQuit?.(); this.close(); break;
      case 'compact': if (this.options.onCompact) await this.options.onCompact(); else this.submit('/context compact'); break;
      case 'editor': {
        // Restore primary-screen writes as well as raw mode while the editor owns the terminal.
        const terminal = { suspend: () => { this.restoreOutput?.(); this.restoreOutput = undefined; this.program.suspend(); }, resume: () => {
          if (this.closed) return;
          this.program.resume();
          if (this.options.captureOutput !== false) this.restoreOutput = captureTerminalOutput(text => this.program.send({ type: 'log', text }));
        } };
        const text = await openExternalEditor(this.line, terminal); this.line = text; break;
      }
      case 'complete': {
        const completions = await this.options.complete?.(cmd.value, cmd.cursor) || [];
        // A delayed completion must not overwrite a newer edit or an isolated question.
        if (this.line === cmd.value && this.cursor === cmd.cursor && !this.model.question.active) this.program.send({ type: 'completions', values: completions }); break;
      }
      case 'mode': this.options.onMode?.(cmd.mode); break;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.answer(undefined);
    this.restoreOutput?.(); this.restoreOutput = undefined;
    this.program.stop();
    this.pending?.('/exit'); this.pending = undefined; this.queued = []; this.emit('close');
  }
}
export function startInteractiveTui(kernel: TeaKernel, options: InteractiveOptions = {}): TeaTerminal { return new TeaTerminal(kernel, options); }
export const launchInteractiveTui = startInteractiveTui;

/** Legacy presentation is captured as messages; ANSI cursor commands never reach the screen. */
export function captureTerminalOutput(stdout: (text: string) => void, stderr = stdout): () => void {
  const originalOut = process.stdout.write; const originalErr = process.stderr.write;
  const makeWriter = (send: (text: string) => void) => ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = stripTerminalControls(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'), true);
    if (text.trim()) send(text);
    const done = typeof encoding === 'function' ? encoding : callback; if (done) queueMicrotask(() => done(null)); return true;
  }) as typeof process.stdout.write;
  process.stdout.write = makeWriter(stdout); process.stderr.write = makeWriter(stderr);
  return () => { process.stdout.write = originalOut; process.stderr.write = originalErr; };
}
export function plainTerminalOutput(): () => void {
  const out = process.stdout.write; const err = process.stderr.write;
  const writer = (original: typeof out, stream: NodeJS.WriteStream) => ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = stripTerminalControls(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return original.call(stream, text, 'utf8', typeof encoding === 'function' ? encoding : callback);
  }) as typeof out;
  process.stdout.write = writer(out, process.stdout); process.stderr.write = writer(err, process.stderr);
  return () => { process.stdout.write = out; process.stderr.write = err; };
}
export interface HeadlessOptions { submit(prompt: string, signal: AbortSignal): Promise<void>; signal?: AbortSignal; captureOutput?: boolean; write?(text: string): void }
export async function runHeadlessCli(kernel: TeaKernel, prompt: string, options: HeadlessOptions): Promise<void> {
  if (!prompt.trim()) throw new Error('Headless mode requires a prompt (minus run <prompt>, --headless <prompt>, or piped stdin).');
  const rawWrite = process.stdout.write.bind(process.stdout);
  const rawErrorWrite = process.stderr.write.bind(process.stderr);
  const write = options.write || ((text: string) => { rawWrite(text); });
  const controller = new AbortController();
  const abort = () => { controller.abort(); kernel.cancelCurrentTask?.(); };
  const onSignal = () => abort();
  const onAnswer = (answer: string) => write(stripTerminalControls(answer) + '\n');
  kernel.ctx.events.on('model:final_answer', onAnswer);
  options.signal?.addEventListener('abort', onSignal, { once: true });
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const restore = options.captureOutput !== false ? captureTerminalOutput(() => {}, text => { rawErrorWrite(stripTerminalControls(text)); }) : undefined;
  try {
    if (options.signal?.aborted) abort();
    await options.submit(prompt, controller.signal);
    if (controller.signal.aborted) throw new Error('Headless task cancelled');
  } finally {
    restore?.(); kernel.ctx.events.off('model:final_answer', onAnswer);
    options.signal?.removeEventListener('abort', onSignal); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}
export async function readHeadlessPrompt(prompt?: string): Promise<string> {
  if (prompt) return prompt;
  if (process.stdin.isTTY) return '';
  let text = ''; for await (const chunk of process.stdin) text += chunk.toString(); return text;
}
