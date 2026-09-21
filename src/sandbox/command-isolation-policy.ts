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
const READ_ONLY_COMMAND = /^(?:cat|type|head|tail|less|more|ls|dir|tree|pwd|rg|ripgrep|grep|findstr|select-string|where|which|git\s+(?:status|log|diff|show|branch)|node\s+(?:--version|-v)|npm\s+--version|python(?:3)?\s+(?:--version|-V)|dotnet\s+--version|echo)\b/i;

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

/** True when a command must not silently fall back from Docker to the host. */
export function requiresIsolatedExecution(command: string): boolean {
  const analysis = analyzeShellCommand(command);
  return Boolean(analysis.error || analysis.complex || analysis.segments.length === 0 || analysis.segments.some((segment) => !isReadOnlySegment(segment)));
}

/** Only enforce fail-closed behaviour for an unexpected Docker-to-local downgrade. */
export function mustBlockUnisolatedAutoExecution(command: string, status: SandboxStatus): boolean {
  return Boolean(status.fallbackToLocal && !status.isIsolated && requiresIsolatedExecution(command));
}

/** Approval is necessary for host execution, but never sufficient for system-destructive commands. */
export function evaluateHostCommandPolicy(command: string): HostCommandPolicyResult {
  const match = HOST_SYSTEM_RISK.find((pattern) => pattern.test(command));
  if (!match) return { allowed: true };
  return {
    allowed: false,
    errorCode: 'HOST_SYSTEM_RISK',
    reason: 'Host execution blocked: command matches a system-destructive pattern and cannot be approved.',
  };
}
