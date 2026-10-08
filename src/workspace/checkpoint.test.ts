import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CheckpointManager } from './checkpoint.js';
import { HypothesisRollbackOrchestrator } from '../agent/hypothesis-rollback-orchestrator.js';

async function fixture(run: (manager: CheckpointManager, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-scoped-checkpoint-'));
  try { const manager = new CheckpointManager(root); await manager.init(); await run(manager, root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('partial rollback reports restored prefix and remains retryable', async () => fixture(async (manager, root) => {
  for (const file of ['a.ts', 'b.ts']) await fs.writeFile(path.join(root, file), 'baseline');
  await manager.createCheckpoint('scoped', { files: ['a.ts', 'b.ts'] });
  for (const file of ['a.ts', 'b.ts']) await fs.writeFile(path.join(root, file), 'agent');
  await manager.recordMutation(['a.ts', 'b.ts']);
  const original = fs.writeFile;
  let result;
  try {
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('b.ts')) throw new Error('injected I/O failure');
      return original(...args);
    }) as typeof fs.writeFile;
    result = await manager.rollbackLast();
  } finally { fs.writeFile = original; }
  assert.equal(result.success, false);
  assert.deepEqual(result.restoredFiles, ['a.ts']);
  assert.equal((await manager.rollbackLast()).success, true);
}));
test('scoped rollback restores preexisting user dirt, deletes owned new files, preserves unrelated files', async () => fixture(async (manager, root) => {
  await fs.writeFile(path.join(root, 'a.ts'), 'user dirty bytes');
  await fs.writeFile(path.join(root, 'b.ts'), 'unrelated');
  await manager.createCheckpoint('mutation', { files: ['a.ts', 'new.ts'] });
  await fs.writeFile(path.join(root, 'a.ts'), 'agent bytes');
  await fs.writeFile(path.join(root, 'new.ts'), 'agent created');
  await manager.recordMutation(['a.ts', 'new.ts']);
  await fs.writeFile(path.join(root, 'b.ts'), 'user changed unrelated');
  const result = await manager.rollbackLast();
  assert.equal(result.success, true);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'user dirty bytes');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'user changed unrelated');
  await assert.rejects(fs.stat(path.join(root, 'new.ts')));
}));
test('external edits fail closed before restoring any target and retain checkpoint', async () => fixture(async (manager, root) => {
  await fs.writeFile(path.join(root, 'a.ts'), 'baseline');
  await manager.createCheckpoint('mutation', { files: ['a.ts'] });
  await fs.writeFile(path.join(root, 'a.ts'), 'agent'); await manager.recordMutation(['a.ts']);
  await fs.writeFile(path.join(root, 'a.ts'), 'user concurrent');
  assert.equal((await manager.rollbackLast()).success, false);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'user concurrent');
  assert.equal(manager.getHistory().length, 1);
}));
test('missing snapshot fails honestly and no-checkpoint hypothesis rollback never claims success', async () => fixture(async (manager) => {
  await manager.createCheckpoint('no scope');
  assert.equal((await manager.rollbackLast()).success, false);
  const result = await new HypothesisRollbackOrchestrator(manager).rollbackOnFalsifiedHypothesis('H1');
  assert.equal(result.rolledBack, false);
  assert.match(result.guidancePrompt || '', /NOT PERFORMED/);
  assert.doesNotMatch(result.guidancePrompt || '', /mutations have been undone|CLEAN SLATE RESTORED/);
}));
test('snapshot capture rejects escaping paths', async () => fixture(async (manager) => {
  await assert.rejects(manager.createCheckpoint('unsafe', { files: ['../outside'] }), /escapes workspace/);
  assert.equal(manager.getHistory().length, 0);
}));
