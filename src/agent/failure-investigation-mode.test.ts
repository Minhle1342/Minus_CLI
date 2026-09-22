import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFailureInvestigationBrief } from './failure-investigation-mode.js';

test('failure investigation ranks the reported source location before broad exploration', () => {
  const brief = buildFailureInvestigationBrief({
    command: 'npm test -- parser',
    result: {
      exitCode: 1,
      stderr: 'src/parser.ts:42:7 - error TS2322: Type string is not assignable to number',
    },
    recentMutation: {
      toolName: 'replace_text',
      args: { path: 'src/parser.ts' },
      result: {
        blastRadius: {
          modifiedSymbols: ['parseInput'],
          directConsumers: ['src/cli.ts'],
          impactedTestSuites: ['src/parser.test.ts'],
        },
      },
      files: ['src/parser.ts'],
    },
  });

  assert.equal(brief.mode, 'soft');
  assert.equal(brief.options[0]?.toolName, 'read_file');
  assert.deepEqual(brief.options[0]?.args, { path: 'src/parser.ts', startLine: 32, endLine: 57 });
  assert.ok(brief.options.some((option) => option.toolName === 'get_diagnostics'));
  assert.ok(brief.options.some((option) => option.toolName === 'query_call_graph'));
  assert.match(brief.prompt, /direct bounded repair is still allowed/i);
});

test('failure investigation falls back to a soft workspace diagnostic when no location is available', () => {
  const brief = buildFailureInvestigationBrief({
    command: 'npm test',
    result: { exitCode: 2, stderr: 'test runner exited unexpectedly' },
  });

  assert.deepEqual(brief.options, [{
    id: 'collect-workspace-diagnostics',
    toolName: 'get_diagnostics',
    args: {},
    reason: 'The failure has no usable source location; collect diagnostics before changing code.',
    expectedInformationGain: 'medium',
  }]);
});
