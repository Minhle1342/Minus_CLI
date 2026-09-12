import assert from 'node:assert/strict';
import test from 'node:test';
import { ClassificationEngine } from './classification-engine.js';
import { ThisTurnToolGate } from './this-turn-tool-gate.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { PermissionManager } from '../security/permission-manager.js';

test('read-only exploration can inspect Git history through guarded run_command', async () => {
  const workspace = new Workspace(process.cwd());
  const registry = new ToolRegistry();
  const classification = new ClassificationEngine().classify({
    request: 'Explain how the current implementation relates to recent commits',
  });
  const decision = new ThisTurnToolGate().decide(classification, registry.getAll());

  assert.equal(classification.risk, 'R0');
  assert.ok(decision.allowedToolNames.includes('run_command'));

  const scope = registry.createScope('read-only-git-history', decision.allowedToolNames);
  const runner = new ToolRunner(scope, workspace, new PermissionManager('ask_sensitive'));
  const context = {
    decisionId: decision.id,
    allowedToolNames: decision.allowedToolNames,
    allowedToolSetHash: decision.allowedToolSetHash,
    maxToolCalls: decision.maxToolCalls,
    userRequest: 'Explain how the current implementation relates to recent commits',
  };
  const gitLog = await runner.run('run_command', { command: 'git log -n 5 --stat' }, context);
  assert.equal(gitLog.result.exitCode, 0);

  const mutationAttempt = await runner.run('run_command', {
    command: 'npm install package-that-must-not-run',
  }, context);
  assert.equal(mutationAttempt.result.errorCode, 'APPROVAL_REQUIRED');
});
