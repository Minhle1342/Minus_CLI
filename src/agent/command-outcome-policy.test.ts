import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateCommandResult, createPreflightBlockedResult } from '../tools/command-outcome.js';
import { toolResultFailed } from './completion-observations.js';
import { FinalAnswerGuard } from './final-answer-guard.js';
import { ReflectionEngine } from './reflection-engine.js';
import { PlanManager } from './plan-manager.js';

test('semantic command outcomes preserve expected non-zero exits without reporting a tool failure', () => {
  const noMatch = annotateCommandResult('rg impossible-pattern src', { exitCode: 1, stderr: '' });
  const diff = annotateCommandResult('git diff --exit-code', { exitCode: 1, stdout: 'diff --git a/a b/a' });

  assert.equal(noMatch.commandOutcome, 'no_match');
  assert.equal(diff.commandOutcome, 'difference_detected');
  assert.equal(toolResultFailed(noMatch), false);
  assert.equal(toolResultFailed(diff), false);
});

test('preflight rejection is blocked before dispatch instead of treated as a command failure', () => {
  const blocked = createPreflightBlockedResult(
    'npm run dev',
    'LONG_RUNNING_SERVER_REQUIRES_ASYNC',
    'Use background mode.',
    'Add WaitMsBeforeAsync.',
  );
  assert.equal(blocked.commandOutcome, 'blocked_preflight');
  assert.equal(blocked.processStarted, false);
  assert.equal(toolResultFailed(blocked), false);

  const guard = new FinalAnswerGuard();
  guard.observeToolResult('run_command', blocked);
  assert.equal(guard.evaluate('The command was blocked before it started.').allow, true);

  const reflection = new ReflectionEngine().analyze({
    toolName: 'run_command', args: { command: 'npm run dev' }, result: blocked, durationMs: 0,
  });
  assert.equal(reflection.isFailure, false);
  assert.match(reflection.advice || '', /blocked before dispatch/i);

  const plan = new PlanManager();
  plan.beginTurn(1, 'Inspect the workspace.');
  plan.createPlan([{ title: 'Inspect the workspace', acceptanceCriteria: 'Read one file.' }]);
  plan.recordToolEvidence('run_command', { command: 'npm run dev' }, blocked);
  assert.equal(plan.getTasks()[0].evidence.at(-1)?.outcome, 'blocked');
});
