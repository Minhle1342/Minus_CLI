import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGitWorkflow, checkGitWorkflowCall } from './git-workflow.js';
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

test('PR inspection remains available throughout an authorized Git workflow', () => {
  const request = 'please review the PR';
  const state = workflow(request, []);
  for (const verb of ['view', 'list', 'diff', 'checks', 'status']) {
    assert.equal(checkGitWorkflowCall(state, request, 'run_command', { command: `gh pr ${verb}` }), undefined);
  }
  assert.match(checkGitWorkflowCall(state, request, 'run_command', { command: 'gh pr close 1' })!, /outside/);
});

test('explicit fetch is an inspection prerequisite before branch/implementation', () => {
  const request = 'please git fetch origin, create branch feature/new, fix the code, git commit and git push';
  const state = workflow(request, [], true);
  assert.equal(state.stage, 'Inspect');
  assert.equal(checkGitWorkflowCall(state, request, 'run_command', { command: 'git fetch origin' }), undefined);
  const awaitingFetch = workflow(request, baseline, true);
  assert.equal(awaitingFetch.stage, 'Inspect');
  assert.ok(awaitingFetch.pending.includes('fetch'));
  assert.equal(workflow(request, [...baseline, outcome(8, 'git fetch origin')], true).stage, 'Branch');
});

test('fetch alone still uses Sync and unauthorized fetch remains blocked', () => {
  assert.equal(workflow('please git fetch origin').stage, 'Sync');
  const request = 'please create branch feature/new';
  assert.match(checkGitWorkflowCall(workflow(request, []), request, 'run_command', { command: 'git fetch origin' })!, /outside/);
});

test('explicit pull can complete a remote prerequisite before implementation', () => {
  const request = 'please git pull origin then fix the code and git commit';
  const state = workflow(request, baseline, true);
  assert.equal(state.stage, 'Inspect');
  assert.ok(state.pending.includes('pull'));
  assert.equal(checkGitWorkflowCall(state, request, 'run_command', { command: 'git pull origin' }), undefined);
  assert.equal(workflow(request, [...baseline, outcome(8, 'git pull origin')], true).stage, 'Implement');
  assert.equal(workflow(request, [...baseline, outcome(8, 'git pull origin', { exitCode: 1, success: false })], true).stage, 'Inspect');
});

test('multiple branch actions require their own ordered successful outcomes', () => {
  const request = 'please create branch feature/new then delete branch obsolete';
  const first = workflow(request);
  assert.equal(first.stage, 'Branch');
  assert.equal(checkGitWorkflowCall(first, request, 'run_command', { command: 'git branch feature/new' }), undefined);
  assert.match(checkGitWorkflowCall(first, request, 'run_command', { command: 'git branch -d obsolete' })!, /create/);
  const second = workflow(request, [...baseline, outcome(8, 'git branch feature/new')]);
  assert.equal(second.stage, 'Branch');
  assert.equal(checkGitWorkflowCall(second, request, 'run_command', { command: 'git branch -d obsolete' }), undefined);
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
