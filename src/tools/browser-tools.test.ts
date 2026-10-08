import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../workspace/workspace.js';
import { McpManager } from '../mcp/mcp-manager.js';
import { createBrowserTools, BROWSER_TOOL_NAMES } from './browser-tools.js';
import { ToolRegistry } from './registry.js';
import { PermissionManager } from '../security/permission-manager.js';
import { ToolSynergyAdvisor } from '../agent/tool-synergy-advisor.js';

const ws = new Workspace();

describe('playwright-mcp browser automation', () => {
  it('exposes 7 canonical browser_* tools in mock mode', async () => {
    const mgr = new McpManager({ mock: true });
    const tools = createBrowserTools(mgr);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...BROWSER_TOOL_NAMES].sort());
    const nav = tools.find((t) => t.name === 'browser_navigate')!;
    const res: any = await nav.execute({ url: 'https://example.com' }, ws);
    assert.equal(res.success, true);
    assert.match(res.snapshot, /mock:browser_navigate/);
  });

  it('blocks file:// and non-http(s) before MCP', async () => {
    const mgr = new McpManager({ mock: true });
    const tools = createBrowserTools(mgr);
    const nav = tools.find((t) => t.name === 'browser_navigate')!;
    const res: any = await nav.execute({ url: 'file:///etc/passwd' }, ws);
    assert.equal(res.success, false);
    assert.equal(mgr.getMockCalls().length, 0);
  });

  it('enforces blocked-origins allowlist', () => {
    const mgr = new McpManager({ mock: true, blockedOrigins: 'evil.com' });
    assert.equal(mgr.checkUrlAllowed('https://evil.com/login').allowed, false);
    assert.equal(mgr.checkUrlAllowed('https://example.com/').allowed, true);
  });

  it('registry attach + retriever category=browser', () => {
    const mgr = new McpManager({ mock: true });
    const reg = new ToolRegistry();
    reg.attachBrowserManager(mgr);
    for (const name of BROWSER_TOOL_NAMES) assert.ok(reg.get(name), name);
    const stubs = reg.getToolCatalogStubs().filter((s) => s.name.startsWith('browser_'));
    assert.equal(stubs.length, 7);
    assert.ok(stubs.every((s) => s.category === 'browser'));
    const decls = reg.getRelevantTools({ query: 'playwright browser login spa snapshot' });
    assert.ok(decls.some((d) => d.name?.startsWith('browser_')));
  });

  it('headless browser network and interaction calls require approval', async () => {
    const pm = new PermissionManager('ask_sensitive');
    const nav = await pm.checkPermission('browser_navigate', { url: 'https://example.com' });
    assert.equal(nav.allowed, false);
    assert.equal(nav.errorCode, 'APPROVAL_REQUIRED');
    const type = await pm.checkPermission('browser_type', { text: 'hi' });
    assert.equal(type.allowed, false);
    assert.equal(type.errorCode, 'APPROVAL_REQUIRED');
  });

  it('playbook H_BROWSER guides snapshot after navigate', () => {
    const advisor = new ToolSynergyAdvisor();
    const advice = advisor.advise({ lastToolName: 'browser_navigate', lastToolResult: { success: true } });
    assert.equal(advice.playbook, 'H_BROWSER');
    assert.ok(advice.suggestedTools.includes('browser_snapshot'));
  });
});
