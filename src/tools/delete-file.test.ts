import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deleteFileTool } from './delete-file.js';
import { Workspace } from '../workspace/workspace.js';
import { ToolRegistry } from './registry.js';
import { LoopProgressGuard } from '../agent/loop-progress-guard.js';

async function createTempWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-delete-test-'));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('delete_file deletes a single file via path', async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const ws = new Workspace(dir);
    const testFile = path.join(dir, 'test.txt');
    await fs.writeFile(testFile, 'hello');

    const result = await deleteFileTool.execute({ path: 'test.txt' }, ws);
    assert.equal(result.success, true);
    assert.deepEqual(result.deleted, ['test.txt']);
    assert.equal(result.changed, true);
    assert.deepEqual(result.filesDeleted, ['test.txt']);
    await assert.rejects(fs.stat(testFile));
  } finally {
    await cleanup();
  }
});

test('delete_file deletes multiple files and directories at once via paths', async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const ws = new Workspace(dir);
    // Create multiple files and a directory with contents
    await fs.writeFile(path.join(dir, 'a.txt'), 'aaa');
    await fs.writeFile(path.join(dir, 'b.txt'), 'bbb');
    const subDir = path.join(dir, 'subfolder');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'nested.txt'), 'nested');

    const result = await deleteFileTool.execute({
      paths: ['a.txt', 'b.txt', 'subfolder', 'non_existent.txt'],
      force: true,
    }, ws);

    assert.equal(result.success, true);
    assert.deepEqual(result.deleted, ['a.txt', 'b.txt', 'subfolder']);
    assert.deepEqual(result.notFound, ['non_existent.txt']);
    assert.equal(result.changed, true);

    await assert.rejects(fs.stat(path.join(dir, 'a.txt')));
    await assert.rejects(fs.stat(path.join(dir, 'b.txt')));
    await assert.rejects(fs.stat(subDir));
  } finally {
    await cleanup();
  }
});

test('delete_file blocks path traversal outside workspace', async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const ws = new Workspace(dir);
    const result = await deleteFileTool.execute({ path: '../../outside.txt' }, ws);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'SECURITY_VIOLATION');
  } finally {
    await cleanup();
  }
});

test('delete_file blocks deleting workspace root', async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const ws = new Workspace(dir);
    const result = await deleteFileTool.execute({ path: '.' }, ws);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'SECURITY_VIOLATION');
  } finally {
    await cleanup();
  }
});

test('delete_file blocks deleting protected files like .env or .git', async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const ws = new Workspace(dir);
    await fs.writeFile(path.join(dir, '.env'), 'SECRET=123');
    const result = await deleteFileTool.execute({ path: '.env' }, ws);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'SECURITY_VIOLATION');
    // Ensure .env still exists
    const content = await fs.readFile(path.join(dir, '.env'), 'utf8');
    assert.equal(content, 'SECRET=123');
  } finally {
    await cleanup();
  }
});

test('delete_file handles leading slash and parameter aliases gracefully', async () => {
  const { dir, cleanup } = await createTempWorkspace();
  try {
    const ws = new Workspace(dir);
    await fs.writeFile(path.join(dir, 'slash.txt'), 'content');
    await fs.writeFile(path.join(dir, 'alias.txt'), 'content');

    // Leading slash (POSIX style from LLM)
    const res1 = await deleteFileTool.execute({ path: '/slash.txt' }, ws);
    assert.equal(res1.success, true);
    assert.deepEqual(res1.deleted, ['slash.txt']);
    assert.equal(res1.changed, true);

    // Alias 'file'
    const res2 = await deleteFileTool.execute({ file: 'alias.txt' }, ws);
    assert.equal(res2.success, true);
    assert.deepEqual(res2.deleted, ['alias.txt']);

    // Non-existent path returns changed: false
    const res3 = await deleteFileTool.execute({ path: 'not_found.txt' }, ws);
    assert.equal(res3.success, true);
    assert.equal(res3.changed, false);
    assert.deepEqual(res3.filesDeleted, []);
  } finally {
    await cleanup();
  }
});

test('delete_file is registered in ToolRegistry and model declarations', () => {
  const registry = new ToolRegistry();
  assert.equal(registry.has('delete_file'), true);
  const declarations = registry.getFunctionDeclarations();
  const deleteDecl = declarations.find((d) => d.name === 'delete_file');
  assert.ok(deleteDecl, 'delete_file must be exposed to model declarations');
  assert.ok(deleteDecl?.parameters?.properties?.paths, 'must accept paths array');
});

test('LoopProgressGuard detects repeated failed or no-op delete_file calls', () => {
  const guard = new LoopProgressGuard();
  const noopResult = {
    success: true,
    deleted: [],
    filesDeleted: [],
    notFound: ['missing.txt'],
    changed: false,
    message: 'Skipped 1 non-existent item(s)',
  };

  const dec1 = guard.observe({ toolName: 'delete_file', args: { path: 'missing.txt' }, result: noopResult });
  assert.equal(dec1.repetitionCount, 1);

  const dec2 = guard.observe({ toolName: 'delete_file', args: { path: 'missing.txt' }, result: noopResult });
  assert.equal(dec2.repetitionCount, 2);

  const dec3 = guard.observe({ toolName: 'delete_file', args: { path: 'missing.txt' }, result: noopResult });
  assert.equal(dec3.repetitionCount, 3);
  assert.equal(dec3.shouldStop, true);
});
