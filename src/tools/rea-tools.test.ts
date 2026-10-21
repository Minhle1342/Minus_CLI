import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Type } from '@google/genai';
import { Workspace } from '../workspace/workspace.js';
import { ToolRegistry } from './registry.js';
import { createReaTools, reaToolName } from './rea-tools.js';
import { buildReaLaunch, REA_MCP_PINNED_SPEC } from '../mcp/rea-mcp-manager.js';
import { ToolDescriptorRegistry } from '../control/tool-descriptor-registry.js';
import type { McpToolDescriptor } from '../mcp/types.js';

const descriptors: McpToolDescriptor[] = [
  {
    name: 'open_binary',
    description: 'Open a binary target.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Binary path' },
        architecture: { type: 'string', enum: ['x86_64', 'arm64'] },
      },
      required: ['path'],
    },
  },
  { name: 'binary_overview', description: 'Summarize the open binary.' },
];

function fakeManager(result?: { success: boolean; text?: string; error?: string }) {
  const calls: Array<{ name: string; args: Record<string, any> }> = [];
  const manager = {
    listTools: async () => descriptors,
    callTool: async (name: string, args: Record<string, any>) => {
      calls.push({ name, args });
      return result ?? { success: true, text: `ok:${name}`, content: {} };
    },
  };
  return { manager: manager as any, calls };
}

