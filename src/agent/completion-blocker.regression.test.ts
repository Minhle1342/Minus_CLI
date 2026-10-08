import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionEvidenceGate } from './completion-evidence.js';
import { Session } from '../session/session.js';
import { PlanManager } from './plan-manager.js';

function verdict(toolName: string, args: Record<string, unknown>, result: Record<string, unknown>) {
  const session = new Session();
  session.append('tool/call', { toolName, toolCallId: 'blocked', args });
  session.append('tool/result', { toolName, toolCallId: 'blocked', result });
  return new CompletionEvidenceGate().evaluate('Investigation stopped because the operation could not run.', session,
    { codeChangeRequired: true, resolutionType: 'investigation_only' });
}
test('submission rejection cannot waive required mutation on retry', () => {
  assert.equal(verdict('submit_solution', {}, { errorCode: 'SYSTEM_EVIDENCE_GATE', success: false }).allow, false);
});
test('policy, permission and ordinary test failures cannot waive required work', () => {
  for (const result of [{ errorCode: 'PERMISSION_DENIED' }, { errorCode: 'TOOL_PHASE_BLOCKED' },
    { exitCode: 1, processStarted: true, stderr: 'Expected 1 received 2' }]) {
    assert.equal(verdict('run_command', { command: 'npm test' }, result).allow, false);
  }
});
test('observed external repository failure and checked missing binary allow honest blockers', () => {
  assert.equal(verdict('run_command', { command: 'git clone https://example.invalid/repo.git' },
    { exitCode: 128, processStarted: true, stderr: 'fatal: repository not found' }).allow, true);
  assert.equal(verdict('run_command', { command: 'missing-dev-tool' },
    { processStarted: false, commandOutcome: 'blocked_preflight', preflightCode: 'DEV_BINARY_NOT_FOUND' }).allow, true);
});
test('git command that never started cannot complete a plan commit step', () => {
  const plan = new PlanManager();
  plan.beginTurn(1, 'Commit changes');
  plan.createPlan([{ title: 'Commit changes' }]);
  plan.recordToolEvidence('run_command', { command: 'git commit -m fix' }, { processStarted: false, exitCode: 0 });
  assert.throws(() => plan.updateTask(1, 'COMPLETED'), /evidence/);
});

test('an external blocker does not establish completed requested work', () => {
  const session = new Session();
  session.append('tool/call', { toolName: 'run_command', toolCallId: 'clone', args: { command: 'git clone url' } });
  session.append('tool/result', { toolName: 'run_command', toolCallId: 'clone', result: { exitCode: 128, processStarted: true, stderr: 'repository not found' } });
  assert.equal(new CompletionEvidenceGate().evaluate('The task is complete.', session,
    { codeChangeRequired: true, resolutionType: 'investigation_only' }).allow, false);
});
