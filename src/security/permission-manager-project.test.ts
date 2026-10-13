import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionManager } from './permission-manager.js';

test('project override wins over global mode and clears back to it', async () => {
  const permissions = new PermissionManager('ask_sensitive');
  permissions.setWorkspaceRoot('/proj/a');
  // Baseline: MEDIUM write needs approval without a handler.
  assert.equal((await permissions.checkPermission('write_file', { path: 'a.ts' })).allowed, false);

  permissions.setProjectMode('/proj/a', 'auto_approve');
  assert.equal(permissions.getProjectMode('/proj/a'), 'auto_approve');
  assert.equal(permissions.effectiveMode(), 'auto_approve');
  assert.equal((await permissions.checkPermission('write_file', { path: 'a.ts' })).allowed, true);

  // Other projects are unaffected.
  permissions.setWorkspaceRoot('/proj/b');
  assert.equal(permissions.effectiveMode(), 'ask_sensitive');

  permissions.setWorkspaceRoot('/proj/a');
  permissions.setProjectMode('/proj/a', null);
  assert.equal(permissions.getProjectMode('/proj/a'), undefined);
  assert.equal(permissions.effectiveMode(), 'ask_sensitive');
});

test('plan lock forces read_only over any project override', async () => {
  const permissions = new PermissionManager('ask_sensitive');
  permissions.setWorkspaceRoot('/proj/a');
  permissions.setProjectMode('/proj/a', 'auto_approve');
  permissions.setPlanLock(true);
  assert.equal(permissions.effectiveMode(), 'read_only');
  assert.equal((await permissions.checkPermission('write_file', { path: 'a.ts' })).allowed, false);
  permissions.setPlanLock(false);
  assert.equal(permissions.effectiveMode(), 'auto_approve');
});
