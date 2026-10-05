import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerificationPolicy, isCommentOnlyChange } from './verification-policy.js';
import { isNonExecutableFile } from '../agent/completion-evidence.js';

test('VerificationPolicy blocks mutation in bugfix mode when reproduction proof is missing and gate is enforced', () => {
  const policy = new VerificationPolicy();

  // In observe mode, mutation is allowed
  const observeCheck = policy.canMutate('bugfix', 'observe');
  assert.equal(observeCheck.allowed, true);

  // In enforce mode without reproduction test, mutation is blocked
  const enforceCheck = policy.canMutate('bugfix', 'enforce');
  assert.equal(enforceCheck.allowed, false);
  assert.match(enforceCheck.reason || '', /REPRODUCTION_GATE_BLOCKED/);

  // After recording a failed test execution (reproduction proof established)
  policy.recordReproductionAttempt('npm test -- --filter=auth', true);
  assert.equal(policy.hasReproduction(), true);
  assert.equal(policy.getReproductionCommand(), 'npm test -- --filter=auth');

  // Now mutation is allowed in enforce mode
  const afterReproductionCheck = policy.canMutate('bugfix', 'enforce');
  assert.equal(afterReproductionCheck.allowed, true);

  // Non-bugfix tasks are always allowed
  assert.equal(policy.canMutate('feature', 'enforce').allowed, true);
});

test('VerificationPolicy allows scratch and test reproduction file mutations unconditionally', () => {
  const policy = new VerificationPolicy();

  // Scratch files are allowed even in enforce mode without reproduction proof
  const scratchCheck1 = policy.canMutate('bugfix', 'enforce', { targetFilePath: 'scratch/reproduce_auth.py' });
  assert.equal(scratchCheck1.allowed, true);

  const scratchCheck2 = policy.canMutate('bugfix', 'enforce', { targetFilePath: 'temp/repro_test.ts', isScratchFile: true });
  assert.equal(scratchCheck2.allowed, true);

  // Production files remain blocked without reproduction proof (unknown risk = conservative)
  const prodCheck = policy.canMutate('bugfix', 'enforce', { targetFilePath: 'src/auth/service.ts' });
  assert.equal(prodCheck.allowed, false);

  // Low/medium risk downgrades to advisory: allowed, with guidance attached
  const lowRiskCheck = policy.canMutate('bugfix', 'enforce', {
    targetFilePath: 'src/auth/service.ts',
    riskLevel: 'R2',
  });
  assert.equal(lowRiskCheck.allowed, true);
  assert.ok(lowRiskCheck.advisory?.includes('REPRODUCTION_GATE_ADVISORY'));

  // HIGH/CRITICAL stays enforced
  const highRiskCheck = policy.canMutate('bugfix', 'enforce', {
    targetFilePath: 'src/auth/service.ts',
    riskLevel: 'R4',
  });
  assert.equal(highRiskCheck.allowed, false);
  assert.match(highRiskCheck.reason || '', /REPRODUCTION_GATE_BLOCKED/);

  // But allowed if criticApproved is true
  const criticApprovedCheck = policy.canMutate('bugfix', 'enforce', {
    targetFilePath: 'src/auth/service.ts',
    criticApproved: true,
  });
  assert.equal(criticApprovedCheck.allowed, true);
});

test('VerificationPolicy reset clears reproduction proof', () => {
  const policy = new VerificationPolicy();
  policy.recordReproductionAttempt('pytest tests/test_bug.py', true);
  assert.equal(policy.hasReproduction(), true);

  policy.reset();
  assert.equal(policy.hasReproduction(), false);
  assert.equal(policy.getReproductionCommand(), undefined);
});

test('Trivial single-script direct run exit 0 counts as verification (R0)', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('scripts/hello.py');
  policy.recordVerification('python scripts/hello.py', true, 'hello world', 0);
  assert.equal(policy.canComplete().allowed, true);

  // Non-direct command on the same state still blocked
  const blocked = new VerificationPolicy();
  blocked.recordModification('scripts/hello.py');
  blocked.recordVerification('python scripts/other.py', true, 'ok', 0);
  assert.equal(blocked.canComplete().allowed, false);

  // Multi-file scope still requires a real verification command
  const multi = new VerificationPolicy();
  multi.recordModification('scripts/a.py');
  multi.recordModification('scripts/b.py');
  multi.recordVerification('python scripts/a.py', true, 'ok', 0);
  assert.equal(multi.canComplete().allowed, false);
});

