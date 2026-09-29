import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpStdioClient } from './mcp-client.js';
import type { McpCallResult, McpToolDescriptor } from './types.js';

export interface PlaywrightMcpOptions {
  /** Set PLAYWRIGHT_MCP_MOCK=1 in tests to avoid spawning npx. */
  mock?: boolean;
  headless?: boolean;
  isolated?: boolean;
  browser?: string;
  timeoutActionMs?: number;
  timeoutNavigationMs?: number;
  outputDir?: string;
  allowedOrigins?: string;
  blockedOrigins?: string;
  viewport?: string;
  command?: string;
  serverArgs?: string[];
}

/**
 * McpManager — owns the playwright-mcp stdio lifecycle + guardrails.
 * - Default: --isolated --headless, ephemeral user-data-dir under scratch/
 * - Mock mode: deterministic payloads for unit tests (no network, no npx)
 * - URL allowlist: blocks file:// and non-http(s) before forwarding to MCP
 */
export class McpManager {
  private client: McpStdioClient | null = null;
  private starting: Promise<void> | null = null;
  private lastIdleTimer: NodeJS.Timeout | null = null;
  readonly options: Required<Omit<PlaywrightMcpOptions, 'command' | 'serverArgs'>> & Pick<PlaywrightMcpOptions, 'command' | 'serverArgs'>;
  private mockCalls: Array<{ tool: string; args: Record<string, any> }> = [];

  constructor(opts: PlaywrightMcpOptions = {}) {
    const outputDir = opts.outputDir || process.env.PLAYWRIGHT_MCP_OUTPUT_DIR || path.join(process.cwd(), 'scratch', 'browser');
    this.options = {
      mock: opts.mock ?? String(process.env.PLAYWRIGHT_MCP_MOCK || '').toLowerCase() === '1',
      headless: opts.headless ?? String(process.env.PLAYWRIGHT_MCP_HEADLESS ?? '1') !== '0',
      isolated: opts.isolated ?? String(process.env.PLAYWRIGHT_MCP_ISOLATED ?? '1') !== '0',
      browser: opts.browser || process.env.PLAYWRIGHT_MCP_BROWSER || 'chromium',
      timeoutActionMs: opts.timeoutActionMs || Number(process.env.PLAYWRIGHT_MCP_TIMEOUT_ACTION || 5000),
      timeoutNavigationMs: opts.timeoutNavigationMs || Number(process.env.PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION || 60000),
      outputDir,
      allowedOrigins: opts.allowedOrigins || process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS || '',
      blockedOrigins: opts.blockedOrigins || process.env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS || '',
      viewport: opts.viewport || process.env.PLAYWRIGHT_MCP_VIEWPORT || '1280x720',
      command: opts.command,
      serverArgs: opts.serverArgs,
    };
  }

  isMock(): boolean {
    return this.options.mock;
  }

  getMockCalls(): Array<{ tool: string; args: Record<string, any> }> {
    return [...this.mockCalls];
  }

