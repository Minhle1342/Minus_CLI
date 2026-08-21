import path from 'node:path';
import { detectExplicitGitMutationIntent, normalizeIntentText } from './git-intent.js';

export type GitCommandRisk = 'read' | 'write' | 'network' | 'destructive';

export interface GitCommandClassification {
  subcommand: string;
  risk: GitCommandRisk;
  reason: string;
}

const READ_ONLY_COMMANDS = new Set([
  'annotate', 'archive', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap',
  'check-ref-format', 'cherry', 'column', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-pairs', 'diff-tree', 'fast-export', 'for-each-ref', 'fsck', 'get-tar-commit-id',
  'grep', 'help', 'last-modified', 'log', 'ls-files', 'ls-tree', 'merge-base', 'merge-tree',
  'name-rev', 'pack-redundant', 'patch-id', 'range-diff', 'repo', 'request-pull', 'rev-list',
  'rev-parse', 'shortlog', 'show', 'show-branch', 'show-index', 'show-ref', 'status', 'stripspace',
  'survey', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version', 'whatchanged',
]);

const NETWORK_COMMANDS = new Set([
  'archimport', 'backfill', 'clone', 'cvsimport', 'cvsserver', 'fetch', 'fetch-pack', 'imap-send',
  'ls-remote', 'p4', 'pull', 'push', 'send-email', 'send-pack', 'svn',
]);

const ALWAYS_DESTRUCTIVE_COMMANDS = new Set(['clean', 'filter-branch', 'prune', 'prune-packed']);

const COMMAND_SYNONYMS: Record<string, RegExp> = {
  add: /\b(?:git add|stage|dua vao staging|them vao staging)\b/,
  branch: /\b(?:branch|tao nhanh|xoa nhanh|liet ke nhanh)\b/,
  checkout: /\b(?:checkout|chuyen sang nhanh|khoi phuc file)\b/,
  switch: /\b(?:switch|chuyen sang nhanh|doi nhanh)\b/,
  merge: /\b(?:merge|gop nhanh|hop nhat nhanh)\b/,
  rebase: /\brebase\b/,
  'cherry-pick': /\b(?:cherry-pick|cherry pick)\b/,
  revert: /\b(?:revert|dao nguoc commit)\b/,
  reset: /\breset\b/,
  restore: /\b(?:restore|khoi phuc file|hoan tac file)\b/,
  stash: /\b(?:stash|cat tam thay doi|luu tam thay doi)\b/,
  fetch: /\b(?:fetch|tai refs|lay thay doi tu remote)\b/,
  pull: /\b(?:pull|keo code|dong bo code|cap nhat code moi nhat)\b/,
  push: /\b(?:push|day code len|dua code len)\b/,
  clone: /\b(?:clone|sao chep repo|nhan ban repo)\b/,
  init: /\b(?:git init|khoi tao git|tao repository)\b/,
  clean: /\b(?:git clean|xoa file untracked|don file untracked)\b/,
  rm: /\b(?:git rm|xoa file khoi git)\b/,
  mv: /\b(?:git mv|doi ten file trong git)\b/,
  tag: /\btag\b/,
  remote: /\bremote\b/,
  config: /\b(?:git config|cau hinh git)\b/,
  worktree: /\bworktree\b/,
  submodule: /\bsubmodule\b/,
  apply: /\b(?:git apply|ap dung patch)\b/,
  am: /\b(?:git am|ap dung mailbox)\b/,
  log: /\b(?:git log|lich su commit|xem lich su)\b/,
  status: /\b(?:git status|trang thai git)\b/,
  diff: /\b(?:git diff|xem thay doi)\b/,
  show: /\b(?:git show|xem commit)\b/,
  blame: /\b(?:git blame|ai sua dong)\b/,
};

export function classifyGitCommand(subcommand: string, args: string[] = []): GitCommandClassification {
  const command = subcommand.trim().toLowerCase();
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  const firstArg = lowerArgs.find((arg) => !arg.startsWith('-'));
  if (isDestructiveInvocation(command, lowerArgs, firstArg)) {
    return { subcommand: command, risk: 'destructive', reason: 'Command or arguments can discard data, refs, or history.' };
  }
  if (NETWORK_COMMANDS.has(command) || isNetworkInvocation(command, firstArg)) {
    return { subcommand: command, risk: 'network', reason: 'Command communicates with or changes another repository/service.' };
  }
  if (isReadOnlyInvocation(command, lowerArgs, firstArg)) {
    return { subcommand: command, risk: 'read', reason: 'Command only inspects repository state for these arguments.' };
  }
  return { subcommand: command, risk: 'write', reason: 'Command can change the worktree, index, refs, config, or object database.' };
}

