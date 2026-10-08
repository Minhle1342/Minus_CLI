import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionManager } from '../security/permission-manager.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { ToolRegistry } from '../tools/registry.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';
import { AgentLoop } from './agent-loop.js';

class ScriptedCompletionLLM {
  calls = 0;
  constructor(private readonly replies: any[]) {}
  async generate(_session: Session): Promise<any> {
    const reply = this.replies[this.calls++];
    if (!reply) {
      return { text: 'AgentLoop coordinates tools and completion.', toolCalls: [] };
    }
    return reply;
  }
}

test('Explicit prompt rejection is flagged deniedByUser (errorCode stays PERMISSION_DENIED)', async () => {
  const pm = new PermissionManager('always_ask');
  pm.setPromptHandler(async () => 'reject');
  const denied = await pm.checkPermission('replace_text', { path: 'src/a.ts', oldText: 'x', newText: 'y' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.errorCode, 'PERMISSION_DENIED');
  assert.equal(denied.deniedByUser, true);

  const pm2 = new PermissionManager('always_ask');
  pm2.setPromptHandler(async () => 'approve');
  const approved = await pm2.checkPermission('replace_text', { path: 'src/a.ts', oldText: 'x', newText: 'y' });
  assert.equal(approved.allowed, true);
  assert.equal(approved.deniedByUser, undefined);
});

test('ToolRunner propagates deniedByUser without executing the tool', async () => {
  let executed = false;
  const registry = {
    get: () => ({
      name: 'replace_text',
      description: 'stub',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    }),
    getAll: () => [],
  } as any;
  const pm = new PermissionManager('always_ask');
  pm.setPromptHandler(async () => 'reject');
  const runner = new ToolRunner(registry, new Workspace(process.cwd()), pm);
  const res = await runner.run('replace_text', {}, undefined);
  assert.equal(res.result.errorCode, 'PERMISSION_DENIED');
  assert.equal(res.result.deniedByUser, true);
  assert.equal(executed, false);
});

test('run_command propagates deniedByUser on prompt rejection', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deny-rc-'));
  try {
    const pm = new PermissionManager('always_ask');
    pm.setPromptHandler(async () => 'reject');
    const tool = createRunCommandTool(undefined, undefined, pm);
    const res = await tool.execute({ command: 'rm -rf /tmp/denied-probe-xyz' }, new Workspace(rootDir));
    assert.equal(res.errorCode, 'PERMISSION_DENIED');
    assert.equal(res.deniedByUser, true);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Agent loop ends the turn (no workaround attempts) after explicit user denial', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deny-loop-'));
  try {
    const workspace = new Workspace(rootDir);
    const llm = new ScriptedCompletionLLM([
      {
        text: '',
        toolCalls: [{ id: 'call-deny', name: 'run_command', args: { command: 'rm -rf /tmp/denied-probe-xyz' } }],
      },
      { text: 'This reply must never be reached.', toolCalls: [] },
    ]);
    const registry = new ToolRegistry();
    const loop = new AgentLoop(llm as any, registry, { workspace, maxSteps: 4 });
    const runner = (loop as any).toolRunner;
    let pm = runner.getPermissionManager?.();
    if (!pm) {
      const { PermissionManager: PM } = await import('../security/permission-manager.js');
      pm = new PM('always_ask');
      runner.setPermissionManager(pm);
    } else {
      pm.setMode('always_ask');
    }
    pm.setPromptHandler(async () => 'reject');

    const session = new Session('session-deny-loop');
    session.addUserMessage('Execute the temp directory cleanup command once.');
    const result = await loop.run(session);

    assert.match(String(result), /turn ended, awaiting your direction/i);
    assert.equal(llm.calls, 1, 'LLM must not be re-prompted after explicit denial');
    const toolResults = session.getEvents().filter((e: any) => e.type === 'tool/result');
    assert.ok(
      toolResults.some((e: any) => e.data?.result?.deniedByUser === true),
      'denial must be recorded in session history',
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
});
