import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-repo command hooks (OpenHands `.openhands/hooks.json` parity, lite).
 * Opt-in file: `<workspaceRoot>/.minus/hooks.json`
 *   { "preRun": [{ "pattern": "rm -rf /", "action": "deny", "message": "..." }, ...] }
 * - `deny`  → hard block before any dispatch (HOOK_DENIED, non-bypassable).
 * - `warn`  → advisory string attached to the result, execution continues.
 * File absent → single cached negative lookup (~microseconds). Zero LLM
 * context cost: rules surface only when they fire.
 */

export interface HookRule {
  pattern: string;
  action: 'deny' | 'warn';
  message?: string;
}

interface HookCacheEntry {
  at: number;
  mtimeMs: number;
  rules: HookRule[];
}

const CACHE = new Map<string, HookCacheEntry>();
const CACHE_TTL_MS = 30_000;

function loadRules(workspaceRoot: string): HookRule[] {
  const key = path.resolve(workspaceRoot);
  const file = path.join(key, '.minus', 'hooks.json');
  let statMtime = 0;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return [];
    statMtime = st.mtimeMs;
  } catch {
    return [];
  }
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.mtimeMs === statMtime) {
    return cached.rules;
  }
  let rules: HookRule[] = [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.preRun) ? parsed.preRun : [];
    for (const r of list) {
      if (!r || typeof r.pattern !== 'string' || !r.pattern) continue;
      // Validate the regex now; invalid rules are ignored, never fatal.
      try {
        new RegExp(r.pattern, 'i');
      } catch {
        continue;
      }
      rules.push({
        pattern: r.pattern,
        action: r.action === 'warn' ? 'warn' : 'deny',
        ...(typeof r.message === 'string' ? { message: r.message } : {}),
      });
      if (rules.length >= 50) break;
    }
  } catch {
    rules = [];
  }
  CACHE.set(key, { at: Date.now(), mtimeMs: statMtime, rules });
  return rules;
}

/** For tests. */
export function clearHookCache(): void {
  CACHE.clear();
}

export interface HookVerdict {
  allowed: boolean;
  errorCode?: string;
  message?: string;
  suggestion?: string;
  advisory?: string;
}

export function evaluateCommandHooks(command: string, workspaceRoot: string): HookVerdict {
  const rules = loadRules(workspaceRoot);
  if (rules.length === 0) return { allowed: true };
  const advisories: string[] = [];
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      continue;
    }
    if (!re.test(command)) continue;
    if (rule.action === 'deny') {
      return {
        allowed: false,
        errorCode: 'HOOK_DENIED',
        message: rule.message || `Blocked by repo hook (.minus/hooks.json pattern "${rule.pattern}").`,
        suggestion: 'Edit .minus/hooks.json or use a command outside the hook patterns.',
      };
    }
    advisories.push(rule.message || `Repo hook warning for pattern "${rule.pattern}".`);
  }
  if (advisories.length > 0) {
    return { allowed: true, advisory: advisories.join('\n') };
  }
  return { allowed: true };
}
