import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactor, type TurnWindowEntry } from './context-compactor.js';
import { collectCompactionEvidence, renderCompactionTaskState } from './compaction-evidence.js';
import type { PlanTaskGraph } from './plan-manager.js';

function exchange(name: string, args: Record<string, any>, result: Record<string, any>, id = name): any[] {
  return [
    { role: 'model', parts: [{ functionCall: { id, name, args } }] },
    { role: 'user', parts: [{ functionResponse: { id, name, response: result } }] },
  ];
}

test('only observed successful mutations enter the artifact trail', () => {
  const messages = [
    ...exchange('replace_text', { path: 'failed.ts' }, { success: false, error: 'not found' }),
    ...exchange('replace_text', { path: 'rolled-back.ts' }, { success: true, rolledBack: true }),
    ...exchange('replace_text', { path: 'unchanged.ts' }, { success: true, changed: false }),
    ...exchange('replace_text', { path: 'masked.ts' }, { status: 'masked' }, 'masked'),
    ...exchange('write_file', { path: 'created.ts' }, { success: true, created: true }),
    ...exchange('read_file', { path: 'read.ts' }, { content: 'ok' }),
    { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: 'unpaired.ts' } } }] },
  ];
  const evidence = collectCompactionEvidence(messages as any);
  assert.deepEqual(evidence.filesTouched, ['created.ts', 'read.ts']);
  assert.deepEqual(evidence.fileDeltas.map((delta) => delta.action), ['created', 'read']);
  assert.match(evidence.traces.join('\n'), /FAILED replace_text/);
});

test('pairing consumes IDs and uses ordered same-name fallback only for id-less calls', () => {
  const evidence = collectCompactionEvidence([
    ...exchange('replace_text', { path: 'ok.ts' }, { success: true }, 'ok'),
    { role: 'user', parts: [{ functionResponse: { id: 'ok', name: 'replace_text', response: { success: true } } }] },
    ...exchange('write_file', { path: 'legacy.ts' }, { success: true }, ''),
  ] as any);
  assert.deepEqual(evidence.filesTouched, ['ok.ts', 'legacy.ts']);
  assert.equal(evidence.fileDeltas.length, 2);
});

test('verification preserves command, outcome and reported test counts without inventing a pass', () => {
  const evidence = collectCompactionEvidence([
    ...exchange('run_command', { command: 'node --test src/a.test.ts' }, { exitCode: 0, stdout: '# tests 9\n# pass 9\n# fail 0' }, 'pass'),
    ...exchange('run_command', { command: 'npm test' }, { exitCode: 1, stdout: '# tests 2\n# pass 1\n# fail 1' }, 'fail'),
    ...exchange('run_command', { command: 'npm run build' }, { stdout: 'started' }, 'unknown'),
    ...exchange('run_command', { command: 'echo hello' }, { exitCode: 0 }, 'not-test'),
  ] as any);
  const traces = evidence.traces.join('\n');
  assert.match(traces, /VERIFICATION PASS.*node --test.*exitCode=0.*# tests 9.*# pass 9/);
  assert.match(traces, /VERIFICATION FAIL.*npm test.*exitCode=1.*# fail 1/);
  assert.match(traces, /VERIFICATION UNKNOWN.*npm run build/);
  assert.doesNotMatch(traces, /echo hello/);
});

const plan = {
  nodes: [
    { id: 1, title: 'Inspect', status: 'COMPLETED', notes: 'Located bug', acceptanceCriteria: 'Read source' },
    { id: 2, title: 'Fix', status: 'IN_PROGRESS', acceptanceCriteria: 'Apply verified fix' },
    { id: 3, title: 'Test', status: 'PENDING', acceptanceCriteria: 'Run regression suite' },
    { id: 4, title: 'Publish', status: 'PENDING', acceptanceCriteria: 'Approved release' },
  ],
  readyTaskIds: [3], blocked: [{ taskId: 4, dependencyIds: [2], failedDependencyIds: [], permissionBlocker: 'Approval required' }],
  edges: [], criticalPath: [], parallelBatches: [],
} as unknown as PlanTaskGraph;

test('state and next steps reflect completed, active, ready and blocked plan tasks', () => {
  const summary = renderCompactionTaskState(plan, 'max-steps');
  assert.match(summary.state.join('\n'), /Last closed turn reason: max-steps/);
  assert.match(summary.state.join('\n'), /Task #1 \[COMPLETED\].*Located bug/);
  assert.match(summary.state.join('\n'), /Blocker #4.*Approval required/);
  assert.match(summary.nextSteps.join('\n'), /Continue task #2/);
  assert.match(summary.nextSteps.join('\n'), /Start task #3.*Run regression suite/);
  assert.doesNotMatch(summary.nextSteps.join('\n'), /task #4/);
  assert.match(renderCompactionTaskState().state.join('\n'), /completion is not inferred/);
});

test('completed-turn summary and archive retain verification across subsequent compactions', () => {
  const compactor = new ContextCompactor({ preserveCompletedTurns: 1 });
  const entries: TurnWindowEntry[] = [
    ...exchange('replace_text', { path: 'bad.ts' }, { success: false, error: 'rejected' }).map((message) => ({ turn: 1, message })),
    ...exchange('run_command', { command: 'npm test' }, { exitCode: 0, stdout: '# tests 9\n# pass 9' }).map((message) => ({ turn: 1, message })),
    { turn: 2, message: { role: 'user', parts: [{ text: 'Next request' }] } },
  ];
  const first = compactor.compactCompletedTurnWindow(entries, { completedTurns: [1, 2], plan });
  const synopsis = String(first.messages[0].parts?.[0].text);
  assert.match(synopsis, /VERIFICATION PASS.*# tests 9/);
  assert.match(synopsis, /Continue task #2/);
  assert.doesNotMatch(synopsis, /\[MODIFIED\] bad.ts|\[READ-ONLY\] bad.ts/);
  assert.match(first.stats.archivedTurns![0].highSaliencyTraces!.join('\n'), /VERIFICATION PASS/);
  const second = compactor.compactCompletedTurnWindow([
    { isSynopsis: true, message: first.messages[0] },
    { turn: 2, message: first.messages[1] },
    { turn: 3, message: { role: 'user', parts: [{ text: 'Third request' }] } },
  ], { completedTurns: [1, 2, 3], plan });
  assert.match(String(second.messages[0].parts?.[0].text), /VERIFICATION PASS.*# tests 9/);
});
