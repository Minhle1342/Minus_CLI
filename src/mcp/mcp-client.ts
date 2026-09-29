import { spawn, type ChildProcess } from 'node:child_process';
import type { McpCallResult, McpServerConfig, McpToolDescriptor } from './types.js';

/**
 * Minimal MCP stdio client for `microsoft/playwright-mcp`.
 * Speaks JSON-RPC 2.0 over stdin/stdout with Content-Length-agnostic
 * newline-delimited framing (playwright-mcp supports plain JSON lines).
 *
 * Design: fail-closed. Any spawn/JSON error returns { success:false }
 * instead of throwing, so AgentLoop can fall back to web_fetch/computer.
 */
export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private toolsCache: McpToolDescriptor[] | null = null;
  private lastError?: string;

  constructor(private config: McpServerConfig) {}

  get name(): string {
    return this.config.name;
  }

  isRunning(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    await new Promise<void>((resolve, reject) => {
      try {
        this.proc = spawn(this.config.command, this.config.args, {
          env: { ...process.env, ...this.config.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: this.config.shell ?? false,
          windowsHide: true,
        });
      } catch (err: any) {
        this.lastError = err?.message || String(err);
        reject(err);
        return;
      }
      const p = this.proc!;
      p.stdout?.on('data', (d) => this.onData(String(d)));
      p.stderr?.on('data', (d) => {
        this.lastError = String(d).slice(0, 500);
      });
      p.on('error', (err) => {
        const code = (err as any)?.code;
        this.lastError = code
          ? `spawn ${this.config.command} failed (${code}): ${(err as any)?.message || err}`
          : ((err as any)?.message || String(err));
        reject(err);
      });
      p.on('exit', () => {
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('MCP server exited'));
        }
        this.pending.clear();
        this.proc = null;
      });
      // Give the process a tick to fail fast on ENOENT.
      setTimeout(() => resolve(), 300);
    });
    // MCP handshake: initialize + notifications/initialized
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'minus-cli', version: '1.0.0' },
    }).catch((e) => {
      throw new Error(`MCP initialize failed (${this.config.name}): ${(e as any)?.message || e}`);
    });
    this.notify('notifications/initialized', {}).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.toolsCache = null;
    const p = this.proc;
    this.proc = null;
    if (p && !p.killed) {
      try { p.kill(); } catch { /* noop */ }
    }
  }

  async listTools(forceRefresh = false): Promise<McpToolDescriptor[]> {
    if (this.toolsCache && !forceRefresh) return this.toolsCache;
    const res = await this.request('tools/list', {});
    const tools = (res?.tools || []) as McpToolDescriptor[];
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<McpCallResult> {
    try {
      if (!this.isRunning()) await this.start();
      const res = await this.request('tools/call', { name, arguments: args });
      if (res?.isError) {
        const text = flattenContent(res?.content).slice(0, 8000);
        return { success: false, error: text || `MCP tool ${name} failed`, errorCode: 'MCP_TOOL_ERROR', content: res?.content };
      }
      const text = flattenContent(res?.content);
      return { success: true, content: res?.content, text: text.slice(0, 20000) };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err), errorCode: 'MCP_TRANSPORT_ERROR' };
    }
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  private notify(method: string, params: any): Promise<void> {
    return new Promise((resolve) => {
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
      try { this.proc?.stdin?.write(msg + '\n', () => resolve()); }
      catch { resolve(); }
    });
  }

  private request(method: string, params: any): Promise<any> {
    const id = ++this.reqId;
    const timeoutMs = this.config.timeoutMs || 60000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout (${method} ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.proc?.stdin?.write(msg + '\n', (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error?.message || JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
    }
  }
}

function flattenContent(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? JSON.stringify(c)))).join('\n');
  }
  if (typeof content === 'object') return (content as any).text || JSON.stringify(content);
  return String(content);
}
