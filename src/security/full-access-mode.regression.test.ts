import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gatesForMode } from './full-access-gates.js';
import { PermissionManager } from './permission-manager.js';
import { isPermissionMode } from './permission-modes.js';
import { loadSession, saveSession } from '../session/persistent-session.js';
import { setDefaultWorkspaceGates, Workspace } from '../workspace/workspace.js';
import { SandboxPolicyEngine } from '../sandbox/sandbox-policy.js';
import {
  evaluateHostCommandPolicy,
  mustBlockUnisolatedAutoExecution,
} from '../sandbox/command-isolation-policy.js';
import { evaluateCommandHooks } from '../sandbox/command-hooks.js';
import { buildSafeChildEnv, collectSecretsFromEnv, redactSecretsFromText } from './env-scrub.js';
import { ThisTurnToolGate } from '../control/this-turn-tool-gate.js';
import { ToolRegistry } from '../tools/registry.js';
import { evaluateCommandPreflight } from '../tools/command-preflight-guard.js';
import { checkGitPolicyForShell, createRunCommandTool, findWorkspaceEscapeViolations, isBlockedGitPushToMain } from '../tools/run-command.js';
import { ToolRunner } from '../tools/tool-runner.js';

const CLOSED = gatesForMode('ask_sensitive');
const OPEN = gatesForMode('full_access');
const NO_UNISOLATED_STATUS = {
  mode: 'local' as const,
  activeProvider: 'Local Process Sandbox',
  isIsolated: false,
  dockerAvailable: false,
  fallbackToLocal: true,
};

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minus-full-access-'));
}

test('gate 1 approval_prompt: the interactive prompt is skipped, and still required without the mode', async () => {
  const asking = new PermissionManager('always_ask');
  const denied = await asking.checkPermission('write_file', { path: 'scratch.txt', content: 'x' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.errorCode, 'APPROVAL_REQUIRED');

  const full = new PermissionManager('full_access');
  const granted = await full.checkPermission('write_file', { path: 'scratch.txt', content: 'x' });
  assert.equal(granted.allowed, true);
});

test('gate 2 host_system_risk: destructive host commands are unblocked only with the gate open', () => {
  assert.equal(evaluateHostCommandPolicy('format C:', undefined, CLOSED).allowed, false);
  assert.equal(evaluateHostCommandPolicy('rm -rf /', undefined, CLOSED).allowed, false);
  assert.equal(evaluateHostCommandPolicy('format C:', undefined, OPEN).allowed, true);
  assert.equal(evaluateHostCommandPolicy('rm -rf /', undefined, OPEN).allowed, true);

  const root = tempWorkspace();
  const closed = new SandboxPolicyEngine(root, 'workspace-write', CLOSED);
  const open = new SandboxPolicyEngine(root, 'workspace-write', OPEN);
  assert.equal(closed.evaluateCommand('format C:').allowed, false);
  assert.equal(closed.evaluateCommand('format C:').riskLevel, 'SYSTEM_RISK');
  assert.equal(open.evaluateCommand('format C:').allowed, true);

  // §11: gate 2 đóng thì 'unrestricted' vẫn chặn SYSTEM_DESTRUCTIVE như hôm nay.
  const unrestrictedClosed = new SandboxPolicyEngine(root, 'unrestricted', CLOSED);
  assert.equal(unrestrictedClosed.evaluateCommand('rm -rf /').allowed, false);
});

test('gate 3 workspace_boundary: paths outside the workspace resolve instead of throwing', () => {
  const root = tempWorkspace();
  const workspace = new Workspace(root);
  assert.throws(() => workspace.resolveSafePath('../outside.txt'));
  workspace.setGates(OPEN);
  assert.equal(workspace.resolveSafePath('../outside.txt'), path.resolve(root, '../outside.txt'));
  workspace.setGates(CLOSED);
  assert.throws(() => workspace.resolveSafePath('../outside.txt'));
});

test('gate 4 docker_isolation: an unisolated auto run no longer fails closed', () => {
  assert.equal(mustBlockUnisolatedAutoExecution('npm install malicious-pkg', NO_UNISOLATED_STATUS, CLOSED), true);
  assert.equal(mustBlockUnisolatedAutoExecution('npm install malicious-pkg', NO_UNISOLATED_STATUS, OPEN), false);
});

test('gate 5 phase_masking: mutation tools stay in the turn surface during explore', () => {
  const classification = {
    id: 'fa-explore',
    version: 1,
    taskClass: 'exploration',
    phase: 'explore',
    complexity: 'small',
    externality: 'local',
    reversibility: 'read-only',
    risk: 'R0',
    requiredCapabilities: ['inspect', 'search'],
    confidence: 0.9,
    fastPath: true,
    reasonCodes: [],
    createdAt: new Date().toISOString(),
  } as any;
  const tools = new ToolRegistry().getAll();
  const gate = new ThisTurnToolGate();

  const masked = gate.decide(classification, tools, { workspaceDir: tempWorkspace(), gates: CLOSED });
  assert.ok(masked.deniedToolNames.includes('write_file'), 'closed reader must still deny write_file in explore');

  for (const mode of ['shadow', 'enforce'] as const) {
    // mode chỉ quyết định ToolScope ở agent-loop; gate surface phải trao quyền như nhau.
    const opened = gate.decide(classification, tools, { workspaceDir: tempWorkspace(), gates: OPEN });
    assert.ok(!opened.deniedToolNames.includes('write_file'), `${mode}: write_file must be authorized`);
    assert.ok(opened.allowedToolNames.includes('write_file'), `${mode}: write_file must reach ToolScope`);
  }
});

test('gate 6 protected_files: sensitive config files become writable only with the gate open', () => {
  const root = tempWorkspace();
  const workspace = new Workspace(root, { protectedFiles: ['.env'] });
  assert.equal(workspace.isProtectedFile('.env'), true);
  workspace.setGates(OPEN);
  assert.equal(workspace.isProtectedFile('.env'), false);
  workspace.setGates(undefined);
  assert.equal(workspace.isProtectedFile('.env'), true);
});

test('gate 7 child_env_scrub: host tokens reach the child env only with the gate open', (t) => {
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_testvalue0123456789';
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });

  const hardened = buildSafeChildEnv(undefined, CLOSED);
  assert.equal(hardened.GITHUB_TOKEN, undefined);
  assert.equal(hardened.CI, 'true');

  const open = buildSafeChildEnv(undefined, OPEN);
  assert.equal(open.GITHUB_TOKEN, 'ghp_testvalue0123456789');
  // Hardening defaults survive the open path so interactive hangs stay impossible.
  assert.equal(open.CI, 'true');
  assert.equal(open.GIT_TERMINAL_PROMPT, '0');
  // Gate 7 mở env con nhưng không được thu nhỏ tập secret dùng để redact output.
  const secretValues = collectSecretsFromEnv(open);
  assert.ok(secretValues.includes('ghp_testvalue0123456789'));
  assert.equal(
    redactSecretsFromText('echo $GITHUB_TOKEN → ghp_testvalue0123456789', secretValues).includes('ghp_testvalue0123456789'),
    false,
  );
});

