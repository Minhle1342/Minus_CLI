import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionManager } from '../security/permission-manager.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';
import { hashAllowedToolSet, ThisTurnToolGate } from './this-turn-tool-gate.js';
import { ClassificationEngine } from './classification-engine.js';
import { isReadOnlyRequest } from './request-intent.js';
import { Session } from '../session/session.js';
import { applyPhaseAuthority, recordImplementationCompleted, recordVerificationOutcome } from '../agent/phase-lifecycle.js';
import { SandboxPolicyEngine } from '../sandbox/sandbox-policy.js';
import { IsolatedExecutionSubstrate } from '../execution/isolated-substrate.js';
import { checkPhaseToolEffect } from './phase-tool-effects.js';
import { requestPhaseTransition } from '../agent/phase-lifecycle.js';

test('Git inspection is exposed but readonly permission and phase still deny Git writes', async () => {
  const registry = new ToolRegistry();
  const tool = { name: 'git_command', description: 'fixture', parameters: {} as any, execute: async () => ({}) };
  const classification = new ClassificationEngine().classify({ request: 'Review the changes' });
  assert.ok(new ThisTurnToolGate().decide(classification, [tool]).allowedToolNames.includes('git_command'));
  const permission = new PermissionManager('read_only');
  assert.equal((await permission.checkPermission('git_command', { subcommand: 'status', args: ['--short'] })).allowed, true);
  assert.equal((await permission.checkPermission('git_command', { subcommand: 'commit', args: ['-m', 'change'] })).allowed, false);
});

test('explicit execution has execution phase while planning and explanation retain readonly scope', () => {
  const engine = new ClassificationEngine();
  for (const request of ['Run once', 'Execute the batch', 'Run npm test', 'Build the project', 'Chạy script này', 'Run test that prints "do not edit code"']) {
    const classification = engine.classify({ request });
    assert.equal(classification.phase, 'verify', request);
    assert.ok(classification.requiredCapabilities.includes('execute'));
    assert.equal(classification.requiredCapabilities.includes('edit'), false);
  }
  for (const request of ['Explain how to run npm test', 'Review this README: "Run npm test"', "Don't edit code, don't run npm test", 'Read-only: run npm test', 'Make a plan to run tests']) {
    assert.ok(['explore', 'plan'].includes(engine.classify({ request }).phase), request);
  }
});

test('readonly or planning deliverables cannot authorize implementation by phase request', async () => {
  for (const request of ['Review this function', 'Make a plan to fix this function']) {
    const session = new Session();
    const classification = new ClassificationEngine().classify({ request });
    const decision = requestPhaseTransition(session, 1, classification, { targetPhase: 'implement', rationale: 'ready', evidenceRefs: ['src/a.ts'] }, { hasPlan: true, evidenceSufficient: true });
    assert.equal(decision.accepted, false, request);
  }
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'replace_text', description: 'fixture', parameters: { type: 'OBJECT' } as any, execute: async () => { executions++; return {}; } });
  const runner = new ToolRunner(registry, new Workspace(process.cwd()), new PermissionManager('auto_approve'));
  const result = await runner.run('replace_text', {}, { classificationPhase: 'implement', userRequest: 'Read-only: inspect this function' });
  assert.equal(result.result.errorCode, 'PHASE_TOOL_EFFECT_BLOCKED');
  assert.equal(executions, 0);
});

test('universal runner guards actual command effects in planning and exploration', async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'run_command', description: 'fixture', parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } }, required: ['command'] } as any, execute: async () => { executions++; return { exitCode: 0 }; } });
  const runner = new ToolRunner(registry, new Workspace(process.cwd()), new PermissionManager('auto_approve'));
  for (const classificationPhase of ['plan', 'explore']) for (const controlMode of ['off', 'shadow', 'enforce'] as const) {
    const context = { classificationPhase, controlMode, decisionId: 'fixture', allowedToolNames: ['run_command'], allowedToolSetHash: hashAllowedToolSet(['run_command']) };
    const blocked = await runner.run('run_command', { command: 'node write.js' }, context);
    assert.equal(blocked.result.errorCode, 'PHASE_TOOL_EFFECT_BLOCKED');
    assert.equal(blocked.result.processStarted, false);
    const safe = await runner.run('run_command', { command: 'git status -s' }, context);
    assert.equal(safe.result.exitCode, 0);
  }
  assert.equal(executions, 6);
});

