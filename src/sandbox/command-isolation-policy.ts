import path from 'node:path';
import { analyzeShellCommand } from '../security/shell-segmenter.js';
import type { SandboxStatus } from './types.js';
import { isDockerIsolationDisabled, canBypassDockerIsolation } from '../tools/command-outcome.js';

export interface HostCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  errorCode?: 'HOST_SYSTEM_RISK';
}

/**
 * Commands that can safely run when Docker is temporarily unavailable. Keep this
 * intentionally small: an unrecognised command must retain the isolation boundary.
 * Git coverage mirrors the read-only refinements in classifyGitCommand
 * (git-command-policy.ts): unconditionally read-only subcommands are listed bare,
 * while multi-mode subcommands (worktree, stash, tag, ...) only match with an
 * explicit read-only qualifier — `git worktree add` or `git stash push` must
 * stay fail-closed here. Network subcommands (ls-remote, fetch, pull, push,
 * clone) are deliberately excluded.
 */
const READ_ONLY_COMMAND = /^(?:cat|type|head|tail|less|more|ls|dir|tree|pwd|rg|ripgrep|grep|findstr|select-string|get-content|gc|where|which|git\s+(?:status|log|diff|show|branch|rev-parse|describe|remote|config\s+--(?:get(?:-all|-regexp|-urlmatch)?|list|-l)|check-ignore|blame|shortlog|ls-files|grep|show-ref|rev-list|ls-tree|name-rev|merge-base|version|var|help|tag\s+(?:--list|-l|--verify|-v)|worktree\s+list|stash\s+(?:list|show)|reflog\s+(?:show|exists)|notes\s+(?:list|show)|submodule\s+(?:status|summary)|bundle\s+(?:list-heads|verify)|bisect\s+log|sparse-checkout\s+list|--version|--help)|node\s+(?:--version|-v|--check\b|-c\b|(?:[^\r\n]*\s+)?--test\b)|bun\s+(?:--version|-v|test\b)|(?:npx\s+)?tsc(?:\.cmd|\.exe)?\s+--noEmit\b|npm\s+--version|python(?:3)?\s+(?:--version|-V)|dotnet\s+--version|echo)\b/i;

/**
 * Test, build, lint, and typecheck commands that are safe to run when Docker
 * isolation is unavailable (they inspect, compile, lint, or run tests without arbitrary unisolated mutation).
 */
export const SAFE_DEV_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:test\b|t\b|run\s+(?:test|build|lint|typecheck|type-check|check|format|compile)[\w:-]*)|(?:npx\s+|bunx\s+|pnpm\s+dlx\s+)?(?:tsc(?:\.cmd|\.exe)?|tsx|jest|vitest|eslint|prettier|biome|oxlint|stylelint|mocha|ava|playwright\s+test|cypress\s+run)\b|(?:tsx|jest|vitest|eslint|prettier|biome|oxlint|stylelint|mocha|ava)\b|pytest\b|python(?:3)?\s+(?:-m\s+(?:pytest|unittest|mypy|ruff|black|flake8))\b|cargo\s+(?:test|check|build|clippy|fmt)\b|go\s+(?:test|vet|build|fmt)\b|dotnet\s+(?:test|build)\b|ctest\b|clang-format\b|gofmt\b|goimports\b|golangci-lint\b|rustfmt\b|ruff\b|black\b|isort\b|flake8\b|mypy\b|pylint\b|rubocop\b|phpcs\b|php-cs-fixer\b|ktlint\b|swiftlint\b|swiftformat\b|mvn\s+(?:test|verify|compile)\b|gradle\s+(?:test|check|build)\b|(?:\.\/)?gradlew(?:\.bat)?\s+(?:test|check|build)\b|node\s+(?:[^\r\n]*\s+)?--test\b)/i;

export function isSafeDevCommand(command: string): boolean {
  return SAFE_DEV_COMMAND.test(command.trim());
}

