import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionEvidenceGate } from './completion-evidence.js';
import { Session } from '../session/session.js';

function record(session: Session, turn: number, toolName: string, args: Record<string, any>, result: Record<string, any>): void {
  const toolCallId = `call-${session.getEvents().length}`;
  session.append('tool/call', { turn, step: 1, toolCallId, toolName, args });
  session.append('tool/result', { turn, step: 1, toolCallId, toolName, result });
}

test('fail-to-pass: bugfix with failing check before mutation and pass after is allowed', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  // 1. Failing check before mutation
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 1, commandOutcome: 'failed' });
  // 2. Mutation
  record(session, 1, 'replace_text', { filePath: 'src/fix.ts', find: 'a', replace: 'b' }, { success: true });
  // 3. Passing check after mutation
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  const decision = gate.evaluate('Fixed bug and verified tests pass.', session, { turn: 1, taskClass: 'bugfix' });
  assert.equal(decision.allow, true);
});

test('fail-to-pass: bugfix without pre-fix failing check is blocked even if post-fix passes', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  // No pre-fix check; directly mutate
  record(session, 1, 'replace_text', { filePath: 'src/fix.ts', find: 'a', replace: 'b' }, { success: true });
  // Passing check after mutation
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  const decision = gate.evaluate('Fixed bug and verified tests pass.', session, { turn: 1, taskClass: 'bugfix' });
  assert.equal(decision.allow, false);
  assert.ok(decision.reasons.some((r) => r.includes('reproduction proof or a failing test')));
});

test('fail-to-pass: blocked pre-flight check does not count as reproduction; post-fix pass alone is blocked', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  // Blocked command before mutation (e.g. timeout or blocked outcome)
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: false, blocked: true, commandOutcome: 'blocked_preflight' });
  // Mutation
  record(session, 1, 'replace_text', { filePath: 'src/fix.ts', find: 'a', replace: 'b' }, { success: true });
  // Passing check after mutation
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  const decision = gate.evaluate('Fixed bug and verified tests pass.', session, { turn: 1, taskClass: 'bugfix' });
  assert.equal(decision.allow, false);
  assert.ok(decision.reasons.some((r) => r.includes('reproduction proof or a failing test')));
});

test('fail-to-pass: feature task without pre-fix failing check is allowed when post-fix passes', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  // Directly mutate for a feature task
  record(session, 1, 'replace_text', { filePath: 'src/feature.ts', find: 'a', replace: 'b' }, { success: true });
  // Passing check after mutation
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  const decision = gate.evaluate('Implemented feature and verified tests pass.', session, { turn: 1, taskClass: 'feature' });
  assert.equal(decision.allow, true);
});

test('fail-to-pass: bugfix with user exemption (/no-verify) is allowed without pre-fix failure', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  record(session, 1, 'replace_text', { filePath: 'src/fix.ts', find: 'a', replace: 'b' }, { success: true });
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  const decision = gate.evaluate('Fixed bug.', session, {
    turn: 1,
    taskClass: 'bugfix',
    userRequest: 'Fix the bug /no-verify',
  });
  assert.equal(decision.allow, true);
});

test('fail-to-pass: kill-switch MINUS_FAIL_TO_PASS_GATE=off allows post-fix pass without pre-fix failure', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  record(session, 1, 'replace_text', { filePath: 'src/fix.ts', find: 'a', replace: 'b' }, { success: true });
  record(session, 1, 'run_command', { command: 'npm test' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  const oldEnv = process.env.MINUS_FAIL_TO_PASS_GATE;
  try {
    process.env.MINUS_FAIL_TO_PASS_GATE = 'off';
    const decision = gate.evaluate('Fixed bug and verified tests pass.', session, { turn: 1, taskClass: 'bugfix' });
    assert.equal(decision.allow, true);
  } finally {
    if (oldEnv === undefined) {
      delete process.env.MINUS_FAIL_TO_PASS_GATE;
    } else {
      process.env.MINUS_FAIL_TO_PASS_GATE = oldEnv;
    }
  }
});

test('fail-to-pass: docs-only mutation is allowed without reproduction', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  record(session, 1, 'replace_text', { filePath: 'docs/README.md', find: 'old', replace: 'new' }, { success: true });

  const decision = gate.evaluate('Updated docs.', session, { turn: 1, taskClass: 'bugfix' });
  assert.equal(decision.allow, true);
});

test('unrelated test failure: gate rejects answer when final answer omits mentioning unrelated test failure', () => {
  const gate = new CompletionEvidenceGate();
  const session = new Session();

  record(session, 1, 'replace_text', { filePath: 'src/feature.ts', find: 'a', replace: 'b' }, { success: true });
  record(
    session,
    1,
    'run_command',
    { command: 'npm test -- src/test.ts' },
    {
      processStarted: true,
      exitCode: 1,
      commandOutcome: 'failed_unexpected',
      _unrelated_test_failure: '⚠️ [UNRELATED TEST FAILURE]: Verification command failed on unrelated files.',
    },
  );
  record(session, 1, 'run_command', { command: 'npx tsc --noEmit' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

  // Answer only mentions tsc passing, completely omitting the unrelated test failure
  const decision = gate.evaluate(
    'Tôi đã hoàn tất việc sửa code và npx tsc --noEmit đã hoàn thành thành công.',
    session,
    { turn: 1, taskClass: 'feature' },
  );

  assert.equal(decision.allow, false);
  assert.ok(decision.reasons.some((r) => r.includes('A verification command failed during this turn due to an unrelated/pre-existing failure')));
  assert.equal(decision.recovery, 'revise-answer');
});

test('unrelated test failure: gate accepts answer when final answer discloses unrelated test failure (English & Vietnamese)', () => {
  const gate = new CompletionEvidenceGate();

  // Test Vietnamese disclosure
  {
    const sessionVi = new Session();
    record(sessionVi, 1, 'replace_text', { filePath: 'src/feature.ts', find: 'a', replace: 'b' }, { success: true });
    record(
      sessionVi,
      1,
      'run_command',
      { command: 'npm test' },
      {
        processStarted: true,
        exitCode: 1,
        _unrelated_test_failure: '⚠️ [UNRELATED TEST FAILURE]: Verification command failed on unrelated files.',
      },
    );
    record(sessionVi, 1, 'run_command', { command: 'npx tsc --noEmit' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

    const decisionVi = gate.evaluate(
      'Đã hoàn thành sửa mã nguồn. Lưu ý: Lệnh kiểm thử npm test bị thất bại nhưng lỗi này không liên quan đến phạm vi sửa đổi.',
      sessionVi,
      { turn: 1, taskClass: 'feature' },
    );
    assert.equal(decisionVi.allow, true);
  }

  // Test English disclosure
  {
    const sessionEn = new Session();
    record(sessionEn, 1, 'replace_text', { filePath: 'src/feature.ts', find: 'a', replace: 'b' }, { success: true });
    record(
      sessionEn,
      1,
      'run_command',
      { command: 'npm test' },
      {
        processStarted: true,
        exitCode: 1,
        _unrelated_test_failure: '⚠️ [UNRELATED TEST FAILURE]: Verification command failed on unrelated files.',
      },
    );
    record(sessionEn, 1, 'run_command', { command: 'npx tsc --noEmit' }, { processStarted: true, exitCode: 0, commandOutcome: 'succeeded' });

    const decisionEn = gate.evaluate(
      'I completed the code change. Note: verification test suite failed due to unrelated pre-existing failures in legacy tests.',
      sessionEn,
      { turn: 1, taskClass: 'feature' },
    );
    assert.equal(decisionEn.allow, true);
  }
});


