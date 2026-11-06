import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateFastHeuristicSummary,
  summarizeToolOutputInBackground,
  getToolOutputSummary,
  collapseTruncatedOutputToSummary,
} from './background-summarizer.js';

describe('Background Summarizer (Ponytail Lightweight State Compactor)', () => {
  it('1. Heuristic summary: extracts test results and failure reasons accurately', () => {
    const nodeTestOutput = `
    ▶ Suite 1
      ✔ Scenario 1 (2ms)
      ✖ Scenario 2: expected 200 to equal 500 (15ms)
    ℹ tests 18
    ℹ suites 1
    ℹ pass 17
    ℹ fail 1
    `;
    const summary = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: nodeTestOutput,
      exitCode: 1,
    });
    assert.match(summary, /Tests failed: 1 failed, 17 passed/);
    assert.match(summary, /Scenario 2/);
  });

  it('2. Heuristic summary: extracts clean test pass count when 0 failures', () => {
    const successTestOutput = `
    ℹ tests 25
    ℹ suites 2
    ℹ pass 25
    ℹ fail 0
    `;
    const summary = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: successTestOutput,
      exitCode: 0,
    });
    assert.equal(summary, 'Tests passed: 25 passed (0 failures).');
  });

  it('2b. Heuristic summary: extracts Mocha-style tests correctly (passes, failures, and zero failures)', () => {
    const mochaPassed = '15 passing (1.2s)\n0 failing';
    const summaryPass = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: mochaPassed,
      exitCode: 0,
    });
    assert.equal(summaryPass, 'Tests passed: 15 passed (0 failures).');

    const mochaFailed = '10 passing (2s)\n2 failing\nAssertionError: expected false to be true';
    const summaryFail = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: mochaFailed,
      exitCode: 1,
    });
    assert.match(summaryFail, /Tests failed: 2 failed, 10 passed/);
    assert.match(summaryFail, /AssertionError/);
  });

  it('2c. Heuristic summary: extracts Jest-style tests correctly', () => {
    const jestPassed = 'Tests: 18 passed, 18 total';
    const summaryPass = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: jestPassed,
      exitCode: 0,
    });
    assert.equal(summaryPass, 'Tests passed: 18 passed (0 failures).');

    const jestFailed = 'Tests: 1 failed, 17 passed, 18 total\nError: Test failed';
    const summaryFail = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: jestFailed,
      exitCode: 1,
    });
    assert.match(summaryFail, /Tests failed: 1 failed, 17 passed/);
  });

  it('3. Heuristic summary: extracts compilation error for failed command', () => {
    const buildLog = `
    [10:14:02] Starting build...
    src/agent/agent-loop.ts(45,12): error TS2304: Cannot find name 'BackgroundSummarizer'.
    [10:14:03] Build failed with 1 error.
    `;
    const summary = generateFastHeuristicSummary({
      toolName: 'run_command',
      rawText: buildLog,
      exitCode: 1,
    });
    assert.equal(summary, "Failed (exit 1): src/agent/agent-loop.ts(45,12): error TS2304: Cannot find name 'BackgroundSummarizer'.");
  });

  it('4. Heuristic summary: extracts exports and line count for read_file', () => {
    const code = `
    import fs from 'node:fs';
    export class SessionManager {}
    export function runSession() {}
    export interface SessionConfig {}
    export const DEFAULT_TIMEOUT = 5000;
    // ... 100 more lines
    ` + '\n'.repeat(100);

    const summary = generateFastHeuristicSummary({
      toolName: 'read_file',
      targetPath: 'src/session.ts',
      rawText: code,
      fieldName: 'content',
    });
    assert.match(summary, /File "src\/session\.ts" \(\d+ lines\)/);
    assert.match(summary, /Exports: SessionManager, runSession, SessionConfig, DEFAULT_TIMEOUT/);
  });

  it('5. Background task: writes .summary.txt and populates in-memory cache', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-bg-summary-'));
    try {
      const logFile = path.join(tmpDir, 'call_test_123.log');
      fs.writeFileSync(logFile, 'Sample output log text', 'utf8');

      const toolCallId = 'call_test_123';
      const summary = await summarizeToolOutputInBackground({
        toolCallId,
        toolName: 'run_command',
        rawText: 'Tests passed: 10 passed (0 failures).',
        logPath: logFile,
      });

      assert.equal(summary, 'Output with 1 lines (37 chars). Starts: "Tests passed: 10 passed (0 failures)."');

      // Check cache retrieval
      assert.equal(getToolOutputSummary(toolCallId), summary);

      // Check summary file exists on disk
      const summaryFile = `${logFile}.summary.txt`;
      assert.ok(fs.existsSync(summaryFile));
      assert.equal(fs.readFileSync(summaryFile, 'utf8'), summary);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. collapseTruncatedOutputToSummary: replaces bloated preview with single-line summary', () => {
    const truncatedPreview = [
      '[STDOUT TRUNCATED: 50,000 characters spilled to .minus/logs/tool_outputs/call_999.log]',
      '[Summary: Tests failed: 2 failed, 18 passed. Top error: AssertionError]',
      '--- Output Preview (First 40 lines) ---',
      'line 1',
      'line 2',
      '...',
      '--- Error & Tail Summary (Last 30 lines) ---',
      'line 199',
      'line 200',
    ].join('\n');

    const collapsed = collapseTruncatedOutputToSummary(truncatedPreview, 'call_999');
    assert.match(collapsed, /\[OBSERVATION SUMMARIZED: Tests failed: 2 failed, 18 passed/);
    assert.match(collapsed, /\(Full log: \.minus\/logs\/tool_outputs\/call_999\.log\)/);
    assert.ok(!collapsed.includes('Output Preview'));
    assert.ok(!collapsed.includes('line 199'));
  });
});

