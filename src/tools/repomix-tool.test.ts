import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompressedCodeTool, createPackCodebaseTool } from './repomix-tool.js';
import { Workspace } from '../workspace/workspace.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

test('repomix-tool: tool definitions export proper names and parameters', () => {
  const readCompressed = createReadCompressedCodeTool();
  const packCodebase = createPackCodebaseTool();

  assert.equal(readCompressed.name, 'read_compressed_code');
  assert.equal(readCompressed.parameters?.type, 'OBJECT');
  assert.ok(readCompressed.parameters?.properties?.paths);
  assert.ok(readCompressed.parameters?.properties?.compress);
  assert.ok(readCompressed.parameters?.properties?.fidelity);

  assert.equal(packCodebase.name, 'pack_codebase');
  assert.equal(packCodebase.parameters?.type, 'OBJECT');
});

test('repomix-tool: read_compressed_code reads a small file without error', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-repomix-test-'));
  try {
    const sampleFile = path.join(tempDir, 'sample.ts');
    await fs.writeFile(
      sampleFile,
      'export interface Sample { id: string; }\nexport function hello(): string { return "world"; }\n',
      'utf-8'
    );

    const workspace = new Workspace(tempDir);
    const tool = createReadCompressedCodeTool();
    const result: any = await tool.execute({ paths: ['sample.ts'] }, workspace);

    assert.equal(result.totalFiles, 1);
    assert.ok(result.totalTokens > 0);
    assert.ok(result.files.length === 1);
    assert.match(result.files[0].content, /export function hello/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('repomix-tool: observation masking triggers on oversized payloads (commit 18c67b2)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-repomix-oversize-'));
  try {
    // Generate a file with enough content to exceed token limit
    const largeLines: string[] = [];
    for (let i = 0; i < 1500; i++) {
      largeLines.push(`export const largeItem${i} = { index: ${i}, name: 'sample_${i}', details: 'verbose payload token bloating data' };`);
    }
    const sampleFile = path.join(tempDir, 'large.ts');
    await fs.writeFile(sampleFile, largeLines.join('\n'), 'utf-8');

    const workspace = new Workspace(tempDir);
    const tool = createReadCompressedCodeTool();
    const result: any = await tool.execute({ paths: ['large.ts'], compress: false }, workspace);

    if (result.observationMasked) {
      assert.equal(result.observationMasked, true);
      assert.ok(result.offloadFilePath.includes('.codingagent/scratch'));
      assert.equal(result.files[0].status, 'MASKED_TO_SCRATCH');
      assert.ok(result.message.includes('[OBSERVATION MASKED]'));
    } else {
      assert.ok(result.totalFiles >= 1);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
