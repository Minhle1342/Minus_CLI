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

test('git work via run_command counts like dedicated git tools in the capability guard', () => {
  const context = {
    userRequest: 'commit và push code mới lên nhánh develop',
    availableToolNames: ['git_status', 'git_diff', 'git_add', 'git_commit', 'git_push'],
  };
  const denial = "I'm unable to commit and push because I don't have the necessary tools or permissions.";
  const guard = new FinalAnswerGuard();
  assert.equal(guard.evaluate(denial, context).reason, 'unverified-capability-denial');

  guard.observeToolResult('run_command', { success: true, exitCode: 0 }, { command: 'git commit -m "fix"' });
  guard.observeToolResult('run_command', { success: true, exitCode: 0 }, { command: 'git push origin develop' });
  assert.equal(
    guard.evaluate('Không thể push vì remote từ chối protected branch; local commit đã được tạo.', context).allow,
    true,
  );
});

test('git_command subcommand satisfies the matching dedicated git tool', () => {
  const context = {
    userRequest: 'commit code mới',
    availableToolNames: ['git_commit'],
  };
  const guard = new FinalAnswerGuard();
  assert.equal(
    guard.evaluate("I cannot commit because I don't have Git tools.", context).reason,
    'unverified-capability-denial',
  );
  guard.observeToolResult('git_command', { success: true }, { subcommand: 'commit' });
  assert.equal(guard.evaluate("I cannot commit because I don't have Git tools.", context).allow, true);
});

test('git requests stay actionable through run_command after dedicated tools are unregistered', () => {
  const context = {
    userRequest: 'commit và push code mới lên nhánh develop',
    availableToolNames: ['run_command'],
  };
  const denial = "I'm unable to commit and push because I don't have the necessary tools or permissions.";
  const guard = new FinalAnswerGuard();
  assert.equal(guard.evaluate(denial, context).reason, 'unverified-capability-denial');
  guard.observeToolResult('run_command', { success: true, exitCode: 0 }, { command: 'git commit -m "x"' });
  guard.observeToolResult('run_command', { success: true, exitCode: 0 }, { command: 'git push origin develop' });
  assert.equal(guard.evaluate(denial, context).allow, true);
});

test('blocked run_command does not count as attempted git work', () => {
  const context = {
    userRequest: 'commit và push code mới lên nhánh develop',
    availableToolNames: ['git_commit', 'git_push'],
  };
  const guard = new FinalAnswerGuard();
  guard.observeToolResult(
    'run_command',
    { commandOutcome: 'blocked_preflight', processStarted: false },
    { command: 'git push origin develop' },
  );
  assert.equal(
    guard.evaluate("I'm unable to commit and push because I don't have the necessary tools or permissions.", context).reason,
    'unverified-capability-denial',
  );
});
