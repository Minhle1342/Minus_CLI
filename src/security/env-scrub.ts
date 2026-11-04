/**
 * Env-scrub for run_command children + output redaction.
 * Goal: host secrets never leak into spawned processes or back into LLM context.
 * Cost when idle: zero (pure functions, no I/O, no schema weight).
 */
import type { GateReader } from './full-access-gates.js';

const SECRET_KEY_PATTERN = /(secret|token|api[_-]?key|password|passwd|private[_-]?key|auth|bearer|session|credential)/i;

// Well-known token shapes worth redacting even without knowing the key.
const TOKEN_SHAPES: RegExp[] = [
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /sk-[A-Za-z0-9]{8,}/g,
  /xox[bap]-[A-Za-z0-9-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

/**
 * Non-secret hardening defaults for children. Giữ nguyên ngay cả khi gate 7 mở:
 * full access thêm token host, không bỏ hardening.
 */
const HARDENING_DEFAULTS: Record<string, string> = {
  CI: 'true',
  DEBIAN_FRONTEND: 'noninteractive',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  FORCE_COLOR: '0',
  npm_config_yes: 'true',
  PYTHONIOENCODING: 'utf-8',
};

/** Minimal safe base env (mirrors LocalProcessSandbox allowlist). */
export function buildSafeChildEnv(extra?: Record<string, string>, gates?: GateReader): Record<string, string> {
  if (gates?.('child_env_scrub')) {
    // Gate 7: token của host phải tới được gh/aws/gcloud — env con là process.env + extra.
    const hostEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') hostEnv[key] = value;
    }
    return { ...hostEnv, ...HARDENING_DEFAULTS, ...(extra || {}) };
  }
  const base: Record<string, string> = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USER: process.env.USER || process.env.USERNAME || '',
    ...(process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
          WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
          ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
          PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
          TEMP: process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp',
          TMP: process.env.TMP || process.env.TEMP || 'C:\\Windows\\Temp',
        }
      : {}),
    NODE_ENV: 'development',
    ...HARDENING_DEFAULTS,
  };
  if (extra) {
    // Explicit per-call env (cd/export prefixes) is honored — values are
    // redacted from output downstream instead of being dropped.
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') base[k] = v;
    }
  }
  return base;
}

/** Collect secret-looking values (len>=8) from an env map for redaction. */
export function collectSecretsFromEnv(env?: Record<string, string>): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (SECRET_KEY_PATTERN.test(k)) out.push(v);
  }
  // Host secret values that may already sit in process.env.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (SECRET_KEY_PATTERN.test(k) && !out.includes(v)) out.push(v);
  }
  // Longest first so substring replacement doesn't fragment. Redact all of them:
  // a hard cap left the shortest real passwords in logs.
  return out.sort((a, b) => b.length - a.length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact known secret values + token shapes. Cheap; no-op when no secrets. */
export function redactSecretsFromText(text: string, secrets: string[]): string {
  if (!text) return text;
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    try {
      out = out.replace(new RegExp(escapeRegExp(s), 'g'), '[REDACTED]');
    } catch {
      // A pathological value must never break output handling.
    }
  }
  for (const shape of TOKEN_SHAPES) {
    shape.lastIndex = 0;
    out = out.replace(shape, '[REDACTED]');
  }
  return out;
}
