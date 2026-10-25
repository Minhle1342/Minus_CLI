import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../workspace/workspace.js';
import { parseGitInvocation } from './git-command-policy.js';
import { detectExplicitGitCommandNames, isGitCommandAuthorized, classifyGitCommand, validateGitCommandScope } from './git-command-policy.js';
import { detectExplicitGitMutationIntent, extractRequestedGitBranch } from './git-intent.js';
import { pushArgsTargetBranch } from './git-command-policy.js';
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
  assert.match(tool.description, /sensitive operations/i);
  assert.match(tool.description, /secrets or tokens/i);
  assert.match(properties.command.description, /&&/);
  assert.match(properties.command.description, /approval/i);
  assert.match(properties.command.description, /Internal\/sandbox/i);
  assert.match(properties.command.description, /External/i);
  assert.match(properties.execution_target.description, /allowlist/i);
  assert.match(properties.command.description, /Git Credential Manager/);
  assert.match(properties.WaitMsBeforeAsync.description, /manage_task/);
  assert.match(properties.timeout_ms.description, /300000/);
});

test('network GitHub remotes never accept embedded credentials even after approval', async () => {
  const tool = createRunCommandTool();
  const result = await tool.execute(
    { command: 'git clone https://user:secret-test-token@github.com/acme/private.git private', execution_target: 'host' },
    new Workspace(),
    { permissionGranted: true, userRequest: 'Please git clone the private repository' } as any,
  );
  assert.equal(result.errorCode, 'GIT_CREDENTIAL_IN_URL');
  assert.doesNotMatch(JSON.stringify(result), /secret-test-token/);
});

test('Git policy blocks query-bearing GitHub clone URLs without returning their contents', () => {
  const result = checkGitPolicyForShell(
    ['git clone https://github.com/acme/private.git?token=secret-test-token private'],
    '/repo',
    'Please git clone the private repository',
  );
  assert.equal(result?.errorCode, 'GIT_CREDENTIAL_IN_URL');
  assert.doesNotMatch(JSON.stringify(result), /secret-test-token/);
});

test('network Git cannot use the background path that bypasses execution_target', async () => {
  let started = false;
  const tool = createRunCommandTool(undefined, { startTask: () => { started = true; throw Error('must not start'); } } as any);
  const result = await tool.execute(
    { command: 'git fetch origin', WaitMsBeforeAsync: 100, execution_target: 'host' },
    new Workspace(),
    { permissionGranted: true, userRequest: 'Please git fetch origin' } as any,
  );
  assert.equal(result.errorCode, 'BACKGROUND_GIT_NETWORK_UNSUPPORTED');
  assert.equal(started, false);
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

  // Whole-tree selectors stay blocked without commit intent...
  for (const command of ['git add -A', 'git add --all', 'git add .']) {
    assert.equal(
      checkGitPolicyForShell([command], '/repo', 'xem thay đổi giúp tôi')?.errorCode,
      'GIT_BROAD_STAGING_NOT_AUTHORIZED',
      `${command} must remain blocked without an explicit commit request`,
    );
  }

  // ...and wildcards/pathspecs stay blocked even with commit intent.
  for (const command of ['git add src/*.ts', 'git add :(top)src/index.ts']) {
    assert.equal(
      checkGitPolicyForShell([command], '/repo', request)?.errorCode,
      'GIT_BROAD_STAGING_NOT_AUTHORIZED',
      `${command} must remain blocked even when the request includes commit/push`,
    );
  }
});

