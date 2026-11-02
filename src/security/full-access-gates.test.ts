import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSED_GATES,
  FULL_ACCESS_GATES,
  NON_BYPASSABLE_GATES,
  gateReport,
  gatesForMode,
  gatesFromPermissionManager,
  isGateOpen,
} from './full-access-gates.js';
import { PermissionManager } from './permission-manager.js';
import { isPermissionMode, PERMISSION_MODES } from './permission-modes.js';
import type { PermissionMode } from './permission-manager.js';

const NON_FULL_MODES: PermissionMode[] = PERMISSION_MODES
  .map((mode) => mode.id)
  .filter((id) => id !== 'full_access');

test('no gate opens for the four pre-existing modes', () => {
  for (const mode of NON_FULL_MODES) {
    for (const gate of FULL_ACCESS_GATES) {
      assert.equal(isGateOpen(gate, mode), false, `${gate} under ${mode}`);
    }
  }
});

test('full_access opens exactly the seven documented gates', () => {
  assert.deepEqual([...FULL_ACCESS_GATES].sort(), [
    'approval_prompt',
    'child_env_scrub',
    'docker_isolation',
    'host_system_risk',
    'phase_masking',
    'protected_files',
    'workspace_boundary',
  ].sort());
  for (const gate of FULL_ACCESS_GATES) {
    assert.equal(isGateOpen(gate, 'full_access'), true, gate);
    assert.equal(gatesForMode('full_access')(gate), true, gate);
  }
});

test('the bypassable and non-bypassable tables are disjoint', () => {
  for (const gate of NON_BYPASSABLE_GATES) {
    assert.equal(FULL_ACCESS_GATES.includes(gate as any), false, gate);
  }
  assert.deepEqual([...NON_BYPASSABLE_GATES].sort(), [
    'git_policy',
    'output_redaction',
    'push_to_main',
    'repo_hooks',
  ].sort());
});

test('plan lock still outranks full access because effectiveMode is the only input', () => {
  const permissions = new PermissionManager('full_access');
  assert.equal(permissions.effectiveMode(), 'full_access');
  permissions.setPlanLock(true);
  assert.equal(permissions.effectiveMode(), 'read_only');
  assert.equal(isGateOpen('approval_prompt', permissions.effectiveMode()), false);
  permissions.setPlanLock(false);
  assert.equal(isGateOpen('approval_prompt', permissions.effectiveMode()), true);
});

test('a reader with no permission source is fail-closed, and a live reader tracks mode changes', () => {
  assert.equal(CLOSED_GATES('workspace_boundary'), false);
  assert.equal(gatesFromPermissionManager(undefined)('workspace_boundary'), false);
  assert.equal(gatesFromPermissionManager(null)('approval_prompt'), false);
  // Nguồn chỉ implement một phần (stub có checkPermission/hasApprovalChannel) ⇒ vẫn đóng.
  const partial = { checkPermission: async () => ({ allowed: true }) } as any;
  assert.equal(gatesFromPermissionManager(partial)('approval_prompt'), false);
  assert.equal(gatesFromPermissionManager({} as any)('host_system_risk'), false);

  const permissions = new PermissionManager('ask_sensitive');
  const gates = gatesFromPermissionManager(permissions);
  assert.equal(gates('protected_files'), false);
  permissions.setMode('full_access');
  assert.equal(gates('protected_files'), true);
  permissions.setMode('read_only');
  assert.equal(gates('protected_files'), false);
});

test('gateReport lists both tables when the mode is on and nothing when it is off', () => {
  const report = gateReport('full_access');
  for (const gate of FULL_ACCESS_GATES) assert.ok(report.includes(gate), gate);
  for (const gate of NON_BYPASSABLE_GATES) assert.ok(report.includes(gate), gate);
  assert.equal(gateReport('read_only'), 'full access tắt · mọi gate còn hiệu lực');
  assert.ok(isPermissionMode('full_access'));
});
