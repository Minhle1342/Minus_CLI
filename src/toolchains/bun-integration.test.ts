import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedCommand, isAllowedShellCommand } from '../tools/run-command.js';
import { inferCommandRuntime } from '../sandbox/runtime-profiles.js';
import { findRecipeForBinary } from './toolchain-recipes.js';

test('Bun is allowlisted for host/sandbox execution without approval', () => {
  for (const cmd of ['bun test', 'bun run build', 'bun install', 'bunx vite build', 'bun --version']) {
    assert.equal(isAllowedCommand(cmd), true, `${cmd} must be allowlisted`);
  }
  assert.equal(isAllowedShellCommand('bun test && bun run build'), true, 'chained bun commands must be allowlisted');
});

test('Bun commands infer the node sandbox runtime', () => {
  for (const cmd of ['bun test', 'bun run build', 'bunx vitest run']) {
    const inferred = inferCommandRuntime(cmd);
    assert.ok(inferred.runtimes.includes('node'), `${cmd} must map to the node runtime`);
    assert.ok(inferred.executables.includes('bun') || inferred.executables.includes('bunx'), `${cmd} must keep its executable`);
  }
});

test('Bun auto-provision recipe resolves both binaries', () => {
  assert.equal(findRecipeForBinary('bun')?.id, 'bun');
  assert.equal(findRecipeForBinary('bunx')?.id, 'bun');
});

test('Sandbox Dockerfile pre-installs the pinned Bun version', () => {
  const dockerfile = fs.readFileSync(path.join(process.cwd(), 'deploy', 'sandbox', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /oven-sh\/bun\/releases\/download/);
  assert.match(dockerfile, /BUN_VERSION=bun-v1\.2\.4/);
  assert.match(dockerfile, /bun --version/);
});
