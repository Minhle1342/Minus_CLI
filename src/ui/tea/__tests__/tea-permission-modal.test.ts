import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRootModel, update, view } from '../models/root-model.js';
import { stripTerminalControls } from '../styles/theme.js';
import type { Msg, PermissionStateSnapshot } from '../types.js';

const key = (k: string, text?: string): Msg => ({ type: 'key', key: k, text, now: 10 });

const snapshot: PermissionStateSnapshot = {
  globalMode: 'ask_sensitive',
  projectMode: null,
  effectiveMode: 'ask_sensitive',
  planModeActive: false,
  approvalCount: 2,
};

const open = (state: PermissionStateSnapshot = snapshot): ReturnType<typeof createRootModel> => {
  const [model] = update({ type: 'permission', open: true, state }, createRootModel({ width: 80, height: 24 }));
  return model;
};

test('permission modal opens as an action menu and keeps typing out of the composer', () => {
  let model = open();
  assert.equal(model.permission.open, true);
  assert.equal(model.focus, 'permission');
  assert.equal(model.permission.tier, 'actions');
  assert.deepEqual(model.permission.globalMode, 'ask_sensitive');
  [model] = update(key('x', 'x'), model);
  assert.equal(model.composer.value, '');
  assert.equal(model.permission.open, true);
  assert.equal(model.permission.selected, 0);
});

test('global path: enter opens mode list, current mode is marked, pick emits set-global', () => {
  let model = open();
  [model] = update(key('enter'), model);
  assert.equal(model.permission.tier, 'global');
  assert.equal(model.permission.selected, 0);
  const rendered = stripTerminalControls(view(model));
  assert.ok(rendered.includes('always_ask') && rendered.includes('auto_approve'));
  // Chọn auto_approve (hàng 3 trong PERMISSION_MODES).
  const [picked, cmds] = update(key('3', '3'), model);
  assert.equal(picked.permission.open, false);
  assert.equal(picked.focus, 'composer');
  assert.deepEqual(cmds, [{ type: 'permission-pick', choice: { action: 'set-global', mode: 'auto_approve' } }]);
});

test('project path: navigation into override list, mode pick and clear-project are separate actions', () => {
  let model = open();
  [model] = update(key('down'), model);
  [model] = update(key('enter'), model);
  assert.equal(model.permission.tier, 'project');
  // Hàng cuối là "(none — global mode applies)" = clear-project (5 mode + 1 hàng clear).
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  const [cleared, cmds] = update(key('enter'), model);
  assert.equal(cleared.permission.open, false);
  assert.deepEqual(cmds, [{ type: 'permission-pick', choice: { action: 'clear-project' } }]);
  // Project đã có override thì hàng đó mang dấu đang áp dụng.
  model = open({ ...snapshot, projectMode: 'read_only' });
  [model] = update(key('down'), model);
  [model] = update(key('enter'), model);
  const [picked, pickCmds] = update(key('4', '4'), model);
  assert.equal(picked.permission.open, false);
  assert.deepEqual(pickCmds, [{ type: 'permission-pick', choice: { action: 'set-project', mode: 'read_only' } }]);
});

test('reset path requires an explicit confirm row', () => {
  let model = open();
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('enter'), model);
  assert.equal(model.permission.tier, 'reset');
  assert.ok(stripTerminalControls(view(model)).includes('Xóa 2 category đã auto-approve'));
  const [done, cmds] = update(key('enter'), model);
  assert.equal(done.permission.open, false);
  assert.deepEqual(cmds, [{ type: 'permission-pick', choice: { action: 'reset-approvals' } }]);
  // "Quay lại" chỉ điều hướng, không phát Cmd.
  model = open();
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('enter'), model);
  [model] = update(key('down'), model);
  const [back, backCmds] = update(key('enter'), model);
  assert.equal(back.permission.tier, 'actions');
  assert.equal(back.permission.open, true);
  assert.deepEqual(backCmds, []);
});

test('Esc on a sub-tier returns to the action menu on the same row, Esc there cancels', () => {
  let model = open();
  [model] = update(key('enter'), model);
  [model] = update(key('down'), model);
  const [menu] = update(key('escape'), model);
  assert.equal(menu.permission.tier, 'actions');
  assert.equal(menu.permission.open, true);
  assert.equal(menu.permission.selected, 0);
  const [cancelled, cmds] = update(key('escape'), menu);
  assert.equal(cancelled.permission.open, false);
  assert.deepEqual(cmds, [{ type: 'permission-cancel' }]);
  // Ctrl+C ở bất kỳ tầng nào cũng hủy cả modal.
  model = open();
  [model] = update(key('enter'), model);
  const [aborted, abortCmds] = update(key('ctrl+c'), model);
  assert.equal(aborted.permission.open, false);
  assert.deepEqual(abortCmds, [{ type: 'permission-cancel' }]);
});

test('PLAN active is stated in the header and on every mode row detail', () => {
  let model = open({ ...snapshot, planModeActive: true, globalMode: 'read_only', effectiveMode: 'read_only' });
  const rendered = stripTerminalControls(view(model));
  assert.ok(rendered.includes('PLAN đang bật'));
  assert.ok(rendered.includes('Ở đây: read_only'));
  [model] = update(key('enter'), model);
  assert.ok(stripTerminalControls(view(model)).includes('PLAN đang bật: áp khi exit'));
});

test('permission overlay replaces the viewport and open=false closes it', () => {
  const plain = createRootModel({ width: 80, height: 24 });
  const model = open();
  const overlaid = stripTerminalControls(view(model));
  assert.notEqual(overlaid, stripTerminalControls(view(plain)));
  assert.ok(overlaid.includes('PERMISSIONS'));
  const [closed] = update({ type: 'permission', open: false }, model);
  assert.equal(closed.permission.open, false);
  assert.equal(closed.focus, 'composer');
  assert.equal(closed.permission.tier, 'actions');
});

test('full_access is the fifth row of the global tier and emits set-global', () => {
  let model = open();
  [model] = update(key('enter'), model);
  const rendered = stripTerminalControls(view(model));
  assert.ok(rendered.includes('full_access'));
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  [model] = update(key('down'), model);
  assert.equal(model.permission.selected, 4);
  const [, cmds] = update(key('enter'), model);
  assert.deepEqual(cmds, [{ type: 'permission-pick', choice: { action: 'set-global', mode: 'full_access' } }]);
});

test('FULL ACCESS badge follows the full-access msg and clears on off', () => {
  const [on] = update({ type: 'full-access', on: true }, createRootModel({ width: 80, height: 24 }));
  assert.equal(on.fullAccess, true);
  assert.ok(stripTerminalControls(view(on)).includes('FULL ACCESS'));
  const [off] = update({ type: 'full-access', on: false }, on);
  assert.equal(off.fullAccess, false);
  assert.equal(stripTerminalControls(view(off)).includes('FULL ACCESS'), false);
});
