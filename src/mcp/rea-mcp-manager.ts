import os from 'node:os';
import { McpStdioClient } from './mcp-client.js';
import type { McpCallResult, McpToolDescriptor } from './types.js';

export const REA_MCP_PINNED_SPEC = 'rea-agents@6.7.0';

export interface ReaLaunch {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * REA only serves stdio MCP when invoked with the `mcp` subcommand; without it
 * the bin runs the normal CLI and the JSON-RPC handshake never completes.
 */
export function buildReaLaunch(command?: string): ReaLaunch {
  const isWin = os.platform() === 'win32';
  const explicit = command || process.env.REA_MCP_COMMAND;
  if (explicit) {
    // Explicit command must itself be an MCP server entry point.
    return { command: explicit, args: [], shell: isWin && /\.cmd$/i.test(explicit) };
  }
  const spec = process.env.REA_MCP_SPEC || REA_MCP_PINNED_SPEC;
  if (isWin) {
    // Matches REA's documented Windows launcher: cmd.exe avoids EINVAL on .cmd
    // shims and keeps the package spec out of a shell string.
    return { command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', spec, 'mcp'], shell: false };
  }
  return { command: 'npx', args: ['-y', spec, 'mcp'], shell: false };
}

export class ReaMcpManager {
  private client: McpStdioClient | null = null;
  private starting: Promise<void> | null = null;
  private lastIdleTimer: NodeJS.Timeout | null = null;
  private mockCalls: Array<{ tool: string; args: Record<string, any> }> = [];
  private lastError?: string;

  constructor(private options: { mock?: boolean; command?: string } = {}) {
    this.options.mock = options.mock ?? String(process.env.REA_MCP_MOCK || '').toLowerCase() === '1';
  }

  async ensureStarted(): Promise<void> {
    if (this.options.mock) return;
    if (this.client?.isRunning()) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (this.client) {
        await this.client.stop().catch(() => {});
        this.client = null;
      }
      const launch = buildReaLaunch(this.options.command);
      this.client = new McpStdioClient({
        name: 'rea',
        command: launch.command,
        args: launch.args,
        shell: launch.shell,
        timeoutMs: Number(process.env.REA_MCP_TIMEOUT_MS || 360000),
        env: process.env as Record<string, string>,
      });
      try {
        await this.client.start();
      } catch (err: any) {
        this.lastError = err?.message || String(err);
        throw err;
      }
      this.lastError = undefined;
      this.armIdleTimeout();
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private armIdleTimeout(): void {
    if (this.lastIdleTimer) clearTimeout(this.lastIdleTimer);
    const idleMs = Number(process.env.REA_MCP_IDLE_TIMEOUT || 3600000);
    this.lastIdleTimer = setTimeout(() => {
      void this.dispose();
    }, idleMs);
    this.lastIdleTimer.unref?.();
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (this.options.mock) {
      return [
        { name: 'open_binary', description: 'Open a binary target for analysis.' },
        { name: 'binary_overview', description: 'Summarize the open binary.' },
      ];
    }
    await this.ensureStarted();
    return this.client!.listTools();
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<McpCallResult> {
    if (this.options.mock) {
      this.mockCalls.push({ tool: name, args });
      return { success: true, text: `[mock-rea:${name}] ${JSON.stringify(args)}`, content: { mock: true, tool: name, args } };
    }
    await this.ensureStarted();
    this.armIdleTimeout();
    return this.client!.callTool(name, args);
  }

  getMockCalls(): Array<{ tool: string; args: Record<string, any> }> {
    return [...this.mockCalls];
  }

  getLastError(): string | undefined {
    return this.lastError || this.client?.getLastError();
  }

  async dispose(): Promise<void> {
    if (this.lastIdleTimer) clearTimeout(this.lastIdleTimer);
    this.lastIdleTimer = null;
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client = null;
    }
  }
}
