import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessFailureDetector } from './process-failure-detector.js';

const mutation = (detector: ProcessFailureDetector, result: Record<string, any> = { success: true }) => detector.observe({ toolName: 'replace_text', args: { path: 'src/a.ts', newText: 'new implementation' }, result });
const verify = (detector: ProcessFailureDetector, result: Record<string, any>) => detector.observe({ toolName: 'run_command', args: { command: 'npm test' }, result });

test('failed or blocked edits do not become observed mutations', () => {
  for (const result of [{ success: false, error: 'failed' }, { processStarted: false, errorCode: 'APPROVAL_REQUIRED' }, { status: 'running' }]) {
    const detector = new ProcessFailureDetector();
    mutation(detector, result);
    assert.equal(detector.getCurrentPhase(), 'EXPLORATION');
    for (let i = 0; i < 3; i++) assert.equal(verify(detector, { exitCode: 1 }), null);
  }
});

test('only terminal unexpected verification failures count; pending and preflight do not reset', () => {
  const detector = new ProcessFailureDetector();
  mutation(detector);
  assert.equal(verify(detector, { exitCode: 1 }), null);
  assert.equal(verify(detector, { exitCode: 1 }), null);
  for (const result of [{ success: false, error: 'preflight', processStarted: false }, { status: 'running', taskId: 'job' }, { exitCode: 1, commandOutcome: 'expected_failure' }, { exitCode: 1, commandOutcome: 'no_match' }]) assert.equal(verify(detector, result), null);
  const intervention = verify(detector, { exitCode: 1 });
  assert.equal(intervention?.type, 'LOCALIZATION_FAILURE_BACKTRACK');
  assert.doesNotMatch(intervention!.suggestedAction, /revert|roll.?back|scratch|prune/i);
  assert.doesNotMatch(intervention!.message, /signals wrong root|not a mere syntax/i);
});

test('terminal pass resets verification streak and semantic advice preserves user changes', () => {
  const detector = new ProcessFailureDetector();
  mutation(detector);
  verify(detector, { exitCode: 1 }); verify(detector, { exitCode: 1 });
  verify(detector, { exitCode: 0 });
  assert.equal(verify(detector, { exitCode: 1 }), null);
  mutation(detector, { success: false, error: 'no match' });
  const intervention = mutation(detector, { success: false, error: 'no match' });
  assert.equal(intervention?.type, 'SEMANTIC_LOOP');
  assert.doesNotMatch(intervention!.suggestedAction, /revert|roll.?back|scratch|prune/i);
});

test('verification tool and background terminal observations use actual outcomes', () => {
  const detector = new ProcessFailureDetector();
  mutation(detector);
  assert.equal(detector.observe({ toolName: 'run_test_suite', args: {}, result: { exitCode: 1, isPassed: false } }), null);
  assert.equal(detector.observe({ toolName: 'manage_task', args: { action: 'status' }, result: { action: 'status', commandCompletion: { completed: false, terminalStatus: 'running', command: 'npm test' } } }), null);
  assert.equal(detector.observe({ toolName: 'manage_task', args: { action: 'status' }, result: { action: 'status', commandCompletion: { completed: true, terminalStatus: 'completed', command: 'npm test', exitCode: 1, commandOutcome: 'failed_unexpected' } } }), null);
  assert.equal(verify(detector, { exitCode: 1 })?.type, 'LOCALIZATION_FAILURE_BACKTRACK');
});
