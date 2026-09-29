import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeExtractArchive, nativeScanPathForBinaries, isNativeAvailable } from '../native/index.js';
import { isBareBinaryAvailable, findBinaryOnPath, clearBinaryProbeCache } from '../tools/command-preflight-guard.js';

test('native toolchain wrappers never throw and degrade to null without native', () => {
  const extract = nativeExtractArchive('nope.zip', os.tmpdir(), true);
  assert.ok(extract === null || typeof extract.filesExtracted === 'number');
  const scan = nativeScanPathForBinaries([os.tmpdir()], ['definitely-not-a-real-binary-xyz']);
  assert.ok(scan === null || Array.isArray(scan));
});

test('native PATH scan finds a planted binary when native is present', async () => {
  if (!isNativeAvailable()) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-scan-'));
  try {
    await fs.writeFile(path.join(dir, 'probe_test_bin_xyz'), 'x');
    const hits = nativeScanPathForBinaries([dir], ['probe_test_bin_xyz']);
    assert.ok(hits && hits.length === 1);
    assert.ok(hits[0].endsWith('probe_test_bin_xyz'));
    const miss = nativeScanPathForBinaries([dir], ['no_such_file_abc']);
    assert.deepEqual(miss, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('isBareBinaryAvailable keeps working with native scan active', async () => {
  clearBinaryProbeCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-probe-'));
  const prevPath = process.env.PATH || '';
  try {
    await fs.writeFile(path.join(dir, 'probe_native_xyz'), 'x');
    process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
    clearBinaryProbeCache();
    assert.equal(isBareBinaryAvailable('probe_native_xyz'), true);
    clearBinaryProbeCache();
    assert.equal(isBareBinaryAvailable('definitely_missing_bin_xyz'), false);
  } finally {
    process.env.PATH = prevPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findBinaryOnPath resolves planted binary via native or fallback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-find-'));
  const prevPath = process.env.PATH || '';
  try {
    await fs.writeFile(path.join(dir, 'find_me_xyz'), 'x');
    process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
    clearBinaryProbeCache();
    const hit = findBinaryOnPath('find_me_xyz');
    assert.ok(hit && hit.endsWith('find_me_xyz'));
    clearBinaryProbeCache();
    assert.equal(findBinaryOnPath('definitely_missing_bin_xyz'), undefined);
  } finally {
    process.env.PATH = prevPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