test('read-only effects deny execution alternatives while retaining inspection and metadata', async () => {
  const permission = new PermissionManager('read_only');
  permission.setWorkspaceRoot(process.cwd());
  for (const name of ['run_node_script', 'run_test_suite', 'write_to_file', 'start_background_task', 'browser_click', 'unknown_plugin_effect']) {
    assert.equal((await permission.checkPermission(name, {})).allowed, false, name);
  }
  for (const name of ['read_file', 'codegraph_explore', 'create_plan', 'submit_solution', 'browser_screenshot', 'browser_wait']) {
    assert.equal((await permission.checkPermission(name, {})).allowed, true, name);
  }
  assert.equal((await permission.checkPermission('run_command', { command: 'git status -s' })).allowed, true);
  assert.equal((await permission.checkPermission('run_command', { command: 'echo text > file' })).allowed, false);
});

test('headless always_ask cannot approve a pending operation implicitly', async () => {
  const permission = new PermissionManager('always_ask');
  for (const name of ['write_file', 'delete_file', 'browser_click']) {
    const decision = await permission.checkPermission(name, {});
    assert.equal(decision.allowed, false, name);
    assert.equal(decision.errorCode, 'APPROVAL_REQUIRED');
  }
  assert.equal((await new PermissionManager().checkPermission('read_file', {})).allowed, true);
});

test('enforced binding cannot dispatch a registered root tool or edit outside its allowlist', async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  for (const name of ['outside_authority', 'replace_text']) registry.register({ name, description: 'fixture', parameters: { type: 'OBJECT' } as any, execute: async () => { executions++; return {}; } });
  const runner = new ToolRunner(registry.createScope('empty-scope', []), new Workspace(process.cwd()), new PermissionManager('auto_approve'), undefined, undefined, undefined, registry);
  for (const phase of ['plan', 'implement']) for (const name of ['outside_authority', 'replace_text']) {
    const outcome = await runner.run(name, {}, { controlMode: 'enforce', decisionId: 'bound', allowedToolNames: [], allowedToolSetHash: hashAllowedToolSet([]), classificationPhase: phase });
    assert.equal(outcome.result.errorCode, 'TOOL_NOT_ALLOWED_THIS_TURN');
    if (phase === 'plan') assert.match(outcome.result.recoverySuggestion, /request_phase_transition/);
  }
  assert.equal(executions, 0);
});

test('phase gate excludes effects from exploration/planning and retains authorized edits in implementation', () => {
  const registry = new ToolRegistry();
  const gate = new ThisTurnToolGate();
  for (const phase of ['explore', 'plan'] as const) {
    const classification = { ...new ClassificationEngine().classify({ request: 'Review this code' }), phase };
    const decision = gate.decide(classification, registry.getAll());
    for (const name of ['replace_text', 'apply_patch', 'run_node_script']) assert.equal(decision.allowedToolNames.includes(name), false, `${phase}:${name}`);
    assert.ok(decision.allowedToolNames.includes('run_command'));
  }
  assert.ok(gate.decide(new ClassificationEngine().classify({ request: 'Fix this function' }), registry.getAll()).allowedToolNames.includes('replace_text'));
});

test('mixed review and mutation requests share the classifier mutation vocabulary', () => {
  for (const request of ['Review and add tests', 'Inspect and update this function', 'Review then remove the unused method', 'Phân tích rồi thêm kiểm tra', 'Kiểm tra và cập nhật hàm này', 'Review and refactor this method']) {
    assert.equal(isReadOnlyRequest(request), false, request);
    assert.notEqual(new ClassificationEngine().classify({ request }).reversibility, 'read-only', request);
  }
  assert.equal(isReadOnlyRequest('Review this function, do not edit code'), true);
});

