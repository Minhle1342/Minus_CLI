import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpStdioClient } from './mcp-client.js';
import type { McpCallResult, McpToolDescriptor } from './types.js';

/** Pinned to package.json + deploy/sandbox/Dockerfile.playwright. Never @latest in production. */
export const PLAYWRIGHT_MCP_PINNED_SPEC = '@playwright/mcp@0.0.25';

export type ServerLaunchSource = 'explicit' | 'local-package' | 'npx';

export interface ServerLaunch {
  command: string;
  args: string[];
  shell: boolean;
  source: ServerLaunchSource;
}

export interface LaunchDeps {
  platform?: string;
  execPath?: string;
  pathExists?: (p: string) => boolean;
  resolveLocalEntry?: () => string | undefined;
}

function defaultResolveLocalEntry(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('@playwright/mcp/package.json');
    const dir = path.dirname(pkgJson);
    for (const candidate of ['cli.js', 'index.js', 'lib/cli.js', 'dist/cli.js']) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve how to launch the playwright-mcp server without shell-quoting traps:
 * 1. explicit `command` (PLAYWRIGHT_MCP_COMMAND) — operator override;
 * 2. local `@playwright/mcp` entry via `node` — no shell, no npx, works offline;
 * 3. npx fallback (pinned spec) — needs network/npm cache; shell:true on win32
 *    because Node throws EINVAL spawning .cmd shims with shell:false.
 */
export function resolveServerLaunch(
  mcpArgs: string[],
  opts: { command?: string } = {},
  deps: LaunchDeps = {},
): ServerLaunch {
  const platform = deps.platform ?? os.platform();
  const isWin = platform === 'win32';
  if (opts.command) {
    const cmd = opts.command;
    const base = cmd.split(/[\\/]/).pop() || cmd;
    // Operator pointed at npx itself: complete it into a pinned npx launch
    // (otherwise npx would receive only MCP flags and fail).
    if (/^npx(\.cmd)?$/i.test(base)) {
      return { command: cmd, args: ['-y', PLAYWRIGHT_MCP_PINNED_SPEC, ...mcpArgs], shell: isWin, source: 'npx' };
    }
    return { command: cmd, args: mcpArgs, shell: isWin && /\.cmd$/i.test(cmd), source: 'explicit' };
  }
  const resolveEntry = deps.resolveLocalEntry ?? defaultResolveLocalEntry;
  const exists = deps.pathExists ?? ((p: string) => fs.existsSync(p));
  const entry = resolveEntry();
  if (entry && exists(entry)) {
    return { command: deps.execPath ?? process.execPath, args: [entry, ...mcpArgs], shell: false, source: 'local-package' };
  }
  const npx = isWin ? 'npx.cmd' : 'npx';
  return { command: npx, args: ['-y', PLAYWRIGHT_MCP_PINNED_SPEC, ...mcpArgs], shell: isWin, source: 'npx' };
}

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
      viewport: opts.viewport || process.env.PLAYWRIGHT_MCP_VIEWPORT || '1280,720',
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

  /** MCP flags only (no launcher prefix — see resolveServerLaunch). */
  buildMcpArgs(): string[] {
    if (this.options.serverArgs) return this.options.serverArgs;
    const args: string[] = [];
    if (this.options.headless) args.push('--headless');
    if (this.options.isolated) args.push('--isolated');
    if (this.options.browser && this.options.browser !== 'chromium') args.push('--browser', this.options.browser);
    args.push('--viewport-size', this.options.viewport);
    // NOTE: @playwright/mcp@0.0.25 (pinned) has no --timeout-action/--timeout-navigation
    // flags (they exist only in newer releases). Transport timeouts stay client-side
    // via McpServerConfig.timeoutMs. Do not re-add without bumping the pinned spec.
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
      const explicit = this.options.command || process.env.PLAYWRIGHT_MCP_COMMAND || undefined;
      const launch = resolveServerLaunch(this.buildMcpArgs(), { command: explicit });
      this.client = new McpStdioClient({
        name: 'playwright',
        command: launch.command,
        args: launch.args,
        shell: launch.shell,
        timeoutMs: this.options.timeoutNavigationMs + 10000,
      });
      try {
        await this.client.start();
      } catch (err: any) {
        throw new Error(
          `Playwright MCP server failed to start via ${launch.source} (${launch.command}): ${err?.message || err}. ` +
          `Fix: npm install (for local @playwright/mcp), then npx playwright install chromium; ` +
          `or set PLAYWRIGHT_MCP_COMMAND to a working launcher.`,
        );
      }
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
