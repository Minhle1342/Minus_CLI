import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Cmd, Msg, RootModel, Sub } from '../types.js';
import { update, view } from '../models/root-model.js';
import { KeyDecoder } from './input.js';
export interface TerminalInput extends EventEmitter { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown; resume(): unknown; pause(): unknown }
export interface TerminalOutput { isTTY?: boolean; columns?: number; rows?: number; write(text: string): unknown; on?(event: string, listener: () => void): unknown; off?(event: string, listener: () => void): unknown }
export interface ProgramOptions { input: TerminalInput; output: TerminalOutput; signals?: EventEmitter; execute(cmd: Cmd): Promise<void> | void; subscriptions?: Sub[]; mouse?: boolean; onStop?(): void }

/** Single update loop; terminal writes happen only on the frame scheduler. */
export class Program {
  model: RootModel;
  private active = false;
  private suspended = false;
  private dirty = true;
  private wasRaw = false;
  private timer?: ReturnType<typeof setInterval>;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private backpressure = false;
  private readonly keys = new KeyDecoder();
  private readonly utf8 = new StringDecoder('utf8');
  private disposers: (() => void)[] = [];
  private readonly signals: EventEmitter;
  constructor(model: RootModel, private readonly options: ProgramOptions) { this.model = model; this.signals = options.signals || process; }
  private readonly onData = (chunk: Buffer | string) => {
    clearTimeout(this.escapeTimer);
    for (const msg of this.keys.feed(typeof chunk === 'string' ? chunk : this.utf8.write(chunk))) this.send(msg);
    this.escapeTimer = setTimeout(() => { for (const msg of this.keys.flushEscape()) this.send(msg); }, 25);
  };
  private readonly onResize = () => this.send({ type: 'resize', width: this.options.output.columns || 80, height: this.options.output.rows || 24 });
  private readonly onInterrupt = () => this.send({ type: 'key', key: 'ctrl+c', now: Date.now() });
  private readonly onTerminate = () => this.send({ type: 'action', action: 'quit' });
  private readonly onExit = () => this.stop();
  private readonly onDrain = () => { this.backpressure = false; };
  start(): void {
    if (this.active) return;
    if (!this.options.input.isTTY || !this.options.output.isTTY || !this.options.input.setRawMode) throw new Error('Interactive TUI requires a TTY. Use minus run <prompt>.');
    this.wasRaw = this.options.input.isRaw || false;
    this.active = true;
    try {
      this.enter();
      this.options.output.on?.('resize', this.onResize);
      this.options.output.on?.('drain', this.onDrain);
      this.signals.on('SIGINT', this.onInterrupt); this.signals.on('SIGTERM', this.onTerminate); this.signals.on('exit', this.onExit); this.signals.on('uncaughtExceptionMonitor', this.onExit);
      this.disposers = (this.options.subscriptions || []).map(subscribe => subscribe(msg => this.send(msg)));
      this.onResize(); this.render();
    } catch (error) { this.stop(); throw error; }
  }
  private enter(): void {
    this.options.output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h' + (this.options.mouse ? '\x1b[?1000h\x1b[?1006h' : ''));
    this.options.input.setRawMode?.(true); this.options.input.on('data', this.onData); this.options.input.resume();
    this.timer = setInterval(() => {
      if (this.model.status.busy || this.model.leaderUntil) this.send({ type: 'tick', now: Date.now() });
      this.render();
    }, 1000 / 60);
  }
  private leave(): void {
    clearInterval(this.timer); clearTimeout(this.escapeTimer); this.options.input.off('data', this.onData);
    try { this.options.input.setRawMode?.(this.wasRaw); } finally {
      this.options.output.write((this.options.mouse ? '\x1b[?1000l\x1b[?1006l' : '') + '\x1b[?2004l\x1b[?25h\x1b[?1049l');
    }
  }
  send(msg: Msg): void {
    if (!this.active) return;
    const [model, commands] = update(msg, this.model); this.dirty ||= model !== this.model; this.model = model;
    for (const command of commands) {
      Promise.resolve().then(() => this.active ? this.options.execute(command) : undefined).catch(error => this.send({ type: 'log', text: `Error: ${error instanceof Error ? error.message : String(error)}` }));
    }
  }
  render(): void {
    if (!this.active || this.suspended || !this.dirty || this.backpressure) return;
    const frame = view(this.model).split('\n').map((line, i) => `\x1b[${i + 1};1H${line}\x1b[K`).join('');
    this.dirty = false;
    try { this.backpressure = this.options.output.write(frame) === false; } catch (error) { this.stop(); throw error; }
  }
  suspend(): void { if (this.active && !this.suspended) { this.suspended = true; this.leave(); } }
  resume(): void { if (this.active && this.suspended) { this.suspended = false; this.dirty = true; this.backpressure = false; this.enter(); this.onResize(); this.render(); } }
  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.options.output.off?.('resize', this.onResize); this.options.output.off?.('drain', this.onDrain);
    this.signals.off('SIGINT', this.onInterrupt); this.signals.off('SIGTERM', this.onTerminate); this.signals.off('exit', this.onExit); this.signals.off('uncaughtExceptionMonitor', this.onExit);
    try { if (!this.suspended) this.leave(); } finally {
      this.options.input.pause(); this.options.onStop?.();
    }
  }
}
