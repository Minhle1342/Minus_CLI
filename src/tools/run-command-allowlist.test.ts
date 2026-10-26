import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedCommand, isAllowedShellCommand } from './run-command.js';

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