describe('rea dynamic tool registration', () => {
  it('maps every discovered MCP tool with the rea_ prefix and Gemini schema', () => {
    const { manager } = fakeManager();
    const tools = createReaTools(manager, descriptors);
    assert.deepEqual(tools.map((t) => t.name), ['rea_open_binary', 'rea_binary_overview']);
    assert.equal(reaToolName('open_binary'), 'rea_open_binary');

    const params: any = tools[0].parameters;
    assert.equal(params.type, Type.OBJECT);
    assert.equal(params.properties.path.type, Type.STRING);
    assert.deepEqual(params.properties.architecture.enum, ['x86_64', 'arm64']);
    assert.deepEqual(params.required, ['path']);
    // Tools with no input schema still expose an empty object schema.
    assert.deepEqual(tools[1].parameters, { type: Type.OBJECT, properties: {} });
  });

  it('passes workspace-resolved paths to the real server tool name', async () => {
    const { manager, calls } = fakeManager();
    const tool = createReaTools(manager, descriptors)[0];
    const res: any = await tool.execute({ path: 'samples/App.bin' }, new Workspace());
    assert.equal(res.success, true);
    assert.equal(res.output, 'ok:open_binary');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'open_binary');
    assert.equal(calls[0].args.path, path.resolve(process.cwd(), 'samples/App.bin'));
  });

  it('rejects paths outside the workspace before reaching REA', async () => {
    const { manager, calls } = fakeManager();
    const tool = createReaTools(manager, descriptors)[0];
    for (const outside of ['../secret.bin', path.resolve(process.cwd(), '..', 'secret.bin')]) {
      const res: any = await tool.execute({ path: outside }, new Workspace());
      assert.equal(res.success, false, outside);
      assert.equal(res.errorCode, 'SECURITY_VIOLATION', outside);
    }
    assert.equal(calls.length, 0);
  });

  it('sandboxes path-shaped document args but leaves identifiers and addresses alone', async () => {
    const { manager, calls } = fakeManager();
    const docs: McpToolDescriptor[] = [
      { name: 'set_current_document', inputSchema: { type: 'object', properties: { document: { type: 'string' } } } },
      { name: 'goto_address', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
    ];
    const tools = createReaTools(manager, docs);
    const setDoc = tools.find((t) => t.name === 'rea_set_current_document')!;
    const goto = tools.find((t) => t.name === 'rea_goto_address')!;

    assert.equal((await setDoc.execute({ document: 'App.hop' }, new Workspace()) as any).success, true);
    assert.equal(calls[0].args.document, 'App.hop');

    const blocked: any = await setDoc.execute({ document: '../outside.hop' }, new Workspace());
    assert.equal(blocked.errorCode, 'SECURITY_VIOLATION');
    assert.equal(calls.length, 1);

    assert.equal((await goto.execute({ address: '0x100003f20' }, new Workspace()) as any).success, true);
    assert.equal(calls[1].args.address, '0x100003f20');
  });

  it('surfaces server failures as tool errors', async () => {
    const { manager } = fakeManager({ success: false, error: 'Hopper not found' });
    const res: any = await createReaTools(manager, descriptors)[0].execute({}, new Workspace());
    assert.equal(res.success, false);
    assert.match(res.error, /Hopper not found/);
  });

  it('attaches discovered tools to the registry and pins them on reverse intent', async () => {
    const { manager } = fakeManager();
    const registry = new ToolRegistry();
    assert.equal(await registry.attachReaManager(manager), 2);
    assert.ok(registry.get('rea_open_binary'));
    assert.ok(registry.get('rea_binary_overview'));

    const reverse = registry.getRelevantTools({ query: 'decompile this binary and list xrefs' });
    assert.ok(reverse.some((t) => t.name === 'rea_open_binary'));
    assert.ok(reverse.some((t) => t.name === 'rea_binary_overview'));

    // Idempotent: a retry must not duplicate registrations.
    assert.equal(await registry.attachReaManager(manager), 0);
  });

  it('sandboxes every host path argument, including nested and array values', async () => {
    const { manager } = fakeManager();
    const docs: McpToolDescriptor[] = [
      { name: 'inspect_managed_artifact', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'recover_javascript_sources', inputSchema: { type: 'object', properties: { input_path: { type: 'string' }, additional_paths: { type: 'array' }, output_directory: { type: 'string' } } } },
      { name: 'inspect_analysis_view', inputSchema: { type: 'object', properties: { source: { type: 'object' } } } },
      { name: 'push_adb_file', inputSchema: { type: 'object', properties: { device_path: { type: 'string' } } } },
    ];
    const [managed, recover, view, adb] = createReaTools(manager, docs);
    assert.equal((await managed.execute({ path: 'samples/App.dll' }, new Workspace()) as any).success, true);
    assert.equal((await recover.execute({
      input_path: 'app',
      additional_paths: ['app/lib', '../outside'],
      output_directory: '../out',
    }, new Workspace()) as any).errorCode, 'SECURITY_VIOLATION');
    assert.equal((await view.execute({
      source: { kind: 'evidence-file', path: '../outside.json' },
    }, new Workspace()) as any).errorCode, 'SECURITY_VIOLATION');
    // Device-internal paths belong to the Android target, not the host sandbox.
    assert.equal((await adb.execute({ device_path: '/sdcard/Download/app.apk' }, new Workspace()) as any).success, true);
  });

  it('treats rea tools as read-only so the phase gate keeps them visible', () => {
    const { manager } = fakeManager();
    const tool = createReaTools(manager, descriptors)[0];
    const descriptor = new ToolDescriptorRegistry().describe(tool);
    assert.equal(descriptor.mutates, false);
    assert.equal(descriptor.requiresApproval, false);
    assert.equal(descriptor.minimumRisk, 'R0');
    assert.ok(descriptor.capabilities.includes('inspect'));
  });

  it('launches the stdio MCP subcommand with the current package on every host', () => {
    const launch = buildReaLaunch();
    assert.equal(launch.args.slice(-1)[0], 'mcp');
    assert.ok(launch.args.includes(REA_MCP_PINNED_SPEC));
    assert.equal(launch.shell, false);
    if (process.platform === 'win32') assert.equal(launch.command, 'cmd.exe');
    const explicit = buildReaLaunch('/usr/local/bin/rea-mcp');
    assert.deepEqual(explicit.args, []);
  });
});
