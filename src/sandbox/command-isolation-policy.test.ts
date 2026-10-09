import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildDockerRunArgs } from './docker-sandbox.js';
import {
  evaluateHostCommandPolicy,
  mustBlockUnisolatedAutoExecution,
  requiresIsolatedExecution,
} from './command-isolation-policy.js';

test('only known read-only commands may use an automatic local fallback', () => {
  assert.equal(requiresIsolatedExecution('rg "SandboxManager" src'), false);
  assert.equal(requiresIsolatedExecution('git status && git diff'), false);
  assert.equal(requiresIsolatedExecution('node --test'), false);
  assert.equal(requiresIsolatedExecution('node --import tsx --test src/sandbox/command-isolation-policy.test.ts'), false);
  assert.equal(requiresIsolatedExecution('tsc --noEmit'), false);
  assert.equal(requiresIsolatedExecution('git rev-parse HEAD'), false);
  assert.equal(requiresIsolatedExecution('npm test'), true);
  assert.equal(requiresIsolatedExecution('node script.js'), true);
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
  assert.equal(mustBlockUnisolatedAutoExecution('node --test', fallbackStatus), false);
  assert.equal(mustBlockUnisolatedAutoExecution('node --import tsx --test src/test.ts', fallbackStatus), false);

  // Environment override MINUS_ALLOW_HOST_FALLBACK
  process.env.MINUS_ALLOW_HOST_FALLBACK = 'true';
  try {
    assert.equal(mustBlockUnisolatedAutoExecution('npm test', fallbackStatus), false);
  } finally {
    delete process.env.MINUS_ALLOW_HOST_FALLBACK;
  }
});

test('system-destructive host commands cannot bypass the policy with approval', () => {
  assert.equal(evaluateHostCommandPolicy('format C:').allowed, false);
  assert.equal(evaluateHostCommandPolicy('git status').allowed, true);
});

test('workspace-confined recursive deletes fall through to approval instead of a hard block', () => {
  const root = path.join('workspace-root');
  const inside = path.join(root, 'build', 'output');
  const absoluteInside = path.resolve(root, 'build');
  // Absolute in-workspace targets are exempt from the non-bypassable block...
  assert.equal(evaluateHostCommandPolicy(`rm -rf ${absoluteInside}`, path.resolve(root)).allowed, true);
  assert.equal(evaluateHostCommandPolicy(`rm -rf ${inside}`, path.resolve(root)).allowed, true);
  // ...but nothing leaves the workspace, and the workspace root itself stays protected.
  assert.equal(evaluateHostCommandPolicy('rm -rf /', path.resolve(root)).allowed, false);
  assert.equal(evaluateHostCommandPolicy(`rm -rf ${absoluteInside} ${path.resolve('elsewhere')}`, path.resolve(root)).allowed, false);
  assert.equal(evaluateHostCommandPolicy(`rm -rf ${path.resolve(root)}`, path.resolve(root)).allowed, false);
  assert.equal(evaluateHostCommandPolicy('format C:', path.resolve(root)).allowed, false);
  // Without a workspace root the old fail-closed behavior is unchanged.
  assert.equal(evaluateHostCommandPolicy(`rm -rf ${absoluteInside}`).allowed, false);
});

test('Docker mount remains writable by default and read-only only when configured', () => {
  const common = { containerName: 'minus-test', workspacePath: 'C:\\repo', memoryLimitMb: 512, cpuLimit: 1, image: 'node:20-alpine' };
  assert.ok(buildDockerRunArgs({ ...common, workspaceMountMode: 'rw' }).includes('C:/repo:/workspace:rw'));
  assert.ok(buildDockerRunArgs({ ...common, workspaceMountMode: 'ro' }).includes('C:/repo:/workspace:ro'));
});
