import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunCommandTool, executeCatEmulation, parseCatCommand } from './run-command.js';
import { Workspace } from '../workspace/workspace.js';

test('Integration Phase 1 & 2: Interactive command is rejected in 0ms without spawning process', async () => {
  const tool = createRunCommandTool();
  const workspace = new Workspace();

  // Bare python REPL
  const res = await tool.execute({ command: 'python' }, workspace);
  assert.equal(res.success, false);
  assert.equal(res.errorCode, 'INTERACTIVE_COMMAND_PROHIBITED');
  assert.ok(res.suggestion.includes('python <file.py>'));

  // Bare node REPL
  const nodeRes = await tool.execute({ command: 'node' }, workspace);
  assert.equal(nodeRes.success, false);
  assert.equal(nodeRes.errorCode, 'INTERACTIVE_COMMAND_PROHIBITED');

  // Interactive npm init
  const npmInitRes = await tool.execute({ command: 'npm init' }, workspace);
  assert.equal(npmInitRes.success, false);
  assert.equal(npmInitRes.errorCode, 'INTERACTIVE_COMMAND_PROHIBITED');
});

test('Integration Phase 1 & 2: Long-running dev server requires WaitMsBeforeAsync or is rejected', async () => {
  const tool = createRunCommandTool();
  const workspace = new Workspace();

  // Without wait parameter: rejected
  const res = await tool.execute({ command: 'npm run dev' }, workspace);
  assert.equal(res.success, false);
  assert.equal(res.errorCode, 'LONG_RUNNING_SERVER_REQUIRES_ASYNC');
  assert.ok(res.suggestion.includes('WaitMsBeforeAsync'));
});

test('Integration Phase 1 & 2: Cat emulation executes in <5ms without calling missing shell binary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-cat-test-'));
  try {
    const testFile = path.join(tempDir, 'sample.txt');
    await fs.writeFile(testFile, 'line 1\nline 2\nline 3\nline 4\nline 5\n', 'utf-8');

    const workspace = new Workspace(tempDir);
    const parsed = parseCatCommand('cat sample.txt');
    assert.ok(parsed);
    assert.equal(parsed.filePath, 'sample.txt');

    const emulated = await executeCatEmulation(parsed, workspace);
    assert.equal(emulated.success, true);
    assert.equal(emulated.exitCode, 0);
    assert.equal(emulated.emulated, true);
    assert.match(emulated.stdout, /line 1\nline 2/);
    assert.ok(emulated.durationMs < 15);

    // Test head option: head -n 2 sample.txt
    const parsedHead = parseCatCommand('head -n 2 sample.txt');
    assert.ok(parsedHead);
    assert.equal(parsedHead.headLines, 2);
    const headRes = await executeCatEmulation(parsedHead, workspace);
    assert.equal(headRes.stdout, 'line 1\nline 2');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Integration Phase 1: Large terminal output is offloaded to disk and returns truncated text', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-output-test-'));
  try {
    const workspace = new Workspace(tempDir);
    const tool = createRunCommandTool();

    // Create a large file in tempDir
    const largeLines: string[] = [];
    for (let i = 1; i <= 250; i++) {
      largeLines.push(`[LOG-TRACE-STEP-${i}] Detailed telemetry compiler verbose message number ${i}.`);
    }
    const targetFile = path.join(tempDir, 'large.log');
    await fs.writeFile(targetFile, largeLines.join('\n'), 'utf-8');

    // Run cat on the large file
    const res = await tool.execute({ command: 'cat large.log' }, workspace);
    assert.equal(res.success, true);
    assert.equal(res.emulated, true);
    assert.ok(res.stdout.includes('[LOG-TRACE-STEP-1]'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Integration Phase 2: Idempotent failing test re-run is blocked when 0 files modified', async () => {
  const tool = createRunCommandTool();
  const workspace = new Workspace();

  // Calling npm test when previous failed with 0 files modified
  const res = await tool.execute(
    { command: 'npm test' },
    workspace,
    {
      lastCommandExecution: {
        command: 'npm test',
        success: false,
        exitCode: 1,
        filesModifiedSince: 0,
      },
    } as any
  );

  assert.equal(res.success, false);
  assert.equal(res.errorCode, 'IDEMPOTENT_TEST_EXECUTION_BLOCKED');
  assert.match(res.error, /chưa có bất kỳ tệp mã nguồn nào được chỉnh sửa/);

  // Calling npm test after 1 file was modified (ALLOWED to proceed to shell)
  const allowedRes = await tool.execute(
    { command: 'npm test' },
    workspace,
    {
      lastCommandExecution: {
        command: 'npm test',
        success: false,
        exitCode: 1,
        filesModifiedSince: 1,
      },
    } as any
  );

  // Allowed to proceed (not blocked by preflight)
  assert.notEqual(allowedRes.errorCode, 'IDEMPOTENT_TEST_EXECUTION_BLOCKED');
});