test('Comment-only edits bypass the test gate, code edits revoke it', () => {
  assert.equal(isCommentOnlyChange('const a = 1;', 'const a = 1;\n// note'), true);
  assert.equal(isCommentOnlyChange('const a = 1;', 'const a = 2; // note'), false);
  assert.equal(isCommentOnlyChange('x = 1', '# ghi chú\nx = 1'), true);

  const policy = new VerificationPolicy();
  policy.recordModification('src/utils/format.ts', { commentOnly: true });
  assert.equal(policy.canComplete().allowed, true);

  // Later real edit on the same file revokes the bypass
  policy.recordModification('src/utils/format.ts');
  assert.equal(policy.canComplete().allowed, false);

  // Sensitive path stays gated even for comments
  const sensitive = new VerificationPolicy();
  sensitive.recordModification('src/auth/service.ts', { commentOnly: true });
  assert.equal(sensitive.canComplete().allowed, false);
});

test('User-explicit test exemption bypasses the gate', () => {
  const policy = new VerificationPolicy();
  policy.recordModification('src/index.ts');
  assert.equal(policy.canComplete().allowed, false);
  assert.equal(policy.canComplete([], undefined, { userExemptsTesting: true }).allowed, true);
});

test('Net-zero diff and deleted scratch bypass via git status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-inert-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'f.ts'), 'export const x = 1;\n');
  git(['add', 'f.ts']);
  git(['commit', '-m', 'init']);

  const policy = new VerificationPolicy();
  policy.setWorkspaceRoot(dir);
  fs.writeFileSync(path.join(dir, 'f.ts'), 'export const x = 2;\n');
  policy.recordModification('f.ts');
  assert.equal(policy.canComplete().allowed, false);

  // Revert -> net-zero diff -> bypass
  fs.writeFileSync(path.join(dir, 'f.ts'), 'export const x = 1;\n');
  assert.equal(policy.canComplete().allowed, true);

  // Deleted untracked scratch file -> no effective change
  const scratch = new VerificationPolicy();
  scratch.setWorkspaceRoot(dir);
  scratch.recordModification('scratch/repro_xyz.py');
  assert.equal(scratch.canComplete().allowed, true);

  // Tracked deletion is still a real change
  const del = new VerificationPolicy();
  del.setWorkspaceRoot(dir);
  fs.unlinkSync(path.join(dir, 'f.ts'));
  del.recordModification('f.ts');
  assert.equal(del.canComplete().allowed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Pure rename bypasses, later real edit revokes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-move-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(['add', 'a.ts']);
  git(['commit', '-m', 'init']);

  const policy = new VerificationPolicy();
  policy.setWorkspaceRoot(dir);
  policy.recordContentPreservedMove('a.ts', 'b.ts');
  assert.equal(policy.canComplete().allowed, true);

  // Real edit to the moved target revokes the bypass (disk is dirty)
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
  policy.recordModification('a.ts');
  assert.equal(policy.canComplete().allowed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Formatter whitespace noise bypasses, string spacing does not', () => {
  assert.equal(isCommentOnlyChange('x  =  1', 'x = 1'), true);
  assert.equal(isCommentOnlyChange('const s = "a b";', 'const s = "ab";'), false);
});

test('Schema/data extensions count as non-executable', () => {
  assert.equal(isNonExecutableFile('db/schema.sql'), true);
  assert.equal(isNonExecutableFile('api/schema.graphql'), true);
  assert.equal(isNonExecutableFile('api/schema.proto'), true);
  const policy = new VerificationPolicy();
  policy.recordModification('db/schema.sql');
  assert.equal(policy.canComplete().allowed, true);
});

test('Repair budget counts only same-signature repeats, resets on novelty', () => {  const policy = new VerificationPolicy();
  assert.equal(policy.isRepairExhausted(), false);
  policy.recordRepairAttempt(1);
  assert.equal(policy.isRepairExhausted(), false);
  policy.recordRepairAttempt(2);
  assert.equal(policy.isRepairExhausted(), false);
  assert.equal(policy.getRepairCycles(), 2);
  // Novel failure signature resets the budget instead of consuming it
  policy.recordRepairAttempt(1);
  assert.equal(policy.isRepairExhausted(), false);
  assert.equal(policy.getRepairCycles(), 0);
  // Third consecutive identical failure exhausts the budget (LATS backtracking)
  policy.recordRepairAttempt(2);
  policy.recordRepairAttempt(3);
  assert.equal(policy.isRepairExhausted(), true);
});
