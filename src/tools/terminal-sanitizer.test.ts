import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  stripAnsi,
  collapseCarriageReturns,
  sanitizeTerminalOutput,
  distillTestOutput,
  truncateTerminalOutput,
  offloadLargeLogToDisk,
} from './terminal-sanitizer.js';

test('Terminal Sanitizer: stripAnsi removes colors, formatting, and cursor movements', () => {
  const coloredText = '\x1b[31mError:\x1b[0m \x1b[1mFile not found\x1b[0m \x1b[2K\x1b[1A[Cursor]';
  const clean = stripAnsi(coloredText);
  assert.equal(clean, 'Error: File not found [Cursor]');
});

test('Terminal Sanitizer: collapseCarriageReturns flattens progress bar spam to final state', () => {
  const progressText = 'Fetching [=>      ] 10%\rFetching [===>    ] 35%\rFetching [======> ] 70%\rFetching [========] 100%';
  const clean = collapseCarriageReturns(progressText);
  assert.equal(clean, 'Fetching [========] 100%');
});

test('Terminal Sanitizer: sanitizeTerminalOutput cleans ANSI and collapses multi-line carriage returns', () => {
  const complexOutput = [
    '\x1b[32m✔ Project initialized\x1b[0m',
    'Building [>    ] 20%\rBuilding [==>  ] 50%\r\x1b[32mBuilding [====>] 100%\x1b[0m',
    'Finished successfully in 1.2s',
  ].join('\n');

  const clean = sanitizeTerminalOutput(complexOutput);
  const expected = [
    '✔ Project initialized',
    'Building [====>] 100%',
    'Finished successfully in 1.2s',
  ].join('\n');

  assert.equal(clean, expected);
});

test('Terminal Sanitizer: distillTestOutput filters repetitive PASS lines on test failure', () => {
  const passLines: string[] = [];
  for (let i = 1; i <= 100; i++) {
    passLines.push(`PASS src/components/feature_${i}.test.ts (2.1s)`);
  }
  const failLines = [
    'FAIL src/service/order.test.ts',
    '  ● OrderService › should process payment',
    '    AssertionError: expected true but received false',
    '      at Object.<anonymous> (src/service/order.test.ts:42:15)',
  ];
  const fullLog = [...passLines, ...failLines].join('\n');

  const distilled = distillTestOutput(fullLog, 1);
  assert.match(distilled, /\[INFO: Đã rút gọn 100 dòng PASS thành công của test suites\]/);
  assert.match(distilled, /FAIL src\/service\/order\.test\.ts/);
  assert.match(distilled, /AssertionError: expected true but received false/);
  // PASS lines should be stripped
  assert.doesNotMatch(distilled, /PASS src\/components\/feature_1\.test\.ts/);
});

test('Terminal Sanitizer: truncateTerminalOutput keeps short outputs intact', () => {
  const shortText = 'All 15 tests passed cleanly in 450ms.';
  const result = truncateTerminalOutput(shortText, { maxLength: 8000 });
  assert.equal(result.truncated, false);
  assert.equal(result.text, shortText);
  assert.equal(result.savedChars, 0);
  assert.equal(result.savedTokensEstimate, 0);
});

test('Terminal Sanitizer: truncateTerminalOutput truncates large output and computes token savings', () => {
  const lines: string[] = [];
  for (let i = 1; i <= 300; i++) {
    lines.push(`Line ${i}: Build step output generating detailed compiler telemetry and diagnostics.`);
  }
  const largeText = lines.join('\n'); // ~25,000 chars

  const result = truncateTerminalOutput(largeText, {
    maxLength: 5000,
    maxLines: 80,
    preserveHeadLines: 15,
    preserveTailLines: 20,
    logFilePath: '.minus/logs/test.log',
  });

  assert.equal(result.truncated, true);
  assert.ok(result.savedChars > 15000);
  assert.ok(result.savedTokensEstimate > 3500);
  assert.match(result.text, /Line 1: Build step/);
  assert.match(result.text, /Line 300: Build step/);
  assert.match(result.text, /\[💡 TOÀN BỘ LOG ĐẦY ĐỦ ĐÃ ĐƯỢC LƯU TẠI TỆP: \.minus\/logs\/test\.log/);
});

test('Terminal Sanitizer: offloadLargeLogToDisk saves log file and returns relative path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-log-test-'));
  try {
    const rawLog = 'FATAL ERROR: In-memory heap limit reached.\nDetailed trace...\n'.repeat(50);
    const relPath = await offloadLargeLogToDisk(tempDir, rawLog, 'npm_test');
    assert.ok(relPath);
    assert.ok(relPath.startsWith('.minus/logs/command_outputs/'));

    const fullPath = path.resolve(tempDir, relPath);
    const savedContent = await fs.readFile(fullPath, 'utf-8');
    assert.equal(savedContent, rawLog);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Terminal Sanitizer Benchmark: Measures token reduction on simulated npm install & test dump', () => {
  // 1. Simulated npm install with 200 progress overwrites
  let progressDump = '';
  for (let i = 1; i <= 200; i++) {
    progressDump += `reify:rxjs: timing reifyNode:node_modules/rxjs completed in ${i}ms\r`;
  }
  progressDump += 'added 145 packages in 3s\n';

  const sanitizedProgress = sanitizeTerminalOutput(progressDump);
  const progressRatio = 1 - (sanitizedProgress.length / progressDump.length);
  // Expect > 95% reduction in progress bar spam
  assert.ok(progressRatio > 0.95, `Expected >95% reduction, got ${(progressRatio * 100).toFixed(1)}%`);

  // 2. Simulated 60,000 char verbose compiler log
  const longLines: string[] = [];
  for (let i = 1; i <= 600; i++) {
    longLines.push(`[COMPILE][STEP ${i}] Transpiling TypeScript source files in worker thread ${i % 8}...`);
  }
  const longText = longLines.join('\n');
  const truncatedResult = truncateTerminalOutput(longText, { maxLength: 6000, maxLines: 90 });
  const compressionRatio = truncatedResult.savedChars / truncatedResult.originalLength;
  // Expect > 75% reduction on large logs
  assert.ok(compressionRatio > 0.75, `Expected >75% reduction, got ${(compressionRatio * 100).toFixed(1)}%`);
});
