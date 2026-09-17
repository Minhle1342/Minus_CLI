import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isNativeAvailable, nativeBatchReadFilesAsync } from './index.js';

test('native async batch reads yield to Node and preserve input ordering', { skip: !isNativeAvailable() }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-native-read-'));
  const paths = Array.from({ length: 24 }, (_, index) => `file-${index}.txt`);
  try {
    await Promise.all(paths.map((file, index) => fs.writeFile(
      path.join(root, file),
      `${index}: ${'x'.repeat(180 * 1024)}`,
    )));

    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const results = await nativeBatchReadFilesAsync(root, paths, 200 * 1024);
    clearTimeout(timer);

    assert.equal(results?.length, paths.length);
    assert.equal(timerFired, true, 'the timer must run while native I/O is pending');
    assert.deepEqual(results?.map((result) => result.relPath), paths);
    assert.match(results?.[0].content || '', /^0: /);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
