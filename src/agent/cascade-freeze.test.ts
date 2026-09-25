import test from 'node:test';
import assert from 'node:assert/strict';
import { ReflectionEngine } from './reflection-engine.js';
import { ToolUseGuardian } from '../tools/tool-use-guardian.js';

function replaceFailure(message: string) {
  return {
    toolName: 'replace_text',
    args: { path: 'src/a.ts', oldText: 'x', newText: 'y' },
    result: { error: message, errorCode: 'TARGET_NOT_FOUND' },
    durationMs: 1,
  };
}

test('same-signature failures accumulate a streak', () => {
  const engine = new ReflectionEngine();
  engine.analyze(replaceFailure('oldText not found'));
  engine.analyze(replaceFailure('oldText not found'));
  assert.equal(engine.getSameSignatureFailStreak()?.count, 2);
  engine.analyze(replaceFailure('oldText not found'));
  assert.equal(engine.getSameSignatureFailStreak()?.count, 3);
});

test('a different error signature resets the streak', () => {
  const engine = new ReflectionEngine();
  engine.analyze(replaceFailure('oldText not found'));
  engine.analyze(replaceFailure('oldText not found'));
  engine.analyze(replaceFailure('ambiguous match found'));
  assert.equal(engine.getSameSignatureFailStreak()?.count, 1);
});

test('verified success clears the streak', () => {
  const engine = new ReflectionEngine();
  engine.analyze(replaceFailure('oldText not found'));
  engine.analyze(replaceFailure('oldText not found'));
  engine.analyze({
    toolName: 'run_command',
    args: { command: 'npm test' },
    result: { success: true, exitCode: 0, stdout: 'pass', stderr: '' },
    durationMs: 5,
  });
  assert.equal(engine.getSameSignatureFailStreak(), undefined);
});

test('guardian freezes mutations while cascade is latched', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  const frozen = guardian.preCallValidate(
    'replace_text',
    { path: 'src/a.ts', oldText: 'x', newText: 'y' },
    undefined,
    { preMutationGate: { hasValidatedHypothesis: false, cascadeFrozen: true, cascadeReason: '3 consecutive failures share one error signature' } },
  );
  assert.equal(frozen.allowed, false);
  assert.equal(frozen.errorCode, 'CASCADE_REPAIR_FROZEN');
});

test('guardian allows mutations when no cascade is latched', () => {
  const guardian = new ToolUseGuardian({ workspaceDir: process.cwd() });
  const ok = guardian.preCallValidate(
    'replace_text',
    { path: 'src/a.ts', oldText: 'x', newText: 'y' },
  );
  assert.equal(ok.allowed, true);
});
