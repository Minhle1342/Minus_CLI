import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';

/**
 * Persistent shell session for run_command (Claude/OpenHands parity, lite).
 * - `cd <dir>` sticks across calls (cwd persists per workspaceRoot).
 * - `export FOO=bar` / `$env:FOO=...` prefixes persist into later calls.
 * In-memory only, keyed by resolved workspaceRoot. Zero LLM context cost:
 * behavior is invisible until the model runs `cd`/env prefixes.
 */

interface ShellSession {
  cwd?: string;
  env: Record<string, string>;
}

const SESSIONS = new Map<string, ShellSession>();

export function getShellSession(workspaceRoot: string): ShellSession {
  const key = path.resolve(workspaceRoot);
  let s = SESSIONS.get(key);
  if (!s) {
    s = { env: {} };
    SESSIONS.set(key, s);
  }
  return s;
}

/** For tests: drop all sessions or one workspace session. */
export function clearShellSessions(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    SESSIONS.clear();
    return;
  }
  SESSIONS.delete(path.resolve(workspaceRoot));
}

/** Effective cwd for real (non-emulated) execution. Falls back to workspace root. */
export function resolveSessionCwd(workspace: Workspace): string {
  const s = SESSIONS.get(path.resolve(workspace.rootDir));
  if (s?.cwd) {
    try {
      // Re-validate: session cwd must stay inside the workspace.
      const rel = path.relative(workspace.rootDir, path.resolve(s.cwd));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.resolve(s.cwd);
    } catch {
      // Fall through to root.
    }
  }
  return workspace.rootDir;
}

/**
 * Merge per-call extracted env into the session and return the merged map.
 * Session values persist; per-call values win on conflict.
 */
export function trackSessionEnv(
  workspaceRoot: string,
  extracted?: Record<string, string>,
): Record<string, string> {
  const s = getShellSession(workspaceRoot);
  if (extracted) {
    for (const [k, v] of Object.entries(extracted)) {
      if (typeof v === 'string') s.env[k] = v;
    }
  }
  return { ...s.env };
}

/**
 * Handle a bare `cd <dir>` (optionally quoted, no chaining) natively:
 * persist cwd and return the new cwd, or null when not a pure cd.
 */
export function tryHandleCdCommand(command: string, workspace: Workspace): string | null {
  const m = command.trim().match(/^cd\s+(?:(["'])(.*?)\1|([^\s;&|]+))\s*$/i);
  if (!m) return null;
  const rawTarget = (m[2] ?? m[3] ?? '').trim() || '.';
  let safe: string;
  try {
    safe = workspace.resolveSafePath(rawTarget);
  } catch {
    return null;
  }
  // resolveSafePath guarantees containment; keep directories only.
  const s = getShellSession(workspace.rootDir);
  s.cwd = safe;
  return safe;
}