export function detectExplicitGitCommandNames(userRequest?: string): string[] {
  const normalized = normalizeIntentText(userRequest || '');
  if (!normalized) return [];
  const directPrefix = /^(?:please|hay|vui long|giup toi|thuc hien|chay|goi|git)\b/.test(normalized)
    || /\b(?:please|hay|vui long|giup toi|thuc hien|chay lenh)\b/.test(normalized);
  const capabilityDiscussion = /\b(?:co quyen|co the|kha nang|ho tro|enable|allow|permission|permissions|them tool|nang cap|tai sao|why|whether)\b/.test(normalized);
  if (capabilityDiscussion && !directPrefix) return [];

  const names = new Set<string>();
  for (const match of normalized.matchAll(/\bgit\s+([a-z0-9][a-z0-9._-]*)\b/g)) names.add(match[1]);
  const mutation = detectExplicitGitMutationIntent(userRequest);
  if (mutation.stage && !mutation.commit) names.add('add');
  if (mutation.commit) names.add('commit');
  if (mutation.push) names.add('push');
  if (directPrefix || names.size > 0) {
    for (const [command, pattern] of Object.entries(COMMAND_SYNONYMS)) {
      if (pattern.test(normalized)) names.add(command);
    }
  }
  return [...names];
}

export function isGitCommandAuthorized(
  userRequest: string | undefined,
  subcommand: string,
  classification: GitCommandClassification,
): boolean {
  if (classification.risk === 'read') return true;
  const command = subcommand.toLowerCase();
  const names = new Set(detectExplicitGitCommandNames(userRequest));
  const equivalentNames: Record<string, string[]> = {
    checkout: ['checkout', 'switch', 'restore'],
    switch: ['switch', 'checkout', 'branch'],
    restore: ['restore', 'checkout'],
  };
  const requested = names.has(command) || equivalentNames[command]?.some((name) => names.has(name));
  if (!requested) return false;
  return classification.risk !== 'destructive' || hasExplicitDestructiveIntent(userRequest, command);
}

export function validateGitCommandScope(
  subcommand: string,
  args: string[],
  workspaceRoot: string,
  cwd: string,
): { allowed: true } | { allowed: false; errorCode: string; error: string } {
  const command = subcommand.toLowerCase();
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  if (lowerArgs.some((arg) => ['--global', '--system'].includes(arg))) {
    return deny('GIT_SCOPE_VIOLATION', 'Global and system Git configuration are outside the workspace scope.');
  }
  if (lowerArgs.some((arg) => arg.startsWith('--git-dir') || arg.startsWith('--work-tree'))) {
    return deny('GIT_SCOPE_VIOLATION', 'Changing Git execution scope with -C/--git-dir/--work-tree is not allowed; use cwd inside the workspace.');
  }
  for (const arg of args) {
    const candidate = extractFilesystemCandidate(arg);
    if (!candidate) continue;
    if (candidate.toLowerCase().startsWith('file://')) {
      return deny('GIT_SCOPE_VIOLATION', `Local file URL is outside the verified workspace boundary: ${candidate}`);
    }
    if (path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) {
      const resolved = path.resolve(cwd, candidate);
      const root = path.resolve(workspaceRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return deny('GIT_SCOPE_VIOLATION', `Git argument resolves outside the workspace: ${candidate}`);
      }
    }
  }
  const executableArgument = lowerArgs.find((arg) =>
    /^(?:--(?:exec|upload-pack|receive-pack|ext-diff|textconv|tool|helper|strategy)=|--no-prompt$)/.test(arg),
  );
  if (executableArgument) return deny('GIT_UNSAFE_ARGUMENT', `Argument can execute an external program: ${executableArgument}`);
  if ((command === 'submodule' && lowerArgs[0] === 'foreach')
    || (command === 'bisect' && lowerArgs[0] === 'run')
    || command === 'for-each-repo'
    || command === 'hook') {
    return deny('GIT_EXTERNAL_EXECUTION_BLOCKED', `git ${command} can execute arbitrary programs; use an explicitly authorized execution tool instead.`);
  }
  if (command === 'config') {
    const sensitiveKey = args.find((arg) => /^(?:alias\.|core\.hookspath$|core\.sshcommand$|credential\.helper$|gpg\.program$|diff\..*\.command$|merge\..*\.driver$|filter\..*\.(?:clean|smudge|process)$)/i.test(arg));
    if (sensitiveKey) return deny('GIT_UNSAFE_CONFIG_KEY', `Git config key can execute external programs and is blocked: ${sensitiveKey}`);
  }
  return { allowed: true };
}

