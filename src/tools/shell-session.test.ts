import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import {
  clearShellSessions,
  resolveSessionCwd,
  trackSessionEnv,
  tryHandleCdCommand,
} from './shell-session.js';

test('shell cwd and exported env are isolated per session id', () => {
  clearShellSessions();
  const workspace = new Workspace(process.cwd());
  try {
    // Session 1 cds into src; session 2 must stay at the workspace root.
    assert.equal(tryHandleCdCommand('cd src', workspace, 'session-a'), path.resolve(process.cwd(), 'src'));
    assert.equal(resolveSessionCwd(workspace, 'session-a'), path.resolve(process.cwd(), 'src'));
    assert.equal(resolveSessionCwd(workspace, 'session-b'), workspace.rootDir);
    assert.equal(resolveSessionCwd(workspace), workspace.rootDir);

    // Env exported in one session never leaks into another.
    assert.equal(trackSessionEnv(workspace.rootDir, 'session-a', { MINUS_PROBE: 'from-a' }).MINUS_PROBE, 'from-a');
    assert.equal(trackSessionEnv(workspace.rootDir, 'session-b').MINUS_PROBE, undefined);
    assert.equal(trackSessionEnv(workspace.rootDir, 'session-a').MINUS_PROBE, 'from-a');
  } finally {
    clearShellSessions();
  }
});
