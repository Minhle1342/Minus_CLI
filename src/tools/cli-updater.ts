import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExecRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string }>;

export const UPDATE_STEP_TIMEOUT_MS = 300_000;

/** Canonical source of truth for CLI updates (overridable via env/options). */
export const CANONICAL_REPO_URL = 'https://github.com/Minhle1342/Minus_CLI.git';
export const CANONICAL_BRANCH = 'develop';

export interface UpdateSource {
  repoUrl: string;
  branch: string;
}

export function resolveUpdateSource(options: { repoUrl?: string; branch?: string } = {}): UpdateSource {
  const repoUrl = options.repoUrl?.trim() || process.env.MINUS_UPDATE_REPO_URL?.trim() || CANONICAL_REPO_URL;
  const branch = options.branch?.trim() || process.env.MINUS_UPDATE_BRANCH?.trim() || CANONICAL_BRANCH;
  return { repoUrl, branch };
}

export function shortRepoLabel(repoUrl: string): string {
  const m = repoUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : repoUrl;
}

export async function defaultExecRunner(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = UPDATE_STEP_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = error as NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string };
        (err as any).stdout = String(stdout || '');
        (err as any).stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * Locate the CLI repo root (the directory containing the mini-agent-loop
 * package.json), starting from this module and walking upward. Returns
 * undefined when the CLI runs from an install without source layout.
 */
export function findCliRoot(fromDir?: string): string | undefined {
  let dir = fromDir || path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      if (fs.statSync(pkgPath).isFile()) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
          if (pkg.name === 'mini-agent-loop') return dir;
        } catch {
          // Unreadable package.json — keep walking upward.
        }
      }
    } catch {
      // No package.json here — keep walking upward.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function readCliVersion(cliRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkspaceChangeEntry {
  /** Raw `git status --porcelain` X/Y codes, e.g. ' M', '??', 'A '. */
  status: string;
  path: string;
}

export function parseGitPorcelain(output: string): WorkspaceChangeEntry[] {
  const entries: WorkspaceChangeEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    // Renames print as `old -> new`; track the new path.
    const arrow = filePath.indexOf(' -> ');
    if (arrow >= 0) filePath = filePath.slice(arrow + 4).trim();
    // Strip surrounding quotes git adds for special chars.
    if (filePath.length >= 2 && filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }
    if (filePath) entries.push({ status, path: filePath });
  }
  return entries;
}

export interface WorkspaceCheckResult {
  cliRoot: string;
  isGitRepo: boolean;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changes: WorkspaceChangeEntry[];
  version?: string;
  gitAvailable: boolean;
}

function toCount(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function checkWorkspaceChanges(
  cliRoot: string,
  run: ExecRunner = defaultExecRunner,
): Promise<WorkspaceCheckResult> {
  const empty: WorkspaceCheckResult = {
    cliRoot,
    isGitRepo: false,
    ahead: 0,
    behind: 0,
    dirty: false,
    changes: [],
    version: readCliVersion(cliRoot),
    gitAvailable: true,
  };
  let inside: string;
  try {
    inside = (await run('git', ['rev-parse', '--is-inside-work-tree'], cliRoot)).stdout.trim();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { ...empty, gitAvailable: false };
    return empty;
  }
  if (inside !== 'true') return empty;

  const result: WorkspaceCheckResult = { ...empty, isGitRepo: true };
  try {
    result.branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cliRoot)).stdout.trim() || undefined;
  } catch {
    // Detached HEAD or fresh repo — leave branch undefined.
  }
  try {
    result.head = (await run('git', ['rev-parse', 'HEAD'], cliRoot)).stdout.trim() || undefined;
  } catch {
    // No commits yet — leave head undefined.
  }
  try {
    const porcelain = (await run('git', ['status', '--porcelain'], cliRoot)).stdout;
    result.changes = parseGitPorcelain(porcelain);
    result.dirty = result.changes.length > 0;
  } catch {
    // Status unreadable — keep dirty=false with empty changes.
  }
  try {
    result.upstream = (await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cliRoot)).stdout.trim() || undefined;
  } catch {
    result.upstream = undefined;
  }
  if (result.upstream) {
    try {
      const counts = (await run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cliRoot)).stdout.trim().split(/\s+/);
      result.ahead = toCount(counts[0] || '0');
      result.behind = toCount(counts[1] || '0');
    } catch {
      // Counters unavailable — keep zeros.
    }
  }
  return result;
}

export interface CliUpdateOptions {
  /** Rebuild only (npm run build), skip fetch/pull/install. */
  buildOnly?: boolean;
  /** Canonical repo URL to update from (default: the owner's repo, env MINUS_UPDATE_REPO_URL). */
  repoUrl?: string;
  /** Canonical branch to update to (default: develop, env MINUS_UPDATE_BRANCH). */
  branch?: string;
}

