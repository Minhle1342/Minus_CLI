import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateVerificationCoverage } from './verification-coverage.js';
import { VerificationPolicy } from '../skills/verification-policy.js';

const MODIFIED = ['src/auth/login.ts'];

test('jest zero-total success with modifications is proven-empty', () => {
  const coverage = evaluateVerificationCoverage({
    command: 'npx jest --testNamePattern=nonexistent',
    success: true,
    stdout: 'Tests: 0 total\nTime: 1s',
    modifiedFiles: MODIFIED,
  });
  assert.equal(coverage.verdict, 'insufficient');
  assert.equal(coverage.executedTests, 0);
  assert.equal(coverage.runner, 'jest');
  assert.match(coverage.findings[0], /0 tests/);
});

test('no-tests-found marker without a summary is proven-empty', () => {
  for (const stdout of ['No tests found, exiting with code 0', 'collected 0 items', 'no test files found for "x"']) {
    const coverage = evaluateVerificationCoverage({
      command: 'npm test',
      success: true,
      stdout,
      stderr: '',
      modifiedFiles: MODIFIED,
    });
    assert.equal(coverage.verdict, 'insufficient', stdout);
  }
});

test('runner summaries with executed tests parse across ecosystems', () => {
  const cases: Array<[string, string, number, string]> = [
    ['npx jest', 'Tests: 3 passed, 3 total', 3, 'jest'],
    ['npx vitest run', 'Test Files  1 passed (1)\nTests  12 passed (12)', 12, 'vitest'],
    ['npx mocha', '15 passing (2s)', 15, 'mocha'],
    ['pytest', '42 passed in 1.2s', 42, 'pytest'],
    ['cargo test', 'test result: ok. 7 passed; 0 failed;', 7, 'cargo'],
    ['dotnet test', 'Passed! - Failed: 0, Passed: 9, Skipped: 0', 9, 'dotnet'],
    ['go test ./...', 'ok  example.com/pkg  0.1s', 1, 'go'],
  ];
  for (const [command, stdout, executed, runner] of cases) {
    const coverage = evaluateVerificationCoverage({ command, success: true, stdout, modifiedFiles: MODIFIED });
    assert.equal(coverage.verdict, 'sufficient', command);
    assert.equal(coverage.executedTests, executed, command);
    assert.equal(coverage.runner, runner, command);
  }
});

test('unparseable output stays unknown and never blocks', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/auth/login.ts');
  policy.recordVerification('npm test', true, undefined, 0, { stdout: 'some opaque log line' });
  assert.equal(policy.getLastVerification()?.coverage?.verdict, 'unknown');
  assert.equal(policy.canComplete().allowed, true);
});

test('proven-empty success blocks completion with VERIFICATION_EMPTY', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/auth/login.ts');
  policy.recordVerification('npx jest --testNamePattern=zzz', true, undefined, 0, {
    stdout: 'Tests: 0 total',
  });
  const decision = policy.canComplete();
  assert.equal(decision.allowed, false);
  assert.equal(decision.errorCode, 'VERIFICATION_EMPTY');
});

test('impacted-suite targeting yields matched/uncovered lists and partial score', () => {
  const coverage = evaluateVerificationCoverage({
    command: 'npx vitest run src/auth/login.spec.ts',
    success: true,
    stdout: 'Tests  5 passed (5)',
    modifiedFiles: MODIFIED,
    pendingSuites: ['src/auth/login.spec.ts', 'src/auth/session.spec.ts'],
  });
  assert.equal(coverage.verdict, 'partial');
  assert.deepEqual(coverage.matchedSuites, ['src/auth/login.spec.ts']);
  assert.deepEqual(coverage.uncoveredSuites, ['src/auth/session.spec.ts']);
  assert.equal(coverage.score, 0.5);
});

test('command targeting unrelated tests is partial, not blocking by itself', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/utils/format.ts');
  policy.recordVerification('npx jest src/billing/other.spec.ts', true, undefined, 0, {
    stdout: 'Tests: 4 passed, 4 total',
  });
  const coverage = policy.getLastVerification()?.coverage;
  assert.equal(coverage?.verdict, 'partial');
  assert.equal(policy.canComplete().allowed, true);
});

test('failed runs keep failure evidence in coverage without changing the gate', () => {
  const coverage = evaluateVerificationCoverage({
    command: 'npx jest',
    success: false,
    stdout: 'Tests: 1 failed, 9 passed, 10 total',
    modifiedFiles: MODIFIED,
  });
  assert.equal(coverage.verdict, 'insufficient');
  assert.equal(coverage.executedTests, 10);
});

test('coverage report keeps a well-covered run sufficient and attaches file rates', () => {
  const coverage = evaluateVerificationCoverage({
    command: 'npx jest',
    success: true,
    stdout: 'Tests: 3 passed, 3 total',
    modifiedFiles: MODIFIED,
    fileCoverage: [{ path: 'src/auth/login.ts', linesFound: 10, linesHit: 9, lineRate: 0.9 }],
    coverageSource: 'coverage/lcov.info',
  });
  assert.equal(coverage.verdict, 'sufficient');
  assert.equal(coverage.fileCoverage?.[0]?.lineRate, 0.9);
  assert.equal(coverage.coverageSource, 'coverage/lcov.info');
  assert.match(coverage.findings.join('\n'), /covers all 1 modified/);
});

test('coverage report downgrades thin or absent modified files to partial', () => {
  const thin = evaluateVerificationCoverage({
    command: 'npx jest',
    success: true,
    stdout: 'Tests: 3 passed, 3 total',
    modifiedFiles: MODIFIED,
    fileCoverage: [{ path: 'src/auth/login.ts', linesFound: 10, linesHit: 2, lineRate: 0.2 }],
    coverageSource: 'coverage/lcov.info',
  });
  assert.equal(thin.verdict, 'partial');
  assert.equal(thin.score, 0.5);
  assert.match(thin.findings[0], /thin coverage/);

  const absent = evaluateVerificationCoverage({
    command: 'npx jest',
    success: true,
    stdout: 'Tests: 3 passed, 3 total',
    modifiedFiles: MODIFIED,
    fileCoverage: [{ path: 'src/other/file.ts', linesFound: 4, linesHit: 4, lineRate: 1 }],
    coverageSource: 'coverage/lcov.info',
  });
  assert.equal(absent.verdict, 'partial');
  assert.match(absent.findings[0], /absent from report/);
});

test('coverage report never manufactures sufficiency or blocks unknown runs', () => {
  const unknown = evaluateVerificationCoverage({
    command: 'npm test',
    success: true,
    stdout: 'some opaque log line',
    modifiedFiles: MODIFIED,
    fileCoverage: [{ path: 'src/auth/login.ts', linesFound: 10, linesHit: 1, lineRate: 0.1 }],
    coverageSource: 'coverage/lcov.info',
  });
  assert.equal(unknown.verdict, 'unknown');

  const policy = new VerificationPolicy();
  policy.recordModification('src/auth/login.ts');
  policy.recordVerification('npx jest', true, undefined, 0, {
    stdout: 'Tests: 3 passed, 3 total',
    fileCoverage: [{ path: 'src/auth/login.ts', linesFound: 10, linesHit: 1, lineRate: 0.1 }],
    coverageSource: 'coverage/lcov.info',
  });
  assert.equal(policy.getLastVerification()?.coverage?.verdict, 'partial');
  assert.equal(policy.canComplete().allowed, true);
});
