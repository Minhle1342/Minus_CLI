import crypto from 'node:crypto';
import type { ChangedFileState, DiagnosticSnapshot } from '../control-plane-state.js';

export interface WorkspaceDigestInput {
  workspaceRoot: string;
  gitHead?: string;
  dirty: boolean;
  mutationSeq: number;
  changedFiles: ChangedFileState[];
  diagnostics?: DiagnosticSnapshot;
  extraMeta?: Record<string, string>;
}

/**
 * Computes a fast, reproducible SHA-256 digest over relevant workspace state.
 * Incremental and deterministic.
 */
export function computeWorkspaceDigest(input: WorkspaceDigestInput): string {
  const hasher = crypto.createHash('sha256');

  hasher.update(`root:${input.workspaceRoot}\n`);
  hasher.update(`gitHead:${input.gitHead || 'none'}\n`);
  hasher.update(`dirty:${input.dirty ? '1' : '0'}\n`);
  hasher.update(`mutationSeq:${input.mutationSeq}\n`);

  // Sort files deterministically
  const sortedFiles = [...input.changedFiles].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sortedFiles) {
    hasher.update(`file:${f.path}:${f.contentHash}:${f.mutationSeq}\n`);
  }

  // Diagnostics summary hash
  if (input.diagnostics) {
    const errorCount = input.diagnostics.errors.length;
    const syntaxCount = input.diagnostics.syntaxErrors.length;
    const unresCount = input.diagnostics.unresolvedImports.length;
    hasher.update(`diags:e${errorCount}:s${syntaxCount}:u${unresCount}\n`);
  }

  if (input.extraMeta) {
    const sortedKeys = Object.keys(input.extraMeta).sort();
    for (const k of sortedKeys) {
      hasher.update(`meta:${k}:${input.extraMeta[k]}\n`);
    }
  }

  return hasher.digest('hex');
}

export function computeContentHash(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
