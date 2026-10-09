import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MAX_INLINE_TOOL_CHARS,
  MAX_INLINE_HEAD_LINES,
  MAX_INLINE_TAIL_LINES,
  virtualizeToolOutput,
} from './tool-runner.js';

describe('Satellite 1: Observation Virtualization / Spill-to-Disk', () => {
  it('Scenario 1: Output nhỏ < 4,000 ký tự -> giữ nguyên inline', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-spill-test-'));
    try {
      const shortOutput = 'Hello world, this is a standard tool output under limit.';
      const result = virtualizeToolOutput(shortOutput, 'run_command', 'call_1', tmpDir);
      assert.strictEqual(result, shortOutput);

      // Verify no spill file was created
      const logDir = path.join(tmpDir, '.minus', 'scratch', 'tool_outputs');
      assert.strictEqual(fs.existsSync(logDir), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Scenario 2: Output lớn 25,000 ký tự -> ghi file log disk và cắt Head/Tail preview', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-spill-test-'));
    try {
      // Build a 25,000 character output across 200 lines
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        lines.push(`Line ${i}: ` + 'x'.repeat(120));
      }
      const rawText = lines.join('\n');
      assert.ok(rawText.length > MAX_INLINE_TOOL_CHARS);

      const toolCallId = 'test_call_large_123';
      const result = virtualizeToolOutput(rawText, 'run_command', toolCallId, tmpDir);

      // Verify result contains Head 30 lines and Tail 50 lines
      assert.ok(result.includes('[STDOUT TRUNCATED:'));
      assert.ok(result.includes(`First ${MAX_INLINE_HEAD_LINES} lines`));
      assert.ok(result.includes(`Last ${MAX_INLINE_TAIL_LINES} lines`));
      assert.ok(result.includes('Line 1:'));
      assert.ok(result.includes(`Line ${MAX_INLINE_HEAD_LINES}:`));
      assert.ok(!result.includes(`Line ${MAX_INLINE_HEAD_LINES + 5}:`)); // middle lines truncated
      assert.ok(result.includes('Line 200:'));
      assert.ok(result.includes(`Line ${200 - MAX_INLINE_TAIL_LINES + 1}:`));
      assert.ok(result.includes('--- Tip: To inspect full output, run `grep` or `read_file` on the log file above ---'));

      // Verify file was written to disk
      const expectedLog = path.join(tmpDir, '.minus', 'scratch', 'tool_outputs', `${toolCallId}.log`);
      assert.ok(fs.existsSync(expectedLog));
      const fileContent = fs.readFileSync(expectedLog, 'utf8');
      assert.strictEqual(fileContent, rawText);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Scenario 3: Control tools are exempted from spill', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-spill-test-'));
    try {
      const longOutput = 'A'.repeat(MAX_INLINE_TOOL_CHARS + 500);
      const result = virtualizeToolOutput(longOutput, 'update_plan_task', 'call_plan', tmpDir);
      assert.strictEqual(result, longOutput);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