  /** Validate URL before it reaches the browser. */
  checkUrlAllowed(rawUrl: string): { allowed: boolean; reason?: string } {
    const url = String(rawUrl || '').trim();
    if (!url) return { allowed: false, reason: 'Empty URL' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `Malformed URL: ${url}` };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { allowed: false, reason: `Only http(s) allowed, got ${parsed.protocol}` };
    }
    const origin = parsed.origin;
    if (this.options.blockedOrigins) {
      const blocked = this.options.blockedOrigins.split(';').map((s) => s.trim()).filter(Boolean);
      if (blocked.some((b) => origin.includes(b) || parsed.hostname.includes(b))) {
        return { allowed: false, reason: `Origin blocked by PLAYWRIGHT_MCP_BLOCKED_ORIGINS: ${origin}` };
      }
    }
    if (this.options.allowedOrigins) {
      const allowed = this.options.allowedOrigins.split(';').map((s) => s.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.some((a) => origin.includes(a) || parsed.hostname.includes(a))) {
        return { allowed: false, reason: `Origin not in PLAYWRIGHT_MCP_ALLOWED_ORIGINS: ${origin}` };
      }
    }
    return { allowed: true };
  }

  buildServerArgs(): string[] {
    if (this.options.serverArgs) return this.options.serverArgs;
    const args = ['-y', '@playwright/mcp@latest'];
    if (this.options.headless) args.push('--headless');
    if (this.options.isolated) args.push('--isolated');
    if (this.options.browser && this.options.browser !== 'chromium') args.push('--browser', this.options.browser);
    args.push('--viewport-size', this.options.viewport);
    args.push('--timeout-action', String(this.options.timeoutActionMs));
    args.push('--timeout-navigation', String(this.options.timeoutNavigationMs));
    args.push('--output-dir', this.options.outputDir);
    if (this.options.allowedOrigins) args.push('--allowed-origins', this.options.allowedOrigins);
    if (this.options.blockedOrigins) args.push('--blocked-origins', this.options.blockedOrigins);
    return args;
  }

  async ensureStarted(): Promise<void> {
    if (this.options.mock) return;
    if (this.client?.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        fs.mkdirSync(this.options.outputDir, { recursive: true });
      } catch { /* noop */ }
      const command = this.options.command || (os.platform() === 'win32' ? 'npx.cmd' : 'npx');
      this.client = new McpStdioClient({
        name: 'playwright',
        command,
        args: this.buildServerArgs(),
        timeoutMs: this.options.timeoutNavigationMs + 10000,
      });
      await this.client.start();
      this.armIdleTimeout();
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (this.options.mock) {
      return [
        { name: 'browser_navigate' }, { name: 'browser_snapshot' },
        { name: 'browser_click' }, { name: 'browser_type' },
        { name: 'browser_wait' }, { name: 'browser_screenshot' },
      ];
    }
    await this.ensureStarted();
    return this.client!.listTools();
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<McpCallResult> {
    if (this.options.mock) {
      this.mockCalls.push({ tool: name, args });
      return { success: true, text: `[mock:${name}] ${JSON.stringify(args).slice(0, 1000)}`, content: { mock: true, tool: name, args } };
    }
    await this.ensureStarted();
    this.armIdleTimeout();
    const res = await this.client!.callTool(name, args);
    // Wrap untrusted browser content like web_fetch does.
    if (res.success && res.text) {
      res.text = `<!-- BEGIN UNTRUSTED BROWSER CONTENT (${name}) -->\n${res.text}\n<!-- END UNTRUSTED BROWSER CONTENT -->`;
    }
    return res;
  }

  async getStatus(): Promise<{ running: boolean; mock: boolean; toolCount?: number; lastError?: string }> {
    if (this.options.mock) return { running: false, mock: true, toolCount: 6 };
    const running = Boolean(this.client?.isRunning());
    let toolCount: number | undefined;
    if (running) {
      try { toolCount = (await this.listTools()).length; } catch { /* noop */ }
    }
    return { running, mock: false, toolCount, lastError: this.client?.getLastError() };
  }

  async dispose(): Promise<void> {
    if (this.lastIdleTimer) clearTimeout(this.lastIdleTimer);
    this.lastIdleTimer = null;
    await this.client?.stop().catch(() => undefined);
    this.client = null;
  }

  private armIdleTimeout(): void {
    const idleMs = Number(process.env.PLAYWRIGHT_MCP_IDLE_TIMEOUT || 3600000);
    if (!idleMs || idleMs <= 0) return;
    if (this.lastIdleTimer) clearTimeout(this.lastIdleTimer);
    this.lastIdleTimer = setTimeout(() => {
      this.dispose().catch(() => undefined);
    }, idleMs);
    this.lastIdleTimer.unref?.();
  }
}
