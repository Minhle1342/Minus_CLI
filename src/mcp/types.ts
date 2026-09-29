/**
 * Shared MCP types (minimal JSON-RPC subset for microsoft/playwright-mcp).
 * Transport: stdio via `npx @playwright/mcp` (or pinned local binary).
 */

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  /**
   * Required on Windows when command is a .cmd/.bat shim (e.g. npx.cmd):
   * Node throws EINVAL when spawning batch files with shell:false.
   */
  shell?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpCallResult {
  success: boolean;
  content?: any;
  text?: string;
  error?: string;
  errorCode?: string;
}

export interface McpClientStatus {
  name: string;
  running: boolean;
  pid?: number;
  toolCount?: number;
  lastError?: string;
}
