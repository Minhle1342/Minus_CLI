import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';

/**
 * Persistent shell session for run_command (Claude/OpenHands parity, lite).
 * - `cd <dir>` sticks across calls (cwd persists per session+workspace).
 * - `export FOO=bar` / `$env:FOO=...` prefixes persist into later calls.
 * In-memory only, keyed by sessionId + resolved workspaceRoot so parallel
 * sessions/subagents never inherit each other's cwd or env.
 * Zero LLM context cost: behavior is invisible until the model runs `cd`.
 */

interface ShellSession {
  cwd?: string;
  env: Record<string, string>;
}

const SESSIONS = new Map<string, ShellSession>();

function sessionKey(workspaceRoot: string, sessionId?: string): string {
  return `${sessionId ?? 'default'}@${path.resolve(workspaceRoot)}`;
}

export function getShellSession(workspaceRoot: string, sessionId?: string): ShellSession {
  const key = sessionKey(workspaceRoot, sessionId);
  let s = SESSIONS.get(key);
  if (!s) {
    s = { env: {} };
    SESSIONS.set(key, s);
  }
  return s;
}

/** For tests: drop all sessions or every session of one workspace. */
export function clearShellSessions(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    SESSIONS.clear();
    return;
  }
  const suffix = '@' + path.resolve(workspaceRoot);
  for (const key of [...SESSIONS.keys()]) {
    if (key.endsWith(suffix)) SESSIONS.delete(key);
  }
}

/** Effective cwd for real (non-emulated) execution. Falls back to workspace root. */
export function resolveSessionCwd(workspace: Workspace, sessionId?: string): string {
  const s = SESSIONS.get(sessionKey(workspace.rootDir, sessionId));
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
  sessionId: string | undefined,
  extracted?: Record<string, string>,
): Record<string, string> {
  const s = getShellSession(workspaceRoot, sessionId);
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
export function tryHandleCdCommand(command: string, workspace: Workspace, sessionId?: string): string | null {
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
  const s = getShellSession(workspace.rootDir, sessionId);
  s.cwd = safe;
  return safe;
}
