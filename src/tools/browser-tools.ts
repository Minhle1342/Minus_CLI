import { Type } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { toolError, toolSuccess } from './tool-result.js';
import type { McpManager } from '../mcp/mcp-manager.js';

/**
 * Browser automation tools backed by microsoft/playwright-mcp.
 * Canonical set (accessibility-tree, no vision model required):
 *  navigate -> snapshot -> click/type -> wait -> snapshot/screenshot
 */

function guardUrl(manager: McpManager, url: unknown): string | null {
  const check = manager.checkUrlAllowed(String(url || ''));
  if (!check.allowed) return check.reason || 'URL blocked';
  return null;
}

export function createBrowserNavigateTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_navigate',
    description: 'Navigate headless browser to http(s) URL via Playwright MCP. Use for SPA/login/form pages where web_fetch returns empty JS shell. Returns accessibility snapshot text.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: 'Absolute http(s) URL to open.' },
      },
      required: ['url'],
    },
    async execute(args: Record<string, any>, _ws: Workspace) {
      const url = String(args.url || '').trim();
      if (!url) return toolError('Parameter "url" is required.', 'INVALID_ARGS' as any);
      const blocked = guardUrl(manager, url);
      if (blocked) return toolError(blocked, 'SECURITY_VIOLATION' as any);
      const res = await manager.callTool('browser_navigate', { url });
      if (!res.success) return toolError(res.error || 'browser_navigate failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ url, snapshot: res.text || '', raw: res.content });
    },
  };
}

export function createBrowserSnapshotTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_snapshot',
    description: 'Capture current page accessibility snapshot (roles/refs) for deterministic click/type targeting. Call after navigate and after each interaction.',
    parameters: { type: Type.OBJECT, properties: {} },
    async execute(_args: Record<string, any>, _ws: Workspace) {
      const res = await manager.callTool('browser_snapshot', {});
      if (!res.success) return toolError(res.error || 'browser_snapshot failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ snapshot: res.text || '', raw: res.content });
    },
  };
}

export function createBrowserClickTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_click',
    description: 'Click element by accessibility ref (e.g. "e12") or CSS selector. Prefer ref from browser_snapshot.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: 'Accessibility ref from snapshot (preferred).' },
        selector: { type: Type.STRING, description: 'CSS selector fallback.' },
      },
    },
    async execute(args: Record<string, any>, _ws: Workspace) {
      if (!args.ref && !args.selector) return toolError('Provide "ref" or "selector".', 'INVALID_ARGS' as any);
      const res = await manager.callTool('browser_click', { element: args.ref || args.selector, ref: args.ref, selector: args.selector });
      if (!res.success) return toolError(res.error || 'browser_click failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ snapshot: res.text || '', raw: res.content });
    },
  };
}

export function createBrowserTypeTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_type',
    description: 'Type/fill text into input by ref or selector. Use for login/search/form flows.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: 'Accessibility ref from snapshot.' },
        selector: { type: Type.STRING, description: 'CSS selector fallback.' },
        text: { type: Type.STRING, description: 'Text to type.' },
        submit: { type: Type.BOOLEAN, description: 'Press Enter after typing.' },
      },
      required: ['text'],
    },
    async execute(args: Record<string, any>, _ws: Workspace) {
      if (!args.text && args.text !== '') return toolError('Parameter "text" is required.', 'INVALID_ARGS' as any);
      const res = await manager.callTool('browser_type', { element: args.ref || args.selector, ref: args.ref, selector: args.selector, text: String(args.text), submit: Boolean(args.submit) });
      if (!res.success) return toolError(res.error || 'browser_type failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ snapshot: res.text || '', raw: res.content });
    },
  };
}

export function createBrowserWaitTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_wait',
    description: 'Wait for text, selector, or fixed ms after navigation/interaction (SPA settle).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'Text to wait for.' },
        selector: { type: Type.STRING, description: 'Selector to wait for.' },
        ms: { type: Type.NUMBER, description: 'Fixed wait ms (max 10000).' },
      },
    },
    async execute(args: Record<string, any>, _ws: Workspace) {
      const ms = Math.min(10000, Math.max(0, Number(args.ms) || 0));
      // Pinned @playwright/mcp@0.0.25 names it browser_wait_for (canonical tool stays browser_wait).
      const res = await manager.callTool('browser_wait_for', { text: args.text, selector: args.selector, time: ms || undefined });
      if (!res.success) return toolError(res.error || 'browser_wait failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ snapshot: res.text || '', raw: res.content });
    },
  };
}

export function createBrowserScreenshotTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_screenshot',
    description: 'Take screenshot only when visual layout needed (vision opt-in). Prefer browser_snapshot otherwise to save tokens.',
    parameters: { type: Type.OBJECT, properties: { fullPage: { type: Type.BOOLEAN, description: 'Capture full page.' } } },
    async execute(args: Record<string, any>, _ws: Workspace) {
      // Pinned @playwright/mcp@0.0.25 names it browser_take_screenshot (canonical tool stays browser_screenshot).
      const res = await manager.callTool('browser_take_screenshot', { fullPage: Boolean(args.fullPage) });
      if (!res.success) return toolError(res.error || 'browser_screenshot failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ snapshot: res.text || '', raw: res.content });
    },
  };
}

export function createBrowserCloseTool(manager: McpManager): ToolDefinition {
  return {
    name: 'browser_close',
    description: 'Close browser session and release isolated profile. Call at end of browser flow.',
    parameters: { type: Type.OBJECT, properties: {} },
    async execute(_args: Record<string, any>, _ws: Workspace) {
      const res = await manager.callTool('browser_close', {});
      if (!res.success) return toolError(res.error || 'browser_close failed', 'EXECUTION_ERROR' as any);
      return toolSuccess({ closed: true, detail: res.text || '' });
    },
  };
}

export function createBrowserTools(manager: McpManager): ToolDefinition[] {
  return [
    createBrowserNavigateTool(manager),
    createBrowserSnapshotTool(manager),
    createBrowserClickTool(manager),
    createBrowserTypeTool(manager),
    createBrowserWaitTool(manager),
    createBrowserScreenshotTool(manager),
    createBrowserCloseTool(manager),
  ];
}

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_wait',
  'browser_screenshot',
  'browser_close',
];
