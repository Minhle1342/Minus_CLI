import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerRunArgs } from './docker-sandbox.js';
import {
  evaluateHostCommandPolicy,
  mustBlockUnisolatedAutoExecution,
  requiresIsolatedExecution,
} from './command-isolation-policy.js';

test('only known read-only commands may use an automatic local fallback', () => {
  assert.equal(requiresIsolatedExecution('rg "SandboxManager" src'), false);
  assert.equal(requiresIsolatedExecution('git status && git diff'), false);
  assert.equal(requiresIsolatedExecution('npm test'), true);
  assert.equal(requiresIsolatedExecution('echo ok > marker.txt'), true);
});

test('Docker-to-local fallback is fail-closed only for commands requiring isolation', () => {
  const fallbackStatus = {
    mode: 'local' as const,
    activeProvider: 'Local Process Sandbox',
    isIsolated: false,
    dockerAvailable: false,
    fallbackToLocal: true,
  };
  assert.equal(mustBlockUnisolatedAutoExecution('npm test', fallbackStatus), true);
  assert.equal(mustBlockUnisolatedAutoExecution('git status', fallbackStatus), false);
});

test('system-destructive host commands cannot bypass the policy with approval', () => {
  assert.equal(evaluateHostCommandPolicy('format C:').allowed, false);
  assert.equal(evaluateHostCommandPolicy('git status').allowed, true);
});

test('Docker mount remains writable by default and read-only only when configured', () => {
  const common = { containerName: 'minus-test', workspacePath: 'C:\\repo', memoryLimitMb: 512, cpuLimit: 1, image: 'node:20-alpine' };
  assert.ok(buildDockerRunArgs({ ...common, workspaceMountMode: 'rw' }).includes('C:/repo:/workspace:rw'));
  assert.ok(buildDockerRunArgs({ ...common, workspaceMountMode: 'ro' }).includes('C:/repo:/workspace:ro'));
});
