import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileTool } from './read-file.js';
import { Workspace } from '../workspace/workspace.js';
import { StepPromptPolicy, type StepPromptPolicyContext } from '../agent/step-prompt-policy.js';

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

test('readFileTool schema explains when to supply both line boundaries and when to omit them', () => {
  assert.ok(readFileTool.parameters);
  const properties = readFileTool.parameters.properties!;
  assert.match(readFileTool.description, /both startLine and endLine/);
  assert.match(readFileTool.description, /small file/);
  assert.match(readFileTool.description, /hasMore.*not.*read/i);
  assert.match(properties.startLine.description!, /endLine/);
  assert.match(properties.endLine.description!, /startLine/);
  assert.match(properties.symbol.description!, /Omit.*startLine.*endLine/i);
  assert.match(properties.outlineOnly.description!, /Omit.*startLine.*endLine/i);
});

test('readFileTool carries non-blocking scope advice without encouraging exhaustive pagination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-scope-guidance-'));
  try {
    const workspace = new Workspace(root);
    await fs.writeFile(path.join(root, 'large.ts'), [
      'export function target() { return 42; }',
      ...Array.from({ length: 499 }, (_, i) => `// filler ${i}`),
    ].join('\n'));
    await fs.writeFile(path.join(root, 'small.json'), '{"enabled":true}');

    const preview = await readFileTool.execute({ path: 'large.ts' }, workspace);
    assert.equal(preview.error, undefined);
    assert.equal(preview.endLine, 120);
    assert.equal(preview.hasMore, true);
    assert.match(preview._guardian_warnings[0], /STRONG ADVISORY/);
    assert.match(preview._guardian_warnings[0], /both startLine and endLine/);
    const context: StepPromptPolicyContext = {
      activeStepQuery: 'Find the relevant declaration',
      fingerprint: 'read-scope-test',
      classification: {
        id: 'read-scope', version: 1, taskClass: 'question', phase: 'explore',
        complexity: 'small', externality: 'local', reversibility: 'read-only', risk: 'R0',
        requiredCapabilities: ['inspect'], confidence: 0.95, fastPath: false,
        reasonCodes: [], createdAt: '2026-10-07T00:00:00.000Z',
      },
      hasPlan: false, planRequired: false, planIncomplete: false, planBlocked: false,
      readyTaskCount: 0, visibleToolNames: ['read_file'], consecutiveFailures: 0,
      hasValidatedHypothesis: false, hasSubmittedSolution: false, hasVerifiedTests: false,
      activeAgentCount: 0, harnessProfileName: 'balanced-default',
      lastToolName: 'read_file', lastToolResult: preview,
      candidates: {
        legacyPlanContext: '', stepPlanContext: '', advicePrompt: '',
        harnessGuidance: '', scaffoldPrompt: '',
      },
    };
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      const decision = new StepPromptPolicy().decide(context, mode);
      assert.ok(decision.reasonCodes.includes('STRONG_ADVISORY_CARRIED_GUARDIAN_ADVISORY'));
      assert.match(decision.strongAdvisoryPrompt, /READ SCOPE/);
    }
    assert.match(preview.paginationSuggestion, /Only if.*needed/);
    assert.match(preview.paginationSuggestion, /startLine=121, endLine=240/);

    const startOnly = await readFileTool.execute({ path: 'large.ts', startLine: 200 }, workspace);
    assert.equal(startOnly.endLine, 449); // Compatibility: advisory, not rejection.
    assert.match(startOnly._guardian_warnings[0], /both startLine and endLine/);
    const endOnly = await readFileTool.execute({ path: 'large.ts', endLine: 10 }, workspace);
    assert.match(endOnly._guardian_warnings[0], /both startLine and endLine/);

    for (const args of [{ startLine: 200, endLine: 210 }, { offset: 200, limit: 11 }]) {
      const scoped = await readFileTool.execute({ path: 'large.ts', ...args }, workspace);
      assert.equal(scoped.linesCount, 11);
      assert.equal(scoped._guardian_warnings, undefined);
      assert.match(scoped.readScopeGuidance, /Stop.*sufficient/);
      assert.equal(scoped.contentHash, preview.contentHash);
    }

    const outline = await readFileTool.execute({ path: 'large.ts', outlineOnly: true }, workspace);
    assert.match(outline.readScopeGuidance, /symbol/);
    assert.match(outline.readScopeGuidance, /both startLine and endLine/);
    const symbol = await readFileTool.execute({ path: 'large.ts', symbol: 'target' }, workspace);
    assert.equal(symbol.completeDeclaration, true);
    assert.equal(symbol._guardian_warnings, undefined);
    assert.match(symbol.readScopeGuidance, /No.*line range.*needed/);
    const full = await readFileTool.execute({ path: 'small.json' }, workspace);
    assert.equal(full.error, undefined);
    assert.equal(full.hasMore, false);
    assert.equal(full._guardian_warnings, undefined);
    assert.match(full.readScopeGuidance, /small file/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
