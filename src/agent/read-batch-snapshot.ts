import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Batch snapshot epoch for concurrent read-only tool batches.
 *
 * Concurrent reads observe the filesystem at slightly different instants. An
 * external mutation landing mid-batch (user edit, git op, watcher) leaves no
 * trace, so the model can reason over mutually inconsistent observations.
 * This module fingerprints the batch's read targets before dispatch and
 * re-checks after completion. On mismatch the caller flags the batch
 * durably; consistent batches cost nothing in the prompt.
 */

export interface ReadBatchCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ReadSnapshot {
  takenAt: number;
  /** workspace-relative target -> "mtimeMs:size", "missing", or "unresolved". */
  entries: Record<string, string>;
}

/** Suites of read-only tools mapped to their path-like argument keys. */
const READ_TARGET_KEYS: Record<string, string[]> = {
  read_file: ['path', 'filePath', 'file'],
  list_files: ['path', 'dirPath'],
  search_text: ['path'],
  inspect_symbol: ['path', 'filePath', 'file'],
  get_diagnostics: ['path', 'filePath', 'file'],
};

/** Collects literal workspace-relative read targets from a tool batch. */
export function extractReadTargets(calls: ReadBatchCall[]): string[] {
  const targets: string[] = [];
  for (const call of calls) {
    const keys = READ_TARGET_KEYS[call.name];
    if (!keys) continue;
    for (const key of keys) {
      const value = call.args?.[key];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 1024) continue;
      targets.push(trimmed);
    }
  }
  return [...new Set(targets)];
}

function toWorkspaceRelative(rootDir: string, candidate: string): string | undefined {
  try {
    const resolved = path.resolve(rootDir, candidate);
    const root = path.resolve(rootDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
    return path.relative(root, resolved) || '.';
  } catch {
    return undefined;
  }
}

/** Stats each target once; best-effort, never throws. */
export async function snapshotReadTargets(
  rootDir: string,
  targets: string[],
): Promise<ReadSnapshot> {
  const entries: Record<string, string> = {};
  await Promise.all(targets.map(async (target) => {
    const relative = toWorkspaceRelative(rootDir, target);
    if (!relative) {
      entries[target] = 'unresolved';
      return;
    }
    try {
      const stat = await fs.stat(path.join(path.resolve(rootDir), relative));
      entries[relative] = `${stat.mtimeMs}:${stat.isDirectory() ? 0 : stat.size}`;
    } catch (error: any) {
      entries[relative] = error?.code === 'ENOENT' ? 'missing' : 'unresolved';
    }
  }));
  return { takenAt: Date.now(), entries };
}

/** Returns targets whose fingerprint changed, appeared, or vanished. */
export function diffReadSnapshots(before: ReadSnapshot, after: ReadSnapshot): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const key of keys) {
    if (before.entries[key] !== after.entries[key]) changed.push(key);
  }
  return changed.sort();
}

/** Single nudge line surfaced to the model only when a batch went stale. */
export function formatSnapshotNudge(changedFiles: string[]): string {
  const listed = changedFiles.slice(0, 5).join(', ');
  const overflow = changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : '';
  return `⚠️ [READ-BATCH SNAPSHOT STALE]: ${listed}${overflow} changed on disk while a concurrent read batch was in flight, so observations in this step may be mutually inconsistent. Re-read the file(s) you actually rely on before concluding; do not treat the batch as a single atomic snapshot.`;
}
