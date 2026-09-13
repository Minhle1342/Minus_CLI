import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileTool } from './read-file.js';
import { Workspace } from '../workspace/workspace.js';

test('readFileTool - Directory Listing Fallback', async () => {
  const workspace = new Workspace(process.cwd());
  const res = await readFileTool.execute({ path: 'src/tools' }, workspace);

  assert.equal(res.isDirectory, true, 'Should detect path is a directory');
  assert.ok(Array.isArray(res.entries), 'Should return entries array');
  assert.ok(res.entries.some((e: any) => e.name === 'read-file.ts'), 'Should list read-file.ts');
  assert.ok(res.content.includes('[FILE] read-file.ts'), 'Formatted content should include [FILE] prefix');
  assert.ok(res.suggestion.includes('read_file'), 'Should provide actionable suggestion to read specific file');
});

test('readFileTool - Line length truncation (MAX_LINE_CHARS = 2000)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-tool-test-'));
  const testFilePath = path.join(tmpDir, 'long-lines.txt');
  
  // Tạo file có 1 dòng bình thường, 1 dòng siêu dài (2500 ký tự), 1 dòng bình thường
  const normalLine1 = 'Line 1: short text';
  const longLine = 'A'.repeat(2500);
  const normalLine3 = 'Line 3: end of test';
  await fs.writeFile(testFilePath, `${normalLine1}\n${longLine}\n${normalLine3}\n`, 'utf8');

  try {
    const workspace = new Workspace(tmpDir);
    const res = await readFileTool.execute({ path: 'long-lines.txt' }, workspace);

    assert.equal(res.hasTruncatedLines, true, 'Should flag that lines were truncated');
    assert.equal(res.truncatedLinesCount, 1, 'Should count 1 truncated line');
    assert.ok(res.content.includes('... [truncated 500 chars]'), 'Should append truncated notice with exact count');
    assert.ok(res.content.includes('Line 1: short text'), 'Normal line 1 should remain intact');
    assert.ok(res.content.includes('Line 3: end of test'), 'Normal line 3 should remain intact');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('readFileTool - Pagination with offset & limit and nextPage metadata', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-tool-paged-'));
  const testFilePath = path.join(tmpDir, 'paged.txt');
  
  // Tạo file gồm 50 dòng
  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: data content here`);
  await fs.writeFile(testFilePath, lines.join('\n'), 'utf8');

  try {
    const workspace = new Workspace(tmpDir);
    // Đọc từ dòng 10 (offset: 10), lấy 5 dòng (limit: 5)
    const res = await readFileTool.execute({ path: 'paged.txt', offset: 10, limit: 5 }, workspace);

    assert.equal(res.startLine, 10, 'startLine should be 10');
    assert.equal(res.endLine, 14, 'endLine should be 14 (10 + 5 - 1)');
    assert.equal(res.linesCount, 5, 'linesCount should be 5');
    assert.equal(res.hasMore, true, 'hasMore should be true since 14 < 50');
    assert.deepEqual(res.nextPage, {
      startLine: 15,
      endLine: 19,
      offset: 15,
      limit: 5,
    }, 'nextPage should accurately point to the next window');
    assert.ok(res.paginationSuggestion.includes('startLine=15, endLine=19'), 'Suggestion should give exact command');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('readFileTool - Preserve existing superior features: symbol extraction AST & hash', async () => {
  const workspace = new Workspace(process.cwd());
  const res = await readFileTool.execute({ path: 'src/tools/read-file.ts', symbol: 'truncateLine' }, workspace);

  assert.equal(res.symbol, 'truncateLine', 'Should locate symbol truncateLine');
  assert.ok(res.content.includes('function truncateLine(line: string'), 'Should extract full declaration code');
  assert.ok(res.contentHash.startsWith('sha256:'), 'Should return sha256 contentHash');
  assert.ok(res.eol === 'lf' || res.eol === 'crlf', 'Should detect file EOL');
});

test('readFileTool - Preserve existing superior features: outlineOnly', async () => {
  const workspace = new Workspace(process.cwd());
  const res = await readFileTool.execute({ path: 'src/tools/read-file.ts', outlineOnly: true }, workspace);

  assert.ok(res.symbolsCount > 0, 'Outline should find symbols');
  assert.ok(Array.isArray(res.symbols), 'Should return symbols array');
  assert.ok(res.contentHash.startsWith('sha256:'), 'Should include contentHash in outline mode');
});

test('readFileTool - Preserve existing superior features: fuzzy suggestion on typo', async () => {
  const workspace = new Workspace(process.cwd());
  const res = await readFileTool.execute({ path: 'src/tools/read-fil.ts' }, workspace);

  assert.equal(res.errorCode, 'FILE_NOT_FOUND', 'Should return FILE_NOT_FOUND error');
  assert.ok(Array.isArray(res.suggestions), 'Should provide typo suggestions');
  assert.ok(res.suggestions.some((s: string) => s.includes('read-file.ts')), 'Should suggest read-file.ts');
});