function isReadOnlyInvocation(command: string, args: string[], firstArg?: string): boolean {
  if (READ_ONLY_COMMANDS.has(command)) return true;
  if (command === 'hash-object') return !args.includes('-w') && !args.includes('--write');
  if (command === 'branch') return args.length === 0 || args.some((arg) => ['--list', '--show-current', '-a', '--all', '-r', '--remotes'].includes(arg));
  if (command === 'tag') return args.length === 0 || args.some((arg) => ['--list', '-l', '--verify', '-v'].includes(arg));
  if (command === 'config') return args.some((arg) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'].includes(arg));
  if (command === 'remote') return args.length === 0 || args.includes('-v') || firstArg === 'get-url';
  if (command === 'stash') return firstArg === 'list' || firstArg === 'show';
  if (command === 'reflog') return !firstArg || firstArg === 'show' || firstArg === 'exists';
  if (command === 'notes') return !firstArg || firstArg === 'list' || firstArg === 'show';
  if (command === 'worktree') return firstArg === 'list';
  if (command === 'submodule') return !firstArg || firstArg === 'status' || firstArg === 'summary';
  if (command === 'bisect') return firstArg === 'log';
  if (command === 'bundle') return firstArg === 'list-heads' || firstArg === 'verify';
  if (command === 'sparse-checkout') return firstArg === 'list';
  return false;
}

function isNetworkInvocation(command: string, firstArg?: string): boolean {
  if (command === 'remote') return ['show', 'update', 'prune'].includes(firstArg || '');
  if (command === 'submodule') return ['add', 'update', 'sync', 'set-url'].includes(firstArg || '');
  return false;
}

function isDestructiveInvocation(command: string, args: string[], firstArg?: string): boolean {
  if (ALWAYS_DESTRUCTIVE_COMMANDS.has(command)) return true;
  if (command === 'reset' && args.some((arg) => ['--hard', '--merge', '--keep'].includes(arg))) return true;
  if (command === 'push' && args.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease') || arg === '--delete')) return true;
  if (command === 'branch' && args.some((arg) => ['-d', '--delete'].includes(arg))) return true;
  if (command === 'tag' && args.some((arg) => ['-d', '--delete'].includes(arg))) return true;
  if (command === 'remote' && ['remove', 'rm'].includes(firstArg || '')) return true;
  if (command === 'worktree' && ['remove', 'prune'].includes(firstArg || '')) return true;
  if (command === 'stash' && ['drop', 'clear'].includes(firstArg || '')) return true;
  if (command === 'reflog' && ['delete', 'expire', 'drop'].includes(firstArg || '')) return true;
  if (command === 'notes' && ['remove', 'prune'].includes(firstArg || '')) return true;
  if (command === 'config' && args.some((arg) => ['--unset', '--unset-all', '--remove-section'].includes(arg))) return true;
  if ((command === 'update-ref' || command === 'replace') && args.some((arg) => ['-d', '--delete'].includes(arg))) return true;
  if (['checkout', 'restore'].includes(command) && args.some((arg) => ['-f', '--force'].includes(arg))) return true;
  return command === 'rm';
}

function hasExplicitDestructiveIntent(userRequest: string | undefined, command: string): boolean {
  const normalized = normalizeIntentText(userRequest || '');
  const names = new Set(detectExplicitGitCommandNames(userRequest));
  if (!names.has(command)) return false;
  const explicitlyNamesCommand = new RegExp(`\\bgit\\s+${escapeRegExp(command)}\\b`).test(normalized);
  if (['clean', 'rm', 'prune', 'prune-packed', 'filter-branch'].includes(command) && explicitlyNamesCommand) {
    return true;
  }
  return /(?:\b(?:hard reset|force-with-lease|force push|xoa|delete|remove|drop|clear|prune|clean|expire|discard|huy bo)\b|--hard\b|--force(?:-with-lease)?\b|--delete\b|--unset(?:-all)?\b|--remove-section\b|(?:^|\s)-d(?:\s|$))/.test(normalized);
}

function extractFilesystemCandidate(arg: string): string | undefined {
  if (!arg || arg === '-' || /^https?:\/\//i.test(arg) || /^ssh:\/\//i.test(arg) || /^[^/\\]+@[^:]+:.+/.test(arg)) return undefined;
  const optionMatch = arg.match(/^--(?:output|output-directory|file|template|separate-git-dir|reference|dissociate|config-env)=(.+)$/i);
  if (optionMatch) return optionMatch[1];
  if (arg.startsWith('-')) return undefined;
  if (path.isAbsolute(arg) || arg.split(/[\\/]/).includes('..') || /^file:\/\//i.test(arg)) return arg;
  return undefined;
}

function deny(errorCode: string, error: string): { allowed: false; errorCode: string; error: string } {
  return { allowed: false, errorCode, error };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