test('destructive git needs the command named, not just any message', () => {
  const denied = checkGitPolicyForShell(['git reset --hard HEAD'], '/repo', undefined);
  assert.equal(denied?.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  const unrelated = checkGitPolicyForShell(['git reset --hard HEAD'], '/repo', 'hãy giải thích file này');
  assert.equal(unrelated?.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  const allowed = checkGitPolicyForShell(['git reset --hard HEAD'], '/repo', 'hãy reset code');
  assert.equal(allowed, undefined);
});

test('global/system scope no longer denied; authorization still applies', () => {
  const noRequest = checkGitPolicyForShell(['git --global config user.name x'], '/repo', undefined);
  assert.equal(noRequest?.errorCode, 'GIT_OPERATION_NOT_AUTHORIZED');
  const allowed = checkGitPolicyForShell(['git --global config user.name x'], '/repo', 'hãy config git');
  assert.equal(allowed, undefined);
  // Config keys that execute programs stay blocked even with a request.
  const hook = checkGitPolicyForShell(['git config --global diff.external sh -c whoami'], '/repo', 'hãy config git');
  assert.equal(hook?.errorCode, 'GIT_UNSAFE_CONFIG_KEY');
  // Reading those keys is still allowed.
  assert.equal(checkGitPolicyForShell(['git config --get core.pager'], '/repo', undefined), undefined);
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
    { command: 'git add src/*.ts' },
    workspace,
    { userRequest: 'commit và push code mới lên nhánh develop' },
  );
  assert.equal(broadStage.errorCode, 'GIT_BROAD_STAGING_NOT_AUTHORIZED');
  const reset = await tool.execute({ command: 'git reset --hard HEAD' }, workspace);
  assert.equal(reset.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  // Scope gate is policy-only: verify via checkGitPolicyForShell (no process spawn).
  const scoped = checkGitPolicyForShell(['git --global config user.name x'], '/repo', 'hãy config git');
  assert.equal(scoped, undefined, 'global config now allowed with an explicit request');
});

test('parseGitInvocation ignores git keywords in non-git commands via AST', () => {
  assert.equal(parseGitInvocation('echo "git commit -m test"'), undefined);
  assert.equal(parseGitInvocation('grep "git push" README.md'), undefined);
  assert.equal(parseGitInvocation('cat git.log'), undefined);
});

test('push args accept HEAD, upstream defaults, and dry runs', () => {
  assert.equal(pushArgsTargetBranch(['origin', 'HEAD'], 'main'), true);
  assert.equal(pushArgsTargetBranch(['origin', 'HEAD:main'], 'main'), true);
  assert.equal(pushArgsTargetBranch(['origin'], 'main'), true);
  assert.equal(pushArgsTargetBranch([], 'main'), true);
  assert.equal(pushArgsTargetBranch(['--dry-run', 'origin', 'other'], 'main'), true);
  assert.equal(pushArgsTargetBranch(['origin', 'main'], 'main'), true);
  assert.equal(pushArgsTargetBranch(['origin', 'other'], 'main'), false);
});

test('branch extraction understands len-branch phrasing without false pinning', () => {
  assert.equal(extractRequestedGitBranch('hãy đẩy code lên nhánh main'), 'main');
  assert.equal(extractRequestedGitBranch('hãy đẩy lên main'), 'main');
  assert.equal(extractRequestedGitBranch('hãy đẩy code lên repo'), undefined);
  assert.equal(extractRequestedGitBranch('fix bug login'), undefined);
});

test('whole-tree git add passes with explicit commit intent only', () => {
  const request = 'hãy commit code mới';
  assert.equal(checkGitPolicyForShell(['git add -A'], '/repo', request), undefined);
  assert.equal(checkGitPolicyForShell(['git add .'], '/repo', request), undefined);
  assert.equal(
    checkGitPolicyForShell(['git add -A'], '/repo', undefined)?.errorCode,
    'GIT_BROAD_STAGING_NOT_AUTHORIZED',
  );
  assert.equal(
    checkGitPolicyForShell(['git add src/*.ts'], '/repo', request)?.errorCode,
    'GIT_BROAD_STAGING_NOT_AUTHORIZED',
  );
});

test('vietnamese intent synonyms authorize amend and continued flows', () => {
  assert.ok(detectExplicitGitMutationIntent('hãy sửa commit vừa rồi').commit);
  assert.ok(detectExplicitGitCommandNames('tiếp tục rebase').includes('rebase'));
  assert.ok(detectExplicitGitMutationIntent('hãy đẩy code lên main').push);
  assert.equal(
    isGitCommandAuthorized('tiếp tục rebase', classifyGitCommand('rebase', [])),
    true,
  );
});

test('no-channel permission denial merges into a single COMMAND_NOT_ALLOWED', async () => {
  const workspace = new Workspace();
  const tool = createRunCommandTool();
  const denyingNoChannel = { checkPermission: async () => ({ allowed: false, errorCode: 'APPROVAL_REQUIRED' }) };
  const merged = await tool.execute(
    { command: 'copy a b' },
    workspace,
    { permissionManager: denyingNoChannel } as any,
  );
  assert.equal(merged.errorCode, 'COMMAND_NOT_ALLOWED');
  assert.match(merged.suggestion || '', /No approval channel is available/);

  const denyingWithChannel = {
    hasApprovalChannel: () => true,
    checkPermission: async () => ({ allowed: false, errorCode: 'PERMISSION_DENIED' }),
  };
  const direct = await tool.execute(
    { command: 'copy a b' },
    workspace,
    { permissionManager: denyingWithChannel } as any,
  );
  assert.equal(direct.errorCode, 'PERMISSION_DENIED');
});

test('approval suggestions branch on session interactivity, errorCodes unchanged', async () => {
  const tool = createRunCommandTool();
  const workspace = new Workspace();
  // No permission manager anywhere: no approval channel exists.
  const blocked = await tool.execute({ command: 'copy a b' }, workspace);
  assert.equal(blocked.errorCode, 'COMMAND_NOT_ALLOWED');
  assert.match(blocked.suggestion, /No approval channel is available/);

  // A permission manager with a prompt handler means a user is present.
  const interactiveTool = createRunCommandTool(undefined, undefined, { hasApprovalChannel: () => true } as any);
  const interactive = await interactiveTool.execute({ command: 'copy a b' }, workspace);
  assert.equal(interactive.errorCode, 'COMMAND_NOT_ALLOWED');
  assert.match(interactive.suggestion, /Ask the user to approve permission/);

  // Same branching inside the git policy gate (direct calls, no git binary needed).
  const gitDenied = checkGitPolicyForShell(['git stash push'], '/repo', undefined, false);
  assert.equal(gitDenied?.errorCode, 'GIT_OPERATION_NOT_AUTHORIZED');
  assert.match(gitDenied?.suggestion || '', /No approval channel is available/);
  const gitInteractive = checkGitPolicyForShell(['git stash push'], '/repo', undefined, true);
  assert.equal(gitInteractive?.errorCode, 'GIT_OPERATION_NOT_AUTHORIZED');
  assert.match(gitInteractive?.suggestion || '', /Ask the user to explicitly request/);
});

test('git scope blocks config writes disguised as reads plus exec-path and -c injections', () => {
  // `--list --add` is a WRITE: no user request may plant a hook path.
  const listAdd = validateGitCommandScope('config', ['--list', '--add', 'core.hookspath', '/tmp/evil']);
  assert.equal(listAdd.allowed, false);
  if (!listAdd.allowed) assert.equal(listAdd.errorCode, 'GIT_UNSAFE_CONFIG_KEY');
  // Pure reads stay allowed.
  assert.equal(validateGitCommandScope('config', ['--list']).allowed, true);
  assert.equal(validateGitCommandScope('config', ['--get', 'core.user']).allowed, true);
  // Sensitive key via a plain write.
  const unset = validateGitCommandScope('config', ['--unset', 'core.pager']);
  assert.equal(unset.allowed, false);
  if (!unset.allowed) assert.equal(unset.errorCode, 'GIT_UNSAFE_CONFIG_KEY');

  // Program-running global flags.
  const execPath = validateGitCommandScope('commit', ['--exec-path=/tmp/evil']);
  assert.equal(execPath.allowed, false);
  if (!execPath.allowed) assert.equal(execPath.errorCode, 'GIT_UNSAFE_ARGUMENT');

  // Config injected via -c on a non-config subcommand.
  const injected = validateGitCommandScope('commit', ['-c', 'core.hooksPath=/tmp/evil']);
  assert.equal(injected.allowed, false);
  if (!injected.allowed) assert.equal(injected.errorCode, 'GIT_UNSAFE_CONFIG_KEY');

  // Same holes through the run_command shell gate, with no user request at all.
  assert.equal(
    checkGitPolicyForShell(['git config --list --add core.hookspath /tmp/evil'], '/repo')?.errorCode,
    'GIT_UNSAFE_CONFIG_KEY',
  );
  assert.equal(
    checkGitPolicyForShell(['git --exec-path=/tmp/evil commit -m x'], '/repo', 'hãy commit')?.errorCode,
    'GIT_UNSAFE_ARGUMENT',
  );
  assert.equal(
    checkGitPolicyForShell(['git -c core.hooksPath=/tmp/evil commit -m x'], '/repo', 'hãy commit')?.errorCode,
    'GIT_UNSAFE_CONFIG_KEY',
  );
});

test('a pasted error log never authorizes a destructive git command', () => {
  const explainReset = checkGitPolicyForShell(
    ['git reset --hard HEAD'],
    '/repo',
    'giải thích cái lỗi này: fatal: git reset --hard failed',
  );
  assert.equal(explainReset?.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  const explainClean = checkGitPolicyForShell(
    ['git clean -fd'],
    '/repo',
    'giải thích cái lệnh này: git clean -fd đã chạy rồi',
  );
  assert.equal(explainClean?.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
  // Quoting the command inside an error report is not an order either.
  const quotedClean = checkGitPolicyForShell(
    ['git clean -fd'],
    '/repo',
    'lỗi này nói: git clean -fd đã chạy rồi',
  );
  assert.equal(quotedClean?.errorCode, 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED');
});

test('force push and remote branch delete require an explicit force-push request', () => {
  assert.equal(
    checkGitPolicyForShell(['git push --force origin dev'], '/repo', 'push code lên')?.errorCode,
    'GIT_FORCE_PUSH_NOT_AUTHORIZED',
  );
  assert.equal(
    checkGitPolicyForShell(['git push --delete origin dev'], '/repo', 'push code lên')?.errorCode,
    'GIT_FORCE_PUSH_NOT_AUTHORIZED',
  );
  // An explicit force-push request and a plain push still pass.
  assert.equal(
    checkGitPolicyForShell(['git push --force origin dev'], '/repo', 'force push code lên dev'),
    undefined,
  );
  assert.equal(
    checkGitPolicyForShell(['git push origin dev'], '/repo', 'push code lên'),
    undefined,
  );
});