test('fresh verification supersedes a failed check and later mutation invalidates verification', () => {
  const session = new Session();
  const classification = new ClassificationEngine().classify({ request: 'Fix this function' });
  session.append('turn/start', { turn: 1 });
  session.append('control/decision', { turn: 1, controlDecision: { classification } });
  const mutate = (id: string) => {
    session.append('tool/call', { turn: 1, toolName: 'replace_text', toolCallId: id, args: { path: 'src/a.ts' } });
    session.append('tool/result', { turn: 1, toolName: 'replace_text', toolCallId: id, result: { success: true, path: 'src/a.ts' } });
  };
  mutate('edit-1'); recordImplementationCompleted(session, 1, 'npm test'); recordVerificationOutcome(session, 1, 'npm test', false, false);
  assert.equal(applyPhaseAuthority(classification, session, 1).phase, 'implement');
  mutate('edit-2'); recordImplementationCompleted(session, 1, 'npm test'); recordVerificationOutcome(session, 1, 'npm test', true, true);
  assert.equal(applyPhaseAuthority(classification, session, 1).phase, 'verify');
  mutate('edit-3'); assert.equal(applyPhaseAuthority(classification, session, 1).phase, 'implement');
});

test('strict sandbox checks effects and containment before allowing read commands', () => {
  const policy = new SandboxPolicyEngine(process.cwd(), 'strict');
  for (const command of ['echo text > file', 'git status && git branch new-name', 'git branch new-name', 'git diff --output=out.patch', 'find . -delete', 'rg --pre script query', 'env node script.js']) {
    assert.equal(policy.evaluateCommand(command).allowed, false, command);
  }
  assert.equal(policy.evaluateCommand('git status -s').allowed, true);
  assert.equal(policy.evaluateCommand('git branch -a').allowed, true);
  assert.equal(policy.evaluateCommand('git status -s', '..').allowed, false);
});

test('isolated substrate filters inherited blocked environment values before dispatch', async () => {
  const substrate = new IsolatedExecutionSubstrate({ workspaceRoot: process.cwd() });
  const original = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-only-value';
  let dispatched: any;
  (substrate as any).innerSubstrate = { exec: async (_command: string, options: any) => { dispatched = options; return { success: true }; } };
  try {
    await substrate.exec('git status', { env: { NODE_OPTIONS: '--invalid-option', SAFE_TEST_VARIABLE: 'retained' } });
    assert.equal(dispatched.isolatedEnv, true);
    assert.equal(dispatched.env.GITHUB_TOKEN, undefined);
    assert.equal(dispatched.env.NODE_OPTIONS, undefined);
    assert.equal(dispatched.env.SAFE_TEST_VARIABLE, 'retained');
    assert.ok(Object.keys(dispatched.env).some(key => key.toLowerCase() === 'path'));
  } finally { if (original === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = original; }
});

test('argument-dependent phase effects permit inspection but deny shell and Git writes', () => {
  const fixture = (name: string) => ({ name, description: 'fixture', parameters: {}, execute: async () => ({}) });
  for (const phase of ['explore', 'plan']) {
    assert.equal(checkPhaseToolEffect(fixture('run_command'), { command: 'git status -s' }, phase, process.cwd()).allowed, true);
    assert.equal(checkPhaseToolEffect(fixture('run_command'), { command: 'node write-script.js' }, phase, process.cwd()).allowed, false);
    assert.equal(checkPhaseToolEffect(fixture('git_command'), { subcommand: 'branch', args: ['-a'] }, phase, process.cwd()).allowed, true);
    assert.equal(checkPhaseToolEffect(fixture('git_command'), { subcommand: 'branch', args: ['new-name'] }, phase, process.cwd()).allowed, false);
    assert.equal(checkPhaseToolEffect(fixture('run_node_script'), {}, phase, process.cwd()).allowed, false);
    assert.equal(checkPhaseToolEffect(fixture('read_file'), {}, phase, process.cwd()).allowed, true);
  }
});
