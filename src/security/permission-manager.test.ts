import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionManager } from './permission-manager.js';

test('hasApprovalChannel reflects prompt handler presence', () => {
  const pm = new PermissionManager();
  assert.equal(pm.hasApprovalChannel(), false);
  pm.setPromptHandler(async () => 'approve');
  assert.equal(pm.hasApprovalChannel(), true);
});

test('approve_all_session is scoped to approved command prefixes', async () => {
  let prompts = 0;
  const pm = new PermissionManager();
  pm.setPromptHandler(async () => {
    prompts += 1;
    return 'approve_all_session';
  });

  const first = await pm.checkPermission('run_command', { command: 'go test ./...' });
  assert.equal(first.allowed, true);
  assert.equal(prompts, 1);

  // Same prefix: auto-allowed without prompting again.
  const samePrefix = await pm.checkPermission('run_command', { command: 'go vet ./...' });
  assert.equal(samePrefix.allowed, true);
  assert.equal(prompts, 1);

  // New prefix: prompted again, then recorded.
  const otherPrefix = await pm.checkPermission('run_command', { command: 'docker ps' });
  assert.equal(otherPrefix.allowed, true);
  assert.equal(prompts, 2);

  // Earlier prefixes stay approved.
  const again = await pm.checkPermission('run_command', { command: 'go test ./...' });
  assert.equal(again.allowed, true);
  assert.equal(prompts, 2);

  pm.clearSessionApprovals();
  const afterClear = await pm.checkPermission('run_command', { command: 'go test ./...' });
  assert.equal(afterClear.allowed, true);
  assert.equal(prompts, 3);
});

test('delete_file approval request describes every target and recursion', async () => {
  const pm = new PermissionManager();
  let captured: any;
  pm.setPromptHandler(async (request) => {
    captured = request;
    return 'reject';
  });

  await pm.checkPermission('delete_file', { paths: ['dist', 'tmp'], recursive: true });
  assert.match(captured.summary, /Delete 2 path\(s\) recursively/);
  assert.ok(captured.summary.includes('dist') && captured.summary.includes('tmp'));

  await pm.checkPermission('delete_file', { path: 'one.txt', recursive: false });
  assert.match(captured.summary, /Delete 1 path\(s\) from workspace/);
  assert.ok(!captured.summary.includes('recursively'));
});