export interface CliUpdateResult {
  ok: boolean;
  cliRoot: string;
  versionBefore?: string;
  versionAfter?: string;
  headBefore?: string;
  headAfter?: string;
  branch?: string;
  pulled: boolean;
  installed: boolean;
  built: boolean;
  steps: string[];
  message: string;
}

/**
 * Update the CLI working tree to the canonical branch (owner's develop by
 * default, overridable via options/env).
 *
 * Fail-closed order: refuse over uncommitted changes, require being on the
 * tracked branch, fetch the canonical source, fast-forward only when local
 * history is an ancestor, reinstall dependencies when manifests changed,
 * then rebuild. Every external failure is reported — never silently swallowed.
 */
export async function updateCli(
  cliRoot: string,
  options: CliUpdateOptions = {},
  run: ExecRunner = defaultExecRunner,
): Promise<CliUpdateResult> {
  const steps: string[] = [];
  const fail = (message: string, partial?: Partial<CliUpdateResult>): CliUpdateResult => ({
    ok: false,
    cliRoot,
    pulled: false,
    installed: false,
    built: false,
    steps,
    message,
    ...partial,
  });

  const check = options.buildOnly
    ? {
      cliRoot,
      isGitRepo: false,
      ahead: 0,
      behind: 0,
      dirty: false,
      changes: [],
      version: readCliVersion(cliRoot),
      gitAvailable: true,
    } satisfies WorkspaceCheckResult
    : await checkWorkspaceChanges(cliRoot, run);
  if (!options.buildOnly && !check.gitAvailable) {
    return fail('git is not available on PATH, so the CLI cannot check for or pull updates.');
  }
  if (!options.buildOnly && !check.isGitRepo) {
    return fail(`Not a git work tree (${cliRoot}); update via your installer instead of /update.`);
  }

  const versionBefore = check.version;
  const headBefore = check.head;

  if (options.buildOnly) {
    steps.push('Rebuilding the CLI from the current working tree (build only, no pull).');
    try {
      await run(npmCommand(), ['run', 'build'], cliRoot);
    } catch (error: any) {
      return fail(`Rebuild failed: ${readableExecError(error)}`, { versionBefore, headBefore, branch: check.branch });
    }
    steps.push('Rebuild finished.');
    return {
      ok: true,
      cliRoot,
      versionBefore,
      versionAfter: readCliVersionLocal(cliRoot, versionBefore),
      headBefore,
      headAfter: headBefore,
      branch: check.branch,
      pulled: false,
      installed: false,
      built: true,
      steps,
      message: 'CLI rebuilt from the current working tree.',
    };
  }

  if (check.dirty) {
    const preview = check.changes.slice(0, 10).map((c) => `${c.status} ${c.path}`).join('\n');
    const more = check.changes.length > 10 ? `\n… and ${check.changes.length - 10} more` : '';
    return fail(
      `Workspace has ${check.changes.length} uncommitted change(s); refusing to pull over them.\n${preview}${more}\nCommit or stash first, or run rebuild-only with \`/update build\`.`,
      { versionBefore, headBefore, branch: check.branch },
    );
  }

  if (!options.buildOnly && !check.isGitRepo) {
    return fail(`Not a git work tree (${cliRoot}); update via your installer instead of /update.`);
  }

  // Pin updates to the canonical branch (owner's develop by default), no
  // matter which branch the user currently has checked out or what their
  // fork's upstream points to. Merging foreign history into a different
  // local branch would be wrong, so require being on the target branch.
  const source = resolveUpdateSource(options);
  const sourceLabel = `${shortRepoLabel(source.repoUrl)}#${source.branch}`;
  let currentBranch: string | undefined;
  try {
    const name = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cliRoot)).stdout.trim();
    currentBranch = name && name !== 'HEAD' ? name : undefined;
  } catch {
    currentBranch = undefined;
  }
  if (currentBranch !== source.branch) {
    return fail(
      `Refusing to update: not on the tracked branch (current: ${currentBranch || 'detached HEAD'}, tracked: ${source.branch}).\nRun \`git checkout ${source.branch}\` first, or point /update elsewhere with MINUS_UPDATE_BRANCH.`,
      { versionBefore, headBefore, branch: check.branch },
    );
  }

  steps.push(`Fetching ${sourceLabel}…`);
  try {
    await run('git', ['fetch', source.repoUrl, source.branch], cliRoot);
  } catch (error: any) {
    return fail(`git fetch failed for ${sourceLabel}: ${readableExecError(error)}`, { versionBefore, headBefore, branch: check.branch });
  }

  let targetHead: string;
  try {
    targetHead = (await run('git', ['rev-parse', 'FETCH_HEAD'], cliRoot)).stdout.trim();
    if (!targetHead) throw new Error('empty FETCH_HEAD');
  } catch (error: any) {
    return fail(`Could not resolve the fetched ${sourceLabel}: ${readableExecError(error)}`, { versionBefore, headBefore, branch: check.branch });
  }

  if (headBefore && targetHead === headBefore) {
    steps.push(`Already at the latest ${sourceLabel} commit; verifying the build is fresh.`);
    try {
      await run(npmCommand(), ['run', 'build'], cliRoot);
    } catch (error: any) {
      return fail(`Already up to date, but the verification build failed: ${readableExecError(error)}`, {
        versionBefore,
        headBefore,
        branch: check.branch,
      });
    }
    steps.push('Verification build finished.');
    return {
      ok: true,
      cliRoot,
      versionBefore,
      versionAfter: readCliVersionLocal(cliRoot, versionBefore),
      headBefore,
      headAfter: targetHead,
      branch: check.branch,
      pulled: false,
      installed: false,
      built: true,
      steps,
      message: `Already on the latest version${versionBefore ? ` (v${versionBefore})` : ''} of ${sourceLabel}; rebuilt to be safe.`,
    };
  }

  try {
    await run('git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], cliRoot);
  } catch {
    return fail(
      `Local history has diverged from ${sourceLabel}; refusing to merge automatically.\nRebase or reset onto it manually, then re-run /update.`,
      { versionBefore, headBefore, branch: check.branch },
    );
  }

  steps.push(`Fast-forwarding to ${sourceLabel} @ ${targetHead.slice(0, 8)}…`);
  try {
    await run('git', ['merge', '--ff-only', 'FETCH_HEAD'], cliRoot);
  } catch (error: any) {
    return fail(
      `Fast-forward to ${sourceLabel} failed: ${readableExecError(error)}`,
      { versionBefore, headBefore, branch: check.branch },
    );
  }

  const after = await checkWorkspaceChanges(cliRoot, run);
  let installed = false;
  let pulledChangedDeps = false;
  if (headBefore && after.head && headBefore !== after.head) {
    try {
      const changed = (await run('git', ['diff', '--name-only', headBefore, after.head || 'HEAD'], cliRoot)).stdout;
      pulledChangedDeps = changed.split(/\r?\n/).some((line) => {
        const name = line.trim().replace(/\\/g, '/');
        return name === 'package.json' || name === 'package-lock.json' || name === 'npm-shrinkwrap.json';
      });
    } catch {
      // Diff unreadable — fall through to the safe mtime heuristic below.
    }
  }
  if (!pulledChangedDeps) {
    // Fallback: reinstall when the manifests are newer than node_modules.
    pulledChangedDeps = manifestsNewerThanInstall(cliRoot);
  }
  if (pulledChangedDeps) {
    steps.push('Dependency manifests changed; running npm install…');
    try {
      await run(npmCommand(), ['install'], cliRoot);
      installed = true;
    } catch (error: any) {
      return fail(`npm install failed after pulling: ${readableExecError(error)}`, {
        versionBefore,
        headBefore,
        headAfter: after.head,
        branch: check.branch,
      });
    }
  }

  steps.push('Rebuilding the CLI (npm run build)…');
  try {
    await run(npmCommand(), ['run', 'build'], cliRoot);
  } catch (error: any) {
    return fail(`npm run build failed after pulling: ${readableExecError(error)}`, {
      versionBefore,
      headBefore,
      headAfter: after.head,
      branch: check.branch,
    });
  }
  steps.push('Rebuild finished.');

  return {
    ok: true,
    cliRoot,
    versionBefore,
    versionAfter: readCliVersionLocal(cliRoot, versionBefore),
    headBefore,
    headAfter: after.head,
    branch: check.branch,
    pulled: true,
    installed,
    built: true,
    steps,
    message: `CLI updated to ${sourceLabel}${versionBefore || after.version ? ` (v${versionBefore || '?'} → v${after.version || versionBefore || '?'})` : ''} and rebuilt. Restart the CLI to run the new version.`,
  };
}

function readCliVersionLocal(cliRoot: string, fallback?: string): string | undefined {
  return readCliVersion(cliRoot) || fallback;
}

function manifestsNewerThanInstall(cliRoot: string): boolean {
  try {
    const nodeModules = path.join(cliRoot, 'node_modules');
    let installedAt = 0;
    try {
      installedAt = fs.statSync(nodeModules).mtimeMs;
    } catch {
      return true;
    }
    for (const manifest of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
      try {
        if (fs.statSync(path.join(cliRoot, manifest)).mtimeMs > installedAt) return true;
      } catch {
        // Missing manifest — ignore.
      }
    }
    return false;
  } catch {
    return false;
  }
}

function readableExecError(error: any): string {
  if (!error) return 'unknown error';
  if (error.code === 'ENOENT') return `command not found (${error.path || error.syscall || 'spawn'})`;
  const stderr = String(error.stderr || '').trim();
  const stdout = String(error.stdout || '').trim();
  const message = String(error.message || error).split('\n')[0];
  const detail = (stderr || stdout).split('\n').slice(-3).join(' ').slice(0, 300);
  return detail ? `${message} — ${detail}` : message;
}
