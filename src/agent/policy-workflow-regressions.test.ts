import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGitWorkflow } from './git-workflow.js';
import { LoopProgressGuard } from './loop-progress-guard.js';

function outcome(seq: number, command: string, payload: Record<string, any> = {}) {
  return { toolName: 'run_command', args: { command },
    call: { seq: seq - 1 }, result: { seq },
    payload: { success: true, exitCode: 0, processStarted: true, commandOutcome: 'succeeded', ...payload } } as any;
}
const baseline = [outcome(2, 'git status'), outcome(4, 'git diff'), outcome(6, 'git diff --cached')];
function workflow(userRequest: string, observations = baseline, implement = false) {
  return resolveGitWorkflow({ userRequest, observations, mayEdit: implement,
    implementationRequested: implement, implementationReady: true })!;
}

test('explicit fetch is an inspection prerequisite before branch/implementation', () => {
  const request = 'please git fetch origin, create branch feature/new, fix the code, git commit and git push';
  const state = workflow(request, [], true);
  assert.equal(state.stage, 'Inspect');
  const awaitingFetch = workflow(request, baseline, true);
  assert.equal(awaitingFetch.stage, 'Inspect');
  assert.ok(awaitingFetch.pending.includes('fetch'));
  assert.equal(workflow(request, [...baseline, outcome(8, 'git fetch origin')], true).stage, 'Branch');
});

test('fetch alone uses Sync', () => {
  assert.equal(workflow('please git fetch origin').stage, 'Sync');
});

test('explicit pull can complete a remote prerequisite before implementation', () => {
  const request = 'please git pull origin then fix the code and git commit';
  const state = workflow(request, baseline, true);
  assert.equal(state.stage, 'Inspect');
  assert.ok(state.pending.includes('pull'));
  assert.equal(workflow(request, [...baseline, outcome(8, 'git pull origin')], true).stage, 'Implement');
  assert.equal(workflow(request, [...baseline, outcome(8, 'git pull origin', { exitCode: 1, success: false })], true).stage, 'Inspect');
});

test('batched inspection git status && git diff HEAD satisfies Inspect in 1 turn', () => {
  const request = 'please git add and git commit';
  const batchedOutcome = outcome(2, 'git status -s && git diff HEAD');
  const state = workflow(request, [batchedOutcome]);
  assert.equal(state.stage, 'Commit');
});

test('clean git status output auto-satisfies diffs without extra round-trips', () => {
  const request = 'please git add and git commit';
  const cleanStatusOutcome = outcome(2, 'git status', {
    stdout: 'On branch main\nnothing to commit, working tree clean',
  });
  const state = workflow(request, [cleanStatusOutcome]);
  assert.equal(state.stage, 'Commit');
});

test('clean git status with --short or --porcelain auto-satisfies diffs', () => {
  const request = 'please git add and git commit';
  const shortOutcome = outcome(2, 'git status --short', { stdout: '' });
  const state1 = workflow(request, [shortOutcome]);
  assert.equal(state1.stage, 'Commit');

  const porcelainOutcome = outcome(2, 'git status --porcelain', { stdout: '\n' });
  const state2 = workflow(request, [porcelainOutcome]);
  assert.equal(state2.stage, 'Commit');
});

test('git diff --cached HEAD only satisfies staged diff and does not bypass unstaged diff', () => {
  const request = 'please git add and git commit';
  const partial = [outcome(2, 'git status', { stdout: 'Changes not staged for commit:\n  modified: a.ts' }), outcome(4, 'git diff --cached HEAD')];
  const state = workflow(request, partial);
  assert.equal(state.stage, 'Inspect');
  assert.deepEqual(state.pending, ['unstaged diff']);
});

test('branch-only workflow is satisfied by git status alone', () => {
  const request = 'please create branch feature/new';
  const statusOutcome = outcome(2, 'git status');
  const state = workflow(request, [statusOutcome]);
  assert.equal(state.stage, 'Branch');
});

test('stage guidance names the missing evidence', () => {
  const request = 'please git add and git commit';
  const partial = [outcome(2, 'git status'), outcome(4, 'git diff')];
  const state = workflow(request, partial);
  assert.equal(state.stage, 'Inspect');
  assert.deepEqual(state.pending, ['staged diff']);
});

test('multiple branch actions require their own ordered successful outcomes', () => {
  const request = 'please create branch feature/new then delete branch obsolete';
  const first = workflow(request);
  assert.equal(first.stage, 'Branch');
  const second = workflow(request, [...baseline, outcome(8, 'git branch feature/new')]);
  assert.equal(second.stage, 'Branch');
  assert.equal(workflow(request, [...baseline, outcome(8, 'git branch feature/new'), outcome(10, 'git branch -d obsolete')]).stage, 'Done');
});

test('alternating file edits with distinct content are actual progress', () => {
  const guard = new LoopProgressGuard();
  for (const [path, content] of [['a.ts', 'one'], ['b.ts', 'two'], ['a.ts', 'three'], ['b.ts', 'four']]) {
    const decision = guard.observe({ toolName: 'write_file', args: { path, content }, result: { success: true } });
    assert.equal(decision.message, undefined);
  }
});

test('artifact-identical alternating mutations still warn about no progress', () => {
  const guard = new LoopProgressGuard();
  let message: string | undefined;
  for (const path of ['a.ts', 'b.ts', 'a.ts', 'b.ts']) {
    message = guard.observe({ toolName: 'write_file', args: { path, content: 'unchanged' }, result: { success: true } }).message;
  }
  assert.match(message!, /no|repeat|progress/i);
});

test('inspection commands do not erase repeated-read history', () => {
  const guard = new LoopProgressGuard();
  const read = { toolName: 'read_file', args: { path: 'a.ts' }, result: { content: 'same' } };
  guard.observe(read);
  guard.observe({ toolName: 'run_command', args: { command: 'pwd' }, result: { exitCode: 0, stdout: '/workspace' } });
  const decision = guard.observe(read);
  assert.equal(decision.repetitionCount, 2);
  assert.doesNotMatch(decision.message!, /creat(?:e|ing).*project/i);
});

test('diagnostics success separates mutation trajectories', () => {
  const guard = new LoopProgressGuard();
  for (const path of ['a.ts', 'b.ts']) guard.observe({ toolName: 'write_file', args: { path, content: 'same' }, result: { success: true } });
  guard.observe({ toolName: 'get_diagnostics', args: {}, result: { clean: true, totalErrors: 0 } });
  for (const path of ['a.ts', 'b.ts']) assert.equal(guard.observe({ toolName: 'write_file', args: { path, content: 'same' }, result: { success: true } }).message, undefined);
});
