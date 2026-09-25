import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextSnapshotManager } from './context-snapshot-manager.js';

test('captureSnapshot prunes oldest snapshots beyond the cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-snapshot-prune-'));
  try {
    const manager = new ContextSnapshotManager(root);
    for (let turn = 1; turn <= 8; turn++) {
      await manager.captureSnapshot({
        sessionId: 'session-prune', turn, taskPrompt: `task ${turn}`,
        finalAnswer: `answer ${turn}`, mutatedFiles: [],
        verificationStatus: 'verified',
      }, { maxSnapshots: 5 });
    }
    const list = await manager.listSnapshots();
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((item) => item.turn), [4, 5, 6, 7, 8]);
    const latest = await manager.getLatestSnapshot();
    assert.equal(latest?.turn, 8);
    const files = await fs.readdir(path.join(root, '.codingagent', 'snapshots'));
    assert.ok(!files.some((name) => name.startsWith('task-1-') || name.startsWith('task-2-') || name.startsWith('task-3-')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('default cap keeps the newest snapshots without options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-snapshot-default-'));
  try {
    const manager = new ContextSnapshotManager(root);
    assert.equal(ContextSnapshotManager.DEFAULT_MAX_SNAPSHOTS, 30);
    for (let turn = 1; turn <= 3; turn++) {
      await manager.captureSnapshot({
        sessionId: 'session-default', turn, taskPrompt: `task ${turn}`,
        finalAnswer: `answer ${turn}`, mutatedFiles: [],
        verificationStatus: 'verified',
      });
    }
    assert.equal((await manager.listSnapshots()).length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
