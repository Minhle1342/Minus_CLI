import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionManager } from '../security/permission-manager.js';

test('subagent session auto-approval allows workspace mutations without interactive prompt', async () => {
  let promptCalled = false;
  const pm = new PermissionManager({
    mode: 'ask_sensitive',
    workspaceRoot: process.cwd(),
    promptHandler: async () => {
      promptCalled = true;
      return 'reject';
    },
  });

  const subagentSessionId = 'session-subagent-test-1';
  pm.autoApproveSession(subagentSessionId);

  // 1. Mutating tool replace_text in subagent session
  const resReplace = await pm.checkPermission('replace_text', {
    path: 'src/sample.ts',
    target: 'foo',
    replacement: 'bar',
  }, {
    sessionId: subagentSessionId,
    isSubagent: true,
  });

  assert.equal(resReplace.allowed, true);
  assert.equal(promptCalled, false, 'promptHandler must not be invoked for auto-approved subagent session');

  // 2. Standard development run_command in subagent session
  const resCommand = await pm.checkPermission('run_command', {
    command: 'npm test',
  }, {
    sessionId: subagentSessionId,
    isSubagent: true,
  });

  assert.equal(resCommand.allowed, true);
  assert.equal(promptCalled, false);
});

test('subagent session auto-approval still hard-denies destructive commands and push to main', async () => {
  let promptCalled = false;
  const pm = new PermissionManager({
    mode: 'ask_sensitive',
    workspaceRoot: process.cwd(),
    promptHandler: async () => {
      promptCalled = true;
      return 'approve';
    },
  });

  const subagentSessionId = 'session-subagent-test-2';
  pm.autoApproveSession(subagentSessionId);

  // 1. Push to main must remain hard-denied
  const resPush = await pm.checkPermission('run_command', {
    command: 'git push origin main',
  }, {
    sessionId: subagentSessionId,
    isSubagent: true,
  });

  assert.equal(resPush.allowed, false);
  assert.equal(resPush.errorCode, 'PUSH_TO_MAIN_PROHIBITED');

  // 2. Destructive system command must remain hard-denied
  const resDestructive = await pm.checkPermission('run_command', {
    command: 'rm -rf /',
  }, {
    sessionId: subagentSessionId,
    isSubagent: true,
  });

  assert.equal(resDestructive.allowed, false);
  assert.equal(resDestructive.errorCode, 'SECURITY_VIOLATION');
});
