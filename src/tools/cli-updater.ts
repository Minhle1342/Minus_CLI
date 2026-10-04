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
 * Update the CLI working tree to the latest upstream version.
 *
 * Fail-closed order: refuse to pull over uncommitted changes (would risk a
 * merge conflict inside the tool the user is running), pull fast-forward
 * only, reinstall dependencies when package.json changed, then rebuild.
 * Every external failure is reported — never silently swallowed.
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

  if (!check.upstream) {
    return fail(
      `Branch ${check.branch || '(detached)'} has no upstream; cannot determine the latest version. Set one with \`git branch --set-upstream-to=<remote>/<branch>\`.`,
      { versionBefore, headBefore, branch: check.branch },
    );
  }

  steps.push(`Fetching ${check.upstream}…`);
  try {
    await run('git', ['fetch', 'origin'], cliRoot);
  } catch (error: any) {
    return fail(`git fetch failed: ${readableExecError(error)}`, { versionBefore, headBefore, branch: check.branch });
  }

  const refreshed = await checkWorkspaceChanges(cliRoot, run);
  if (refreshed.behind <= 0) {
    steps.push('Already at the latest upstream commit; verifying the build is fresh.');
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
      headAfter: refreshed.head,
      branch: check.branch,
      pulled: false,
      installed: false,
      built: true,
      steps,
      message: `Already on the latest version${versionBefore ? ` (v${versionBefore})` : ''}; rebuilt to be safe.`,
    };
  }

  steps.push(`Pulling ${refreshed.behind} commit(s) fast-forward only…`);
  try {
    await run('git', ['pull', '--ff-only'], cliRoot);
  } catch (error: any) {
    return fail(
      `git pull --ff-only failed (upstream may have diverged from local history): ${readableExecError(error)}`,
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
    message: `CLI updated${versionBefore || after.version ? ` from v${versionBefore || '?'} to v${after.version || versionBefore || '?'}` : ''} and rebuilt. Restart the CLI to run the new version.`,
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