test('kept gate push_to_main: git push origin main is refused with every gate open', async () => {
  assert.equal(isBlockedGitPushToMain('git push origin main'), true);
  const permissions = new PermissionManager('full_access');
  const subagent = await permissions.checkPermission(
    'run_command',
    { command: 'git push origin main' },
    { isSubagent: true },
  );
  assert.equal(subagent.allowed, false);
  assert.equal(subagent.errorCode, 'PUSH_TO_MAIN_PROHIBITED');
});

test('kept gate output_redaction: secrets in command output are masked regardless of mode', () => {
  const leaked = 'remote: token ghp_AAAAAAAAAAAAAAAAbbbb';
  assert.equal(redactSecretsFromText(leaked, []).includes('ghp_AAAAAAAAAAAAAAAAbbbb'), false);
  assert.ok(redactSecretsFromText(leaked, []).includes('[REDACTED]'));
});

test('kept gate repo_hooks: a deny rule in .minus/hooks.json still blocks the command', () => {
  const root = tempWorkspace();
  fs.mkdirSync(path.join(root, '.minus'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.minus', 'hooks.json'),
    JSON.stringify({ preRun: [{ pattern: 'del.*critical', action: 'deny', message: 'nope' }] }),
  );
  const verdict = evaluateCommandHooks('del critical-dir', root);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.errorCode, 'HOOK_DENIED');
});

test('kept gate git_policy: credentials in a git remote URL are still rejected', () => {
  const root = tempWorkspace();
  const violation = checkGitPolicyForShell(
    ['git clone https://user:secret@github.com/acme/private.git'],
    root,
    true,
    true,
  );
  assert.equal(violation?.errorCode, 'GIT_CREDENTIAL_IN_URL');
});

test('functional guard: preflight keeps blocking interactive commands under full access', () => {
  const result = evaluateCommandPreflight('vim notes.txt');
  assert.equal(result.allowed, false);
});

