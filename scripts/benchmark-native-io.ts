import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isNativeAvailable, nativeBatchReadFilesAsync } from '../src/native/index.js';

const samples = 5;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-native-io-benchmark-'));
const paths = Array.from({ length: 32 }, (_, index) => `file-${index}.txt`);

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function measure(name: string, operation: () => Promise<unknown>): Promise<void> {
  const durations: number[] = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    await operation();
    durations.push(performance.now() - start);
  }
  console.log(`${name}: p50=${percentile(durations, 0.5).toFixed(1)}ms p95=${percentile(durations, 0.95).toFixed(1)}ms`);
}

try {
  await Promise.all(paths.map((file, index) => fs.writeFile(
    path.join(root, file),
    `${index}: ${'x'.repeat(180 * 1024)}`,
  )));

  await measure('Node read/hash/decode fallback', async () => {
    const buffers = await Promise.all(paths.map((file) => fs.readFile(path.join(root, file))));
    for (const buffer of buffers) {
      createHash('sha256').update(buffer).digest('hex');
      new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      let lines = 1;
      for (const byte of buffer) if (byte === 10) lines++;
      void lines;
    }
  });

  if (isNativeAvailable()) {
    await measure('Rust async mmap batch read', async () => {
      await nativeBatchReadFilesAsync(root, paths, 200 * 1024);
    });
  } else {
    console.log('Rust async mmap batch read: skipped (native addon unavailable)');
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
