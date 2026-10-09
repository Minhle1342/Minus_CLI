import path from 'node:path';
import { analyzeShellCommand } from '../security/shell-segmenter.js';
import type { SandboxStatus } from './types.js';

export interface HostCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  errorCode?: 'HOST_SYSTEM_RISK';
}

/**
 * Commands that can safely run when Docker is temporarily unavailable. Keep this
 * intentionally small: an unrecognised command must retain the isolation boundary.
 */
const READ_ONLY_COMMAND = /^(?:cat|type|head|tail|less|more|ls|dir|tree|pwd|rg|ripgrep|grep|findstr|select-string|where|which|git\s+(?:status|log|diff|show|branch|rev-parse|describe|remote|config\s+--get|check-ignore)|node\s+(?:--version|-v|--check\b|-c\b|(?:--import\s+\S+\s+)*--test\b)|bun\s+(?:--version|-v|test\b)|(?:npx\s+)?tsc(?:\.cmd|\.exe)?\s+--noEmit\b|npm\s+--version|python(?:3)?\s+(?:--version|-V)|dotnet\s+--version|echo)\b/i;

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
  return READ_ONLY_COMMAND.test(normalized);
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
  if (process.env.MINUS_ALLOW_HOST_FALLBACK === 'true' || process.env.MINUS_ALLOW_HOST_FALLBACK === '1') {
    return false;
  }
  return Boolean(status.fallbackToLocal && !status.isIsolated && requiresIsolatedExecution(command));
}

/** Approval is necessary for host execution, but never sufficient for system-destructive commands. */
export function evaluateHostCommandPolicy(command: string, workspaceRoot?: string): HostCommandPolicyResult {
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
 * True when the command holds recursive-delete segments and EVERY delete
 * target resolves inside the workspace. Anything else (format, dd, fork
 * bombs, outside targets, unparseable input) returns false to stay fail-closed.
 */
export function allRecursiveDeleteTargetsInWorkspace(command: string, workspaceRoot: string): boolean {
  let analysis: { error?: string; segments: string[] };
  try {
    analysis = analyzeShellCommand(command);
  } catch {
    return false;
  }
  if (analysis.error || (analysis.segments || []).length === 0) return false;
  const root = path.resolve(workspaceRoot);
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
    if (paths.length === 0) return false;
    targets.push(...paths);
  }
  if (targets.length === 0) return false;
  return targets.every((target) => {
    const resolved = path.resolve(root, target);
    const relative = path.relative(root, resolved);
    const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
    return normalized !== '' && !normalized.startsWith('..') && !path.isAbsolute(normalized);
  });
}
