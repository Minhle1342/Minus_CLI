import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedCommand, isAllowedShellCommand, createRunCommandTool } from './run-command.js';
import { Workspace } from '../workspace/workspace.js';
import { checkPhaseToolEffect } from '../control/phase-tool-effects.js';
import { prependWorkspaceBinDirs } from '../security/env-scrub.js';

test('everyday task commands are allowlisted without approval', () => {
  for (const cmd of [
    'cd subdir && npm test',
    'mkdir -p build',
    'cp a b',
    'sleep 5',
    'tsc --noEmit',
    'eslint .',
    'jest src/',
    'vitest run',
    'prettier --check .',
    'biome check .',
    'oxlint src/',
    'stylelint **/*.css',
    'ruff check .',
    'black --check .',
    'flake8 src/',
    'isort --check-only .',
    'mypy src/',
    'pylint src/',
    'gofmt -l .',
    'rustfmt --check src/main.rs',
    'rubocop --no-color',
    'phpcs --standard=PSR12 src/',
    'ktlint --format',
    'swiftlint --strict',
    'clang-format --dry-run -Werror src/main.cpp',
    'docker ps',
    'docker ps -a',
    'docker --version',
    'npm test -- --watch=false',
    'npm run test:tea',
    'npm run build',
    'npm run lint',
    'npm run typecheck',
    'pnpm test',
    'pnpm run build',
    'yarn test',
    'yarn run lint',
    'cargo test',
    'cargo check',
    'cargo build',
    'go test ./...',
    'dotnet test',
    'dotnet build',
    'pytest',
    'npx tsc',
    'tsx src/index.ts',
  ]) {
    assert.equal(isAllowedShellCommand(cmd), true, `${cmd} must be allowlisted`);
  }
});

test('dangerous and destructive commands still require approval', () => {
  for (const cmd of [
    'rm -rf /',
    'mv a b',
    'del /f /q C:\\Windows\\x',
    'powershell -Command "npm test"',
    'docker rm -f abc',
  ]) {
    assert.equal(isAllowedCommand(cmd), false, `${cmd} must NOT be allowlisted`);
  }
  assert.equal(isAllowedShellCommand('rm -rf /'), false, 'rm chain must NOT be allowlisted');
});

test('bounded two-segment pipelines of allowlisted commands skip approval', () => {
  assert.equal(isAllowedShellCommand('npm test | head -n 20'), true);
  assert.equal(isAllowedShellCommand('git log --oneline | head -n 5'), true);
  assert.equal(isAllowedShellCommand('ls -la .codingagent/sessions/ 2>/dev/null || echo "Not found in cwd"'), true);
  assert.equal(isAllowedShellCommand('npm test | tee out.txt'), false);
  assert.equal(isAllowedShellCommand('npm test | head -n 5 | tail -n 2'), false);
  assert.equal(isAllowedShellCommand('echo hi > out.txt'), false);
  assert.equal(isAllowedShellCommand('rm -rf /tmp/x | cat'), false);
});

test('fd redirects are allowlisted without widening file writes', () => {
  assert.equal(isAllowedShellCommand('ls -la 2>&1'), true);
  assert.equal(isAllowedShellCommand('git status 2>/dev/null'), true);
  assert.equal(isAllowedShellCommand('git status > 1'), false);
  assert.equal(isAllowedShellCommand('git status >> 2'), false);
});

test('only read-only codegraph subcommands skip approval', () => {
  for (const cmd of ['codegraph explore AgentLoop', 'codegraph impact AgentLoop', 'codegraph status']) {
    assert.equal(isAllowedCommand(cmd), true, cmd);
  }
  for (const cmd of ['codegraph init', 'codegraph sync', 'codegraph explore x && codegraph init']) {
    assert.equal(isAllowedShellCommand(cmd), false, cmd);
  }
});

test('next, vite, turbo and modern build commands are allowlisted', () => {
  for (const cmd of [
    'next build',
    'next lint',
    'next dev',
    'next start',
    'npx next build',
    'vite build',
    'turbo build',
  ]) {
    assert.equal(isAllowedCommand(cmd), true, `${cmd} must be allowlisted`);
    assert.equal(isAllowedShellCommand(cmd), true, `${cmd} shell command must be allowlisted`);
  }
});

test('run_command accepts execution_target internal and external aliases', async () => {
  const tool = createRunCommandTool();
  const internalRes = await tool.execute(
    { command: 'echo test_internal', execution_target: 'internal' },
    new Workspace(),
  );
  assert.notEqual(internalRes.errorCode, 'INVALID_EXECUTION_TARGET');

  const externalRes = await tool.execute(
    { command: 'echo test_external', execution_target: 'external' },
    new Workspace(),
  );
  assert.notEqual(externalRes.errorCode, 'INVALID_EXECUTION_TARGET');
});

test('checkPhaseToolEffect allows safe dev build commands during explore phase', () => {
  const dummyTool = { name: 'run_command', description: '', parameters: {} as any, execute: async () => ({}) };
  const res = checkPhaseToolEffect(dummyTool, { command: 'next build' }, 'explore', process.cwd());
  assert.equal(res.allowed, true);
});

test('prependWorkspaceBinDirs prepends node_modules/.bin to PATH', () => {
  const res = prependWorkspaceBinDirs('C:\\Windows\\System32', 'C:\\repo');
  assert.ok(res.includes('node_modules'));
});

