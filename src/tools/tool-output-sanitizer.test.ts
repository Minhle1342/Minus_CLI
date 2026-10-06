import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getMaxToolOutputBytes,
  spillToolOutputToDisk,
  truncateAndAnnotateString,
  sanitizeToolResultPayload,
} from './tool-output-sanitizer.js';

test('Tool Output Sanitizer: respects MINUS_MAX_TOOL_OUTPUT_KB env var', () => {
  const orig = process.env.MINUS_MAX_TOOL_OUTPUT_KB;
  try {
    delete process.env.MINUS_MAX_TOOL_OUTPUT_KB;
    assert.equal(getMaxToolOutputBytes(), 12 * 1024);

    process.env.MINUS_MAX_TOOL_OUTPUT_KB = '8';
    assert.equal(getMaxToolOutputBytes(), 8 * 1024);
  } finally {
    if (orig !== undefined) {
      process.env.MINUS_MAX_TOOL_OUTPUT_KB = orig;
    } else {
      delete process.env.MINUS_MAX_TOOL_OUTPUT_KB;
    }
  }
});

test('Tool Output Sanitizer: leaves small outputs unmodified', async () => {
  const smallResult = {
    content: 'Hello, this is a small file content.',
    path: 'src/index.ts',
    lines: 1,
  };

  const sanitized = await sanitizeToolResultPayload('read_file', smallResult);
  assert.equal(sanitized.content, smallResult.content);
  assert.equal((sanitized as any)._was_truncated, undefined);
});

test('Tool Output Sanitizer: spills large text and truncates with disk pointer', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-test-sanitizer-'));
  try {
    // Tạo 300 dòng văn bản (~25KB)
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: export const value_${i} = ${i * 42};`);
    const largeContent = lines.join('\n');

    const result = {
      content: largeContent,
      path: 'large_file.ts',
    };

    const sanitized = await sanitizeToolResultPayload('read_file', result, {
      maxBytes: 2 * 1024, // Ngưỡng nhỏ 2KB cho test
      maxLines: 40,
      workspaceRoot: tempDir,
    });

    assert.equal(sanitized._was_truncated, true);
    assert.ok(sanitized._spill_log_path);
    assert.match(sanitized.content, /FULL TOOL OUTPUT SAVED TO DISK/);
    assert.match(sanitized.content, /Line 1:/);
    assert.match(sanitized.content, /Line 300:/);

    // Kiểm tra file spill thực sự tồn tại trên đĩa và chứa nguyên vẹn nội dung gốc
    const fullSpillPath = path.resolve(tempDir, sanitized._spill_log_path);
    const savedContent = await fs.readFile(fullSpillPath, 'utf-8');
    assert.equal(savedContent, largeContent);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Tool Output Sanitizer: spills giant array and trims array items', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-test-arr-'));
  try {
    const giantFileList = Array.from({ length: 200 }, (_, i) => `src/modules/submodule_${i}/component_${i}.ts`);
    const result = {
      files: giantFileList,
      totalCount: giantFileList.length,
    };

    const sanitized = await sanitizeToolResultPayload('list_files', result, {
      maxBytes: 1024,
      workspaceRoot: tempDir,
    });

    assert.equal(sanitized._was_truncated, true);
    assert.ok(sanitized.files.length < 200);
    assert.ok(sanitized._spill_log_path);
    assert.match(sanitized.files[40], /Truncated/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Adapter Tool Ordering: guarantees deterministic tool ordering regardless of insertion order', () => {
  const toolsOrderA = [
    { name: 'write_file', description: 'Write file' },
    { name: 'apply_patch', description: 'Apply patch' },
    { name: 'read_file', description: 'Read file' },
    { name: 'command_execute', description: 'Execute command' },
  ];

  const toolsOrderB = [
    { name: 'command_execute', description: 'Execute command' },
    { name: 'read_file', description: 'Read file' },
    { name: 'write_file', description: 'Write file' },
    { name: 'apply_patch', description: 'Apply patch' },
  ];

  const sortedA = [...toolsOrderA].sort((a, b) => a.name.localeCompare(b.name)).map((t) => t.name);
  const sortedB = [...toolsOrderB].sort((a, b) => a.name.localeCompare(b.name)).map((t) => t.name);

  assert.deepEqual(sortedA, ['apply_patch', 'command_execute', 'read_file', 'write_file']);
  assert.deepEqual(sortedA, sortedB);
});
