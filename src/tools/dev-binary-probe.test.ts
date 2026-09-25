import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  diagnoseCommandFailure,
  getDevToolSuggestion,
} from '../sandbox/command-diagnostics.js';
import { createRunCommandTool } from './run-command.js';
import { probeMissingBinary } from './command-preflight-guard.js';
import { Workspace } from '../workspace/workspace.js';

test('getDevToolSuggestion maps known binaries case-insensitively', () => {
  assert.equal(getDevToolSuggestion('ruff')?.fallback, 'python -m ruff');
  assert.equal(getDevToolSuggestion('Ruff')?.fallback, 'python -m ruff');
  assert.equal(getDevToolSuggestion('ruff.exe')?.fallback, 'python -m ruff');
  assert.equal(getDevToolSuggestion('eslint')?.fallback, 'npx eslint');
  assert.equal(getDevToolSuggestion('__minus_missing_bin__'), undefined);
});

test('diagnoseCommandFailure classifies known dev tools as DEV_TOOL_NOT_FOUND', () => {
  const diag = diagnoseCommandFailure('ruff check modules.py', {
    exitCode: 1,
    stdout: '',
    stderr: `'ruff' is not recognized as an internal or external command,\noperable program or batch file.`,
    durationMs: 1895,
    sandboxType: 'local',
  });
  assert.equal(diag?.errorCode, 'DEV_TOOL_NOT_FOUND');
  assert.equal(diag?.missingExecutable, 'ruff');
  assert.equal(diag?.fallbackCommand, 'python -m ruff');
  assert.ok(diag?.suggestion.includes('python -m ruff'));
});

test('diagnoseCommandFailure keeps generic COMMAND_NOT_FOUND for unknown binaries', () => {
  const diag = diagnoseCommandFailure('__minus_missing_bin__ --version', {
    exitCode: 127,
    stdout: '',
    stderr: `'__minus_missing_bin__' is not recognized as an internal or external command,`,
    durationMs: 10,
    sandboxType: 'local',
  });
  assert.equal(diag?.errorCode, 'COMMAND_NOT_FOUND');
  assert.equal(diag?.fallbackCommand, undefined);
});

test('probeMissingBinary passes resolvable binaries and builtins', () => {
  assert.equal(probeMissingBinary('node --version'), undefined);
  assert.equal(probeMissingBinary('echo hi'), undefined);
  assert.equal(probeMissingBinary('.\\bin\\app.exe'), undefined);
  assert.equal(probeMissingBinary(''), undefined);
});

test('probeMissingBinary defers to built-in emulators', () => {
  // cat/ls/rg families are emulated inside run_command; the probe must not block them.
  for (const command of ['cat large.log', 'ls -la', 'rg pattern src', 'rm -f tmp.txt']) {
    assert.equal(probeMissingBinary(command), undefined, command);
  }
});

test('probeMissingBinary flags unresolvable bare binaries', () => {
  assert.deepEqual(
    probeMissingBinary('__minus_missing_bin__ --check x'),
    { name: '__minus_missing_bin__' },
  );
});

test('probeMissingBinary resolves project-local bin dirs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-bin-probe-'));
  try {
    const binDir = path.join(root, 'node_modules', '.bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, 'mytool'), '', 'utf-8');
    await fs.writeFile(path.join(binDir, 'mytool.exe'), '', 'utf-8');
    assert.equal(probeMissingBinary('mytool --x', { workspaceRoot: root }), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run_command fail-fasts missing binaries before spawning a process', async () => {
  const tool = createRunCommandTool();
  const result = await tool.execute(
    { command: '__minus_missing_bin__ --version' },
    new Workspace(),
  );
  assert.equal(result.commandOutcome, 'blocked_preflight');
  assert.equal(result.preflightCode, 'DEV_BINARY_NOT_FOUND');
  assert.equal(result.processStarted, false);
  assert.ok(result.durationMs < 1000);
});

test('run_command suggests the dev-tool fallback for known binaries', async () => {
  const tool = createRunCommandTool();
  const result = await tool.execute(
    { command: '__minus_missing_bin__ --version' },
    new Workspace(),
  );
  assert.equal(result.preflightCode, 'DEV_BINARY_NOT_FOUND');
  // Unknown binary: generic install guidance, no fabricated fallback.
  assert.equal(result.fallbackCommand, undefined);
  assert.ok(String(result.suggestion).includes('__minus_missing_bin__'));
});

test('MINUS_BINARY_PROBE=off disables the pre-spawn probe', async () => {
  const previous = process.env.MINUS_BINARY_PROBE;
  process.env.MINUS_BINARY_PROBE = 'off';
  try {
    const tool = createRunCommandTool();
    const result = await tool.execute(
      { command: '__minus_missing_bin__ --version' },
      new Workspace(),
    );
    assert.notEqual(result.preflightCode, 'DEV_BINARY_NOT_FOUND');
  } finally {
    if (previous === undefined) delete process.env.MINUS_BINARY_PROBE;
    else process.env.MINUS_BINARY_PROBE = previous;
  }
});
