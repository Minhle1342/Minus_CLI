import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  diffReadSnapshots,
  extractReadTargets,
  formatSnapshotNudge,
  snapshotReadTargets,
} from './read-batch-snapshot.js';

test('extractReadTargets collects path-like args per read tool', () => {
  const targets = extractReadTargets([
    { name: 'read_file', args: { path: 'src/index.ts' } },
    { name: 'list_files', args: { dirPath: 'src/tools' } },
    { name: 'search_text', args: { query: 'foo', path: 'src' } },
    { name: 'run_command', args: { command: 'npm test' } },
    { name: 'read_file', args: { path: 'src/index.ts' } },
  ]);
  assert.deepEqual(targets, ['src/index.ts', 'src/tools', 'src']);
});

test('extractReadTargets ignores non-string or unknown tools', () => {
  assert.deepEqual(
    extractReadTargets([
      { name: 'read_file', args: { path: 42 } },
      { name: 'unknown_tool', args: { path: 'x' } },
    ]),
    [],
  );
});

test('snapshot round-trip is stable without FS changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-read-snapshot-'));
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello', 'utf8');
    const before = await snapshotReadTargets(root, ['a.txt']);
    const after = await snapshotReadTargets(root, ['a.txt']);
    assert.deepEqual(diffReadSnapshots(before, after), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('diff detects modified, created-missing, and deleted targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-read-snapshot-'));
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'v1', 'utf8');
    const before = await snapshotReadTargets(root, ['a.txt', 'gone.txt']);
    assert.equal(before.entries['gone.txt'], 'missing');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(path.join(root, 'a.txt'), 'v2-longer', 'utf8');
    await fs.writeFile(path.join(root, 'gone.txt'), 'now here', 'utf8');
    const after = await snapshotReadTargets(root, ['a.txt', 'gone.txt']);
    assert.deepEqual(diffReadSnapshots(before, after), ['a.txt', 'gone.txt']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('outside-root targets are unresolved on both sides', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-read-snapshot-'));
  try {
    const before = await snapshotReadTargets(root, ['../escape.txt']);
    const after = await snapshotReadTargets(root, ['../escape.txt']);
    assert.equal(before.entries['../escape.txt'], 'unresolved');
    assert.deepEqual(diffReadSnapshots(before, after), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('formatSnapshotNudge lists changed files with cap', () => {
  const nudge = formatSnapshotNudge(['a.ts', 'b.ts']);
  assert.match(nudge, /READ-BATCH SNAPSHOT STALE/);
  assert.match(nudge, /a\.ts, b\.ts/);
  const long = formatSnapshotNudge(['1', '2', '3', '4', '5', '6', '7']);
  assert.match(long, /\(\+2 more\)/);
});
