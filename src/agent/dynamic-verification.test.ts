import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VerificationPolicy } from '../skills/verification-policy.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentLoop } from './agent-loop.js';
import { Session } from '../session/session.js';
import { ToolRegistry } from '../tools/registry.js';
import { Workspace } from '../workspace/workspace.js';

test('R2 dynamically requires typecheck/build or stronger evidence', () => {
  const policy = new VerificationPolicy();
  policy.setRequiredRisk('R2');
  policy.recordModification('src/a.ts');
  policy.recordVerification('npm run lint', true);
  assert.equal(policy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
  policy.recordVerification('get_diagnostics', true);
  assert.equal(policy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
  policy.recordVerification('npm run build', true);
  assert.equal(policy.canComplete().allowed, true);
});

test('measured callers and sensitive paths require behavioral tests', () => {
  for (const sensitive of [false, true]) {
    const policy = new VerificationPolicy();
    policy.recordModification(sensitive ? 'src/auth/login.ts' : 'src/a.ts');
    policy.recordVerification('npm run build', true);
    const measured = sensitive ? undefined : { hasCallers: true };
    assert.equal(policy.canComplete([], measured).errorCode, 'VERIFICATION_TIER_REQUIRED');
    policy.recordVerification('vitest run src/a.test.ts', true, undefined, 0, { stdout: 'Tests  2 passed (2)' });
    assert.equal(policy.canComplete([], measured).allowed, true);
  }
});

test('critical blast requires full regression and preserves its obligation after further edits', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts', { risk: 'CRITICAL' });
  policy.recordVerification('vitest run src/a.test.ts', true, undefined, 0, { stdout: 'Tests  2 passed (2)' });
  assert.equal(policy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
  policy.recordVerification('npm test', true, undefined, 0, { stdout: 'Tests  12 passed (12)' });
  assert.equal(policy.canComplete().allowed, true);
  policy.recordModification('src/b.ts');
  policy.recordVerification('npm run build', true);
  assert.equal(policy.canComplete().allowed, false);
});

test('an impacted suite must be rerun after a later mutation', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts', { impactedTestSuites: ['a.test.ts'] });
  policy.recordVerification('vitest run a.test.ts', true);
  assert.equal(policy.canComplete().allowed, true);
  policy.recordModification('src/a.ts');
  policy.recordVerification('npm run build', true);
  assert.equal(policy.canComplete().errorCode, 'IMPACTED_TESTS_REQUIRED');
});

test('full regression obligations honor explicit exemptions and reset between turns', () => {
  const policy = new VerificationPolicy();
  policy.setRequiredRisk('R4');
  policy.recordModification('src/a.ts');
  policy.recordVerification('npm run build', true);
  assert.equal(policy.canComplete().allowed, false);
  assert.equal(policy.canComplete([], undefined, { userExemptsTesting: true }).allowed, true);
  policy.reset();
  policy.recordModification('src/a.ts');
  policy.recordVerification('get_diagnostics', true);
  assert.equal(policy.canComplete().allowed, true);
});

test('a later failed behavioral check cannot be hidden by a successful build', () => {
  for (const risk of ['R3', 'R4'] as const) {
  const policy = new VerificationPolicy();
  policy.setRequiredRisk(risk);
  policy.recordModification('src/a.ts');
  policy.recordVerification('npm test', true);
  policy.recordVerification('vitest run src/a.test.ts', false);
  policy.recordVerification('npm run build', true);
  assert.equal(policy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
  }
});

test('risk escalates from fresh evidence without another edit', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts');
  policy.recordVerification('get_diagnostics', true);
  assert.equal(policy.canComplete().allowed, true);
  policy.setRequiredRisk('R3');
  assert.equal(policy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
});

test('critical full-suite checks may run serially', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts', { risk: 'CRITICAL' });
  policy.recordVerification('npx jest --runInBand', true);
  assert.equal(policy.canComplete().allowed, true);
});

test('filtered tests cannot satisfy full regression even when they exit successfully', () => {
  for (const command of ['npx jest --testPathPattern=login', 'pytest -k login', 'pytest tests/test_login.py', 'pytest -q tests/test_login.py', 'pytest -q tests', 'cargo test --lib', 'cargo test -p core', 'go test ./... -run Login', 'npx vitest run -t login', 'npm run test:completion', 'node --test --test-name-pattern login']) {
    const policy = new VerificationPolicy();
    policy.recordModification('src/a.ts', { risk: 'CRITICAL' });
    policy.recordVerification(command, true, undefined, 0);
    assert.equal(policy.canComplete().allowed, false, command);
  }
});

test('AgentLoop attributes diagnostics and scoped run_test_suite evidence correctly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-verify-attribution-'));
  try {
    for (const toolName of ['get_diagnostics', 'run_test_suite']) {
      const registry = new ToolRegistry();
      registry.register({ name: toolName, description: 'Scripted verification outcome',
        parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' } } } as any,
        execute: async () => toolName === 'get_diagnostics'
          ? { success: true, clean: true, totalErrors: 0 }
          : { success: true, isPassed: true, exitCode: 0, commandExecuted: 'npx vitest run src/a.test.ts', summary: 'Tests  2 passed (2)' } });
      let calls = 0;
      const llm = { modelName: 'scripted-flash', getTokenConfig: () => ({ maxInputTokens: 32000, maxOutputTokens: 2000 }),
        async generate() {
          calls++;
          // Seed measured mutation state; exercise the real tool-result attribution branch.
          loop.verificationPolicy.setRequiredRisk(toolName === 'get_diagnostics' ? 'R2' : 'R4');
          loop.verificationPolicy.recordModification('src/a.ts');
          return { toolCalls: [{ id: `verify-${toolName}`, name: toolName, args: toolName === 'run_test_suite' ? { command: 'npx vitest run src/a.test.ts' } : {} }] };
        } };
      const loop = new AgentLoop(llm, registry, { workspace: new Workspace(root), maxSteps: 1,
        toolControlMode: 'off', enableDynamicToolRetrieval: false, enableGraphRepositoryMap: false,
        enableRepositoryMemory: false, enableStepSummarization: false });
      const session = new Session(); session.addUserMessage('Verify the source changes using project tests and diagnostics.');
      await loop.run(session, { maxSteps: 1 });
      assert.equal(calls, 1);
      assert.equal(loop.verificationPolicy.getLastVerification()?.tier, toolName === 'get_diagnostics' ? 'diagnostics' : 'targeted_test');
      assert.equal(loop.verificationPolicy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('broad file scope triggers full regression but docs alone remain exempt', () => {
  const policy = new VerificationPolicy();
  for (let i = 0; i < 10; i++) policy.recordModification(`src/file${i}.ts`);
  policy.recordVerification('vitest run src/file0.test.ts', true);
  assert.equal(policy.canComplete().errorCode, 'VERIFICATION_TIER_REQUIRED');
  policy.recordVerification('npm test', true);
  assert.equal(policy.canComplete().allowed, true);
  policy.reset();
  for (let i = 0; i < 10; i++) policy.recordModification(`docs/file${i}.md`);
  assert.equal(policy.canComplete().allowed, true);
});

test('AgentLoop injects measured verification after a single mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-dynamic-verify-'));
  try {
    await fs.writeFile(path.join(root, 'a.ts'), 'before');
    const registry = new ToolRegistry();
    registry.register({ name: 'read_file', description: 'Read the target',
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } as any,
      execute: async () => ({ success: true, path: 'a.ts', content: 'before' }) });
    registry.register({ name: 'replace_text', description: 'Replace the target',
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, oldText: { type: 'STRING' }, newText: { type: 'STRING' } }, required: ['path', 'oldText', 'newText'] } as any,
      execute: async () => {
        await fs.writeFile(path.join(root, 'a.ts'), 'after');
        return { success: true, path: 'a.ts', replacements: 1, blastRadius: { risk: 'CRITICAL' } };
      } });
    const prompts: string[] = [];
    let index = 0;
    const replies = [
      { toolCalls: [{ id: 'read', name: 'read_file', args: { path: 'a.ts' } }] },
      { toolCalls: [{ id: 'edit', name: 'replace_text', args: { path: 'a.ts', oldText: 'before', newText: 'after' } }] },
      { text: 'The requested source mutation is complete, verification remains pending.', toolCalls: [] },
    ];
    const loop = new AgentLoop({ modelName: 'scripted-flash',
      getTokenConfig: () => ({ maxInputTokens: 32000, maxOutputTokens: 2000 }),
      async generate(_session: Session, _tools: any[], request: any) {
        prompts.push(request.dynamicContext || '');
        return replies[index++];
      } }, registry, { workspace: new Workspace(root), maxSteps: 3,
        toolControlMode: 'off', enableDynamicToolRetrieval: false, enableRepositoryMemory: false,
        enableGraphRepositoryMap: false, enableStepSummarization: false });
    const session = new Session(); session.addUserMessage('Update a.ts from before to after.');
    await loop.run(session, { maxSteps: 3 });
    assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'after');
    assert.match(prompts.at(-1) || '', /DYNAMIC VERIFICATION.*Required: full_test/);
    assert.equal(loop.verificationPolicy.canComplete().allowed, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