test('persistence: full_access survives save → hydrate', () => {
  const root = tempWorkspace();
  saveSession({ permissionMode: 'full_access' }, root);
  const hydrated = loadSession(root).permissionMode;
  assert.equal(isPermissionMode(hydrated), true);

  const permissions = new PermissionManager({ mode: 'ask_sensitive', workspaceRoot: root });
  permissions.setProjectMode(root, isPermissionMode(hydrated) ? hydrated : null);
  assert.equal(permissions.effectiveMode(), 'full_access');
  assert.equal(permissions.getProjectMode(root), 'full_access');
});

test('gate 3/6 process default: a Workspace built later (worktree, spec branch) inherits full access', () => {
  const root = tempWorkspace();
  // Không có reader nào được attach ⇒ mọi Workspace đóng gate như hôm nay.
  assert.throws(() => new Workspace(root).resolveSafePath('../outside.txt'));
  assert.equal(new Workspace(root, { protectedFiles: ['.env'] }).isProtectedFile('.env'), true);

  setDefaultWorkspaceGates(OPEN);
  try {
    // Instance mới hoàn toàn, không gọi setGates — phải đọc theo default toàn cục.
    const worktreeWorkspace = new Workspace(root);
    assert.ok(path.isAbsolute(worktreeWorkspace.resolveSafePath('../outside.txt')));
    assert.equal(new Workspace(root, { protectedFiles: ['.env'] }).isProtectedFile('.env'), false);
  } finally {
    setDefaultWorkspaceGates(undefined);
  }

  // Gỡ default ⇒ đóng trở lại, chứng minh mode cũ không nhiễm.
  assert.throws(() => new Workspace(root).resolveSafePath('../outside.txt'));
  assert.equal(new Workspace(root, { protectedFiles: ['.env'] }).isProtectedFile('.env'), true);
});

test('gate 3 shell scan: home paths and traversal stop counting as escapes under full access', () => {
  const root = tempWorkspace();
  const workspace = new Workspace(root);
  const command = 'cat ~/.ssh/id_rsa && cat ../secret.txt';
  assert.ok(findWorkspaceEscapeViolations(command, workspace).length > 0);
  workspace.setGates(OPEN);
  assert.deepEqual(findWorkspaceEscapeViolations(command, workspace), []);
  workspace.setGates(CLOSED);
  assert.ok(findWorkspaceEscapeViolations(command, workspace).length > 0);
});

test('gate 5 at the dispatch site: the phase effect check stops blocking tool calls under full access', async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'run_command',
    description: 'fixture',
    parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } }, required: ['command'] } as any,
    execute: async () => { executions++; return { exitCode: 0 }; },
  });
  const workspace = new Workspace(tempWorkspace());
  const context = { classificationPhase: 'explore' } as any;

  const blocked = await new ToolRunner(registry, workspace, new PermissionManager('auto_approve'))
    .run('run_command', { command: 'node write.js' }, context);
  assert.equal(blocked.result.errorCode, 'PHASE_TOOL_EFFECT_BLOCKED');
  assert.equal(executions, 0);

  const allowed = await new ToolRunner(registry, workspace, new PermissionManager('full_access'))
    .run('run_command', { command: 'node write.js' }, context);
  assert.equal(allowed.result.errorCode, undefined);
  assert.equal(executions, 1);
});

test('gate 4 end-to-end: full access routes an auto run to the host instead of the isolated container', async () => {
  const containerCalls: string[] = [];
  const dockerManager = {
    getStatus: () => ({
      mode: 'docker', activeProvider: 'Docker Sandbox', isIsolated: true, dockerAvailable: true,
    }),
    exec: async (command: string) => {
      containerCalls.push(command);
      return { stdout: 'from container', stderr: '', exitCode: 0, durationMs: 1, success: true };
    },
  } as any;
  const workspace = new Workspace(tempWorkspace());

  const isolated = await createRunCommandTool(dockerManager, undefined, new PermissionManager('auto_approve'))
    .execute({ command: 'node --version' }, workspace);
  assert.equal(isolated.executionTarget, 'auto');
  assert.deepEqual(containerCalls, ['node --version']);

  containerCalls.length = 0;
  const hostRun = await createRunCommandTool(dockerManager, undefined, new PermissionManager('full_access'))
    .execute({ command: 'node --version' }, workspace);
  assert.equal(containerCalls.length, 0, 'container exec must not run under full access');
  assert.equal(hostRun.executionTarget, 'host');
});
