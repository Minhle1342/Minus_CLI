import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CheckpointManager } from '../workspace/checkpoint.js';
import { Workspace } from '../workspace/workspace.js';
import { createSessionDiffTool } from './session-diff.js';
import { ToolRegistry } from './registry.js';

test('session_diff returns turn diffs for the last checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-diff-'));
  try {
    const manager = new CheckpointManager(root);
    await manager.init();
    await fs.writeFile(path.join(root, 'a.ts'), 'old');
    await manager.createCheckpoint('turn', { files: ['a.ts'] });
    await fs.writeFile(path.join(root, 'a.ts'), 'new');
    await manager.recordMutation(['a.ts']);
    const res = await createSessionDiffTool(() => manager).execute({}, new Workspace(root));
    assert.equal(res.totalFiles, 1);
    assert.equal(res.diffs[0].filePath, 'a.ts');
    assert.match(res.diffs[0].diff, /\+new/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session_diff reports honestly with no checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-diff-empty-'));
  try {
    const manager = new CheckpointManager(root);
    await manager.init();
    const res = await createSessionDiffTool(() => manager).execute({}, new Workspace(root));
    assert.equal(res.totalFiles, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('tools_search aliases the built-in fast search', () => {
  const registry = new ToolRegistry();
  assert.equal(registry.has('tools_search'), true);
  assert.equal(registry.get('tools_search')?.name, 'search_codebase_fast');
});

test('session_diff rejects unknown checkpoint ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-session-diff-bogus-'));
  try {
    const manager = new CheckpointManager(root);
    await manager.init();
    await fs.writeFile(path.join(root, 'a.ts'), 'old');
    await manager.createCheckpoint('turn', { files: ['a.ts'] });
    const res = await createSessionDiffTool(() => manager).execute({ checkpointId: 'cp_nope' }, new Workspace(root));
    assert.equal(res.errorCode, 'CHECKPOINT_NOT_FOUND');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('tools_search alias is visible in scoped getAll', () => {
  const registry = new ToolRegistry();
  const scope = registry.createScope('alias-scope', ['tools_search']);
  assert.ok(scope.getAll().some((tool) => tool.name === 'search_codebase_fast'));
});