// This remains a non-bypassable policy even after a user has approved host access.
const HOST_SYSTEM_RISK = [
  /\brm\s+(?:-[a-z]*r[a-z]*f*|-[a-z]*f[a-z]*r)\s+(?:\/|[a-z]:[\\/])/i,
  /\brmdir\s+\/s\s+\/q\s+[a-z]:[\\/]/i,
  /\b(?:remove-item|ri)\b[^\r\n]*(?:-recurse|-r)[^\r\n]*(?:[a-z]:[\\/]|\\\\)/i,
  /\bformat\s+[a-z]:/i,
  /\b(?:mkfs\.|dd\s+if=.*\bof=[\\/]dev)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

function isReadOnlySegment(segment: string): boolean {
  const normalized = segment.trim();
  if (!normalized || /(?:^|[^<])>>?|\b(?:tee|out-file|set-content|add-content)\b/i.test(normalized)) {
    return false;
  }
  // shortcut: `git clean -n/--dry-run` without -f only previews, safe without Docker; -f stays fail-closed
  if (/^git\s+clean\b/i.test(normalized)) {
    const hasDryRun = /(?:^|\s)(?:--dry-run|-[a-z]*n[a-z]*)(?:\s|$)/i.test(normalized);
    const hasForce = /(?:^|\s)(?:--force|-[a-z]*f[a-z]*)(?:\s|$)/i.test(normalized);
    if (hasDryRun && !hasForce) return true;
    return false;
  }
  return READ_ONLY_COMMAND.test(normalized) || SAFE_DEV_COMMAND.test(normalized);
}

function isReadOnlyPipeline(analysis: ReturnType<typeof analyzeShellCommand>): boolean {
  if (analysis.error || analysis.operators.length !== 1 || analysis.operators[0] !== '|') return false;
  if (analysis.segments.length !== 2 || !analysis.segments.every(isReadOnlySegment)) return false;
  return analysis.segments.every((segment) => !/[><]|`|\$\(/.test(segment));
}

/** True when a command must not silently fall back from Docker to the host. */
export function requiresIsolatedExecution(command: string): boolean {
  const analysis = analyzeShellCommand(command);
  if (analysis.error || analysis.segments.length === 0) return true;
  if (isReadOnlyPipeline(analysis)) return false;
  return Boolean(analysis.complex || analysis.segments.some((segment) => !isReadOnlySegment(segment)));
}

/** Only enforce fail-closed behaviour for an unexpected Docker-to-local downgrade. */
export function mustBlockUnisolatedAutoExecution(command: string, status: SandboxStatus): boolean {
  if (isDockerIsolationDisabled() || canBypassDockerIsolation(command)) {
    return false;
  }
  if (process.env.MINUS_ALLOW_HOST_FALLBACK === 'true' || process.env.MINUS_ALLOW_HOST_FALLBACK === '1') {
    return false;
  }
  return Boolean(status.fallbackToLocal && !status.isIsolated && requiresIsolatedExecution(command));
}

/** Approval is necessary for host execution, but never sufficient for system-destructive commands. */
export function evaluateHostCommandPolicy(command: string, workspaceRoot?: string): HostCommandPolicyResult {
  // Recursive delete of the workspace root itself: non-approvable data loss
  // (repo + .git gone after one approval click).
  if (workspaceRoot && deletesWorkspaceRoot(command, workspaceRoot)) {
    return {
      allowed: false,
      errorCode: 'HOST_SYSTEM_RISK',
      reason: 'Host execution blocked: recursively deleting the workspace root cannot be approved.',
    };
  }
  // Item 10: recursive deletes confined to the workspace are not system
  // destruction — exempt them here so they fall through to the allowlist and
  // the approval gate instead of a non-bypassable block.
  if (workspaceRoot && allRecursiveDeleteTargetsInWorkspace(command, workspaceRoot)) {
    return { allowed: true };
  }
  const match = HOST_SYSTEM_RISK.find((pattern) => pattern.test(command));
  if (!match) return { allowed: true };
  return {
    allowed: false,
    errorCode: 'HOST_SYSTEM_RISK',
    reason: 'Host execution blocked: command matches a system-destructive pattern and cannot be approved.',
  };
}

const RM_VERBS = new Set(['rm', 'rmdir', 'rd', 'remove-item', 'ri']);

/**
 * Recursive-delete targets of a command, or undefined when the input is
 * unparseable or holds no recursive delete segment (fail-closed for callers).
 */
function recursiveDeleteTargets(command: string): string[] | undefined {
  let analysis: { error?: string; segments: string[] };
  try {
    analysis = analyzeShellCommand(command);
  } catch {
    return undefined;
  }
  if (analysis.error || (analysis.segments || []).length === 0) return undefined;
  const targets: string[] = [];
  for (const segment of analysis.segments || []) {
    const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (tokens.length === 0) continue;
    const verb = (tokens[0] || '').toLowerCase();
    if (!RM_VERBS.has(verb)) continue;
    const args = tokens.slice(1).map((token) => token.replace(/^["']|["']$/g, ''));
    const flags = args.filter((arg) => arg.startsWith('-') || arg.startsWith('/'));
    const recursive = flags.some((flag) => {
      const bare = flag.replace(/^[-/]+/, '').toLowerCase();
      return /r/i.test(bare) || bare === 'recurse' || bare === 'recursive' || bare === 's';
    });
    if (!recursive) continue;
    const paths = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('/'));
    if (paths.length === 0) return undefined;
    targets.push(...paths);
  }
  if (targets.length === 0) return undefined;
  return targets;
}

/**
 * True when the command holds recursive-delete segments and EVERY delete
 * target resolves strictly inside the workspace. Anything else (format, dd,
 * fork bombs, outside targets, unparseable input) returns false to stay
 * fail-closed.
 */
export function allRecursiveDeleteTargetsInWorkspace(command: string, workspaceRoot: string): boolean {
  const targets = recursiveDeleteTargets(command);
  if (!targets) return false;
  const root = path.resolve(workspaceRoot);
  return targets.every((target) => {
    const resolved = path.resolve(root, target);
    const relative = path.relative(root, resolved);
    const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
    return normalized !== '' && !normalized.startsWith('..') && !path.isAbsolute(normalized);
  });
}

/** A recursive delete of the workspace root itself is never approvable. */
export function deletesWorkspaceRoot(command: string, workspaceRoot: string): boolean {
  const targets = recursiveDeleteTargets(command);
  if (!targets) return false;
  const root = path.resolve(workspaceRoot);
  return targets.some((target) => path.relative(root, path.resolve(root, target)) === '');
}
