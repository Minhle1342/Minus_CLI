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
