import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../workspace/workspace.js';
import { parseGitInvocation } from './git-command-policy.js';
import { checkGitPolicyForShell, createRunCommandTool } from './run-command.js';

test('parseGitInvocation keeps global flags in argv for scope checks', () => {
  assert.deepEqual(parseGitInvocation('git commit -m "x"'), { subcommand: 'commit', args: ['-m', 'x'] });
  assert.deepEqual(parseGitInvocation('git --global config user.name'), {
    subcommand: 'config', args: ['--global', 'user.name'],
  });
  assert.deepEqual(parseGitInvocation('git -c foo=bar log --oneline'), {
    subcommand: 'log', args: ['-c', 'foo=bar', '--oneline'],
  });
  assert.deepEqual(parseGitInvocation('git -C . push origin main'), {
    subcommand: 'push', args: ['-C', '.', 'origin', 'main'],
  });
  assert.equal(parseGitInvocation('npm test'), undefined);
  assert.equal(parseGitInvocation('git'), undefined);
});

test('run_command schema explains chaining, long-running work, and sensitive-command boundaries', () => {
  const tool = createRunCommandTool();
  const properties = (tool.parameters as any).properties;
  assert.match(tool.description, /thao tác nhạy cảm/i);
  assert.match(tool.description, /secrets\/token/i);
  assert.match(properties.command.description, /&&/);
  assert.match(properties.command.description, /approval/i);
  assert.match(properties.WaitMsBeforeAsync.description, /manage_task/);
  assert.match(properties.timeout_ms.description, /300000/);
});

test('read-only git passes without an explicit user request', () => {
  assert.equal(checkGitPolicyForShell(['git status'], '/repo', undefined), undefined);
  assert.equal(checkGitPolicyForShell(['git log --oneline'], '/repo', undefined), undefined);
});

test('write git without an explicit user request is denied', () => {
  const violation = checkGitPolicyForShell(['git commit -m "x"'], '/repo', undefined);
  assert.equal(violation?.errorCode, 'GIT_OPERATION_NOT_AUTHORIZED');
  const requested = checkGitPolicyForShell(['git commit -m "x"'], '/repo', 'hãy commit code mới');
  assert.equal(requested, undefined);
});

test('commit intent authorizes staging explicit paths but never broad add selectors', () => {
  const request = 'commit và push code mới lên nhánh develop';
  assert.equal(checkGitPolicyForShell(['git add -- src/index.ts'], '/repo', request), undefined);
  assert.equal(checkGitPolicyForShell(['git add src/index.ts src/tools/run-command.ts'], '/repo', request), undefined);

  for (const command of ['git add -A', 'git add --all', 'git add .', 'git add src/*.ts', 'git add :(top)src/index.ts']) {
    assert.equal(
      checkGitPolicyForShell([command], '/repo', request)?.errorCode,
      'GIT_BROAD_STAGING_NOT_AUTHORIZED',
      `${command} must remain blocked even when the request includes commit/push`,
    );
  }
});

test('destructive git requires explicit destructive intent', () => {
  const denied = checkGitPolicyForShell(['git reset --hard HEAD'], '/repo', 'hãy reset code');
  assert.equal(denied?.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  const allowed = checkGitPolicyForShell(['git reset --hard HEAD'], '/repo', 'hãy reset --hard về HEAD');
  assert.equal(allowed, undefined);
});

test('global/system scope escapes are denied before authorization', () => {
  const violation = checkGitPolicyForShell(['git --global config user.name x'], '/repo', 'hãy config git');
  assert.equal(violation?.errorCode, 'GIT_SCOPE_VIOLATION');
});

test('push to a different branch than requested is denied', () => {
  const violation = checkGitPolicyForShell(
    ['git push origin main'], '/repo', 'hãy push code lên nhánh develop',
  );
  assert.equal(violation?.errorCode, 'GIT_BRANCH_NOT_AUTHORIZED');
  const allowed = checkGitPolicyForShell(
    ['git push origin develop'], '/repo', 'hãy push code lên nhánh develop',
  );
  assert.equal(allowed, undefined);
});

test('run_command denies unauthorized git before spawning any process', async () => {
  const tool = createRunCommandTool();
  const workspace = new Workspace();
  const commit = await tool.execute({ command: 'git commit -m "x"' }, workspace);
  assert.equal(commit.errorCode, 'GIT_OPERATION_NOT_AUTHORIZED');
  const broadStage = await tool.execute(
    { command: 'git add -A' },
    workspace,
    { userRequest: 'commit và push code mới lên nhánh develop' },
  );
  assert.equal(broadStage.errorCode, 'GIT_BROAD_STAGING_NOT_AUTHORIZED');
  const reset = await tool.execute({ command: 'git reset --hard HEAD' }, workspace);
  assert.equal(reset.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  const scoped = await tool.execute({ command: 'git --global config user.name x' }, workspace);
  assert.equal(scoped.errorCode, 'GIT_SCOPE_VIOLATION');
});
