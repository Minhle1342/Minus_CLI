import path from 'node:path';
import fs from 'node:fs/promises';
import { computeLineDiff } from '../tools/diff-generator.js';
import { nativeBatchReadFilesAsync, nativeScanManifest } from '../native/index.js';

export interface Checkpoint {
  id: string; index: number; timestamp: string; description: string;
  commitHash?: string; diffSummary?: string; isTaskCheckpoint?: boolean; taskId?: string; workspaceDigest?: string;
}
type FileState = { content?: Buffer; mode?: number; mtimeMs?: number; size?: number };

/** Bulk-read cap per file for the native fast path; misses fall back to exact readState. */
const DIFF_BATCH_MAX_BYTES = 8 * 1024 * 1024;
// shortcut: full-tree manifest scan only pays off above this fallback size; tune from turn profiles.
const MANIFEST_PREFILTER_THRESHOLD = 25;

export interface FileDiffItem {
  filePath: string;
  diff: string;
  status: 'MODIFIED' | 'CREATED' | 'DELETED' | 'RESTORED';
}

export type RollbackResult = {
  success: boolean;
  message: string;
  checkpoint?: Checkpoint;
  restoredFiles?: string[];
  diffs?: FileDiffItem[];
};
type ScopedSnapshot = { before: Map<string, FileState>; owned: Map<string, FileState> };

/** Scoped byte snapshots preserve user dirt and never change Git's index or branch. */
export class CheckpointManager {
  private workspaceDir: string;
  private checkpoints: Checkpoint[] = [];
  private snapshots = new Map<string, ScopedSnapshot>();
  constructor(workspaceDir: string) { this.workspaceDir = path.resolve(workspaceDir); }
  async init(): Promise<void> { this.workspaceDir = await fs.realpath(this.workspaceDir); }
  private async safeFile(file: string): Promise<string> {
    const absolute = path.resolve(this.workspaceDir, file);
    const relative = path.relative(this.workspaceDir, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Checkpoint path escapes workspace: ${file}`);
    let current = this.workspaceDir;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Checkpoint refuses symbolic link: ${file}`); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    return relative;
  }
  private async readState(file: string): Promise<FileState> {
    const safe = await this.safeFile(file);
    try {
      const absolute = path.join(this.workspaceDir, safe);
      const stat = await fs.lstat(absolute);
      if (!stat.isFile()) throw new Error(`Checkpoint target is not a regular file: ${file}`);
      // mtimeMs/size ride along for free (same lstat) to feed the manifest prefilter.
      return { content: await fs.readFile(absolute), mode: stat.mode, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error: any) { if (error?.code === 'ENOENT') return {}; throw error; }
  }
  get rootDir(): string { return this.workspaceDir; }
  private same(left: FileState, right: FileState): boolean {
    return left.content === undefined ? right.content === undefined : right.content !== undefined && left.content.equals(right.content) && left.mode === right.mode;
  }
  async createCheckpoint(description: string, options?: { isTaskCheckpoint?: boolean; taskId?: string; workspaceDigest?: string; files?: string[] }): Promise<Checkpoint | null> {
    const checkpoint: Checkpoint = { id: `${options?.isTaskCheckpoint ? 'task_cp' : 'cp'}_${Date.now()}_${this.checkpoints.length + 1}`, index: this.checkpoints.length + 1, timestamp: new Date().toISOString(), description, isTaskCheckpoint: options?.isTaskCheckpoint, taskId: options?.taskId, workspaceDigest: options?.workspaceDigest };
    this.checkpoints.push(checkpoint);
    this.snapshots.set(checkpoint.id, { before: new Map(), owned: new Map() });
    try { await this.captureFiles(checkpoint.id, options?.files || []); }
    catch (error) { this.checkpoints.pop(); this.snapshots.delete(checkpoint.id); throw error; }
    while (this.checkpoints.length > 30) this.snapshots.delete(this.checkpoints.shift()!.id);
    return checkpoint;
  }
  async createTaskCheckpoint(taskId: string, description: string, workspaceDigest?: string): Promise<Checkpoint | null> { return this.createCheckpoint(description, { isTaskCheckpoint: true, taskId, workspaceDigest }); }
  /** Capture lazily, before the first authorized mutation of each target. */
  async captureFiles(checkpointId: string, files: string[]): Promise<void> {
    const snapshot = this.snapshots.get(checkpointId);
    if (!snapshot) throw new Error(`Checkpoint ${checkpointId} has no scoped snapshot.`);
    const captured: Array<[string, FileState]> = [];
    for (const file of files) { const safe = await this.safeFile(file); if (!snapshot.before.has(safe)) captured.push([safe, await this.readState(safe)]); }
    for (const [file, state] of captured) { snapshot.before.set(file, state); snapshot.owned.set(file, state); }
  }
  /** Call only after a successful harness-owned mutation, never for arbitrary shell effects. */
  async recordMutation(files: string[]): Promise<void> {
    for (const file of files) {
      const safe = await this.safeFile(file);
      const applicable = [...this.snapshots.values()].filter(snapshot => snapshot.before.has(safe));
      if (applicable.length === 0) continue;
      const state = await this.readState(safe);
      for (const snapshot of applicable) snapshot.owned.set(safe, state);
    }
  }
  async rollbackLast(): Promise<RollbackResult> {
    const target = this.checkpoints.at(-1);
    if (!target) return { success: false, message: 'No checkpoint found in the current session to undo.' };
    const result = await this.applyRollback(target);
    if (result.success) { this.checkpoints.pop(); this.snapshots.delete(target.id); }
    return result;
  }
  async rollbackToTaskCheckpoint(checkpointIdOrTaskId: string): Promise<RollbackResult> {
    const index = this.checkpoints.findIndex(cp => cp.id === checkpointIdOrTaskId || (cp.isTaskCheckpoint && cp.taskId === checkpointIdOrTaskId));
    if (index < 0) return { success: false, message: `Task checkpoint "${checkpointIdOrTaskId}" not found for rollback.` };
    const result = await this.applyRollback(this.checkpoints[index]);
    if (result.success) for (const cp of this.checkpoints.splice(index)) this.snapshots.delete(cp.id);
    return result;
  }
  private async applyRollback(target: Checkpoint): Promise<RollbackResult> {
    const snapshot = this.snapshots.get(target.id);
    if (!snapshot || snapshot.before.size === 0) return { success: false, message: 'Checkpoint has no scoped file snapshot; no files were restored.' };
    const restoredFiles: string[] = [];
    const diffs: FileDiffItem[] = [];
    try {
      for (const [file] of snapshot.before) if (!this.same(await this.readState(file), snapshot.owned.get(file)!)) return { success: false, message: `Rollback refused: ${file} changed outside the recorded mutation. User changes were preserved.` };
      for (const [file, state] of snapshot.before) {
        const current = await this.readState(file);
        if (!this.same(current, snapshot.owned.get(file)!)) throw new Error(`Concurrent external change: ${file}`);
        const absolute = path.join(this.workspaceDir, file);
        if (state.content === undefined) {
          // File was created by tool (or did not exist before). Undo deletes it.
          const currentText = current.content ? current.content.toString('utf8') : '';
          const diff = computeLineDiff(currentText, '', file);
          diffs.push({ filePath: file, diff, status: 'DELETED' });
          await fs.rm(absolute, { force: true });
        } else if (current.content === undefined) {
          // File existed before, was deleted by tool. Undo restores it.
          const restoredText = state.content.toString('utf8');
          const diff = computeLineDiff('', restoredText, file);
          diffs.push({ filePath: file, diff, status: 'RESTORED' });
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, state.content);
        } else {
          // File was modified by tool. Undo restores original content.
          const currentText = current.content.toString('utf8');
          const restoredText = state.content.toString('utf8');
          const diff = computeLineDiff(currentText, restoredText, file);
          diffs.push({ filePath: file, diff, status: 'MODIFIED' });
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, state.content);
        }
        restoredFiles.push(file);
        if (state.content !== undefined && state.mode !== undefined) await fs.chmod(absolute, state.mode);
      }
      await this.recordMutation(restoredFiles);
      return { success: true, message: `Restored ${restoredFiles.length} scoped file(s) to checkpoint ${target.id}.`, checkpoint: target, restoredFiles, diffs };
    } catch (error: any) {
      await this.recordMutation(restoredFiles).catch(() => {});
      return { success: false, checkpoint: target, restoredFiles, diffs,
        message: `Scoped rollback failed after restoring ${restoredFiles.length} file(s): ${error.message}. No broad Git restore was attempted.` };
    }
  }
  getHistory(): Checkpoint[] { return this.checkpoints.map(cp => ({ ...cp })); }
  getTaskCheckpoints(): Checkpoint[] { return this.getHistory().filter(cp => cp.isTaskCheckpoint); }
  /** Turn diff: before vs owned snapshots in memory (zero disk I/O); disk read only for files with no recorded harness mutation. Skips unchanged files. */
  async diffTurn(checkpointId?: string): Promise<FileDiffItem[]> {
    const target = checkpointId ? this.checkpoints.find(cp => cp.id === checkpointId) : this.checkpoints.at(-1);
    if (!target) return [];
    const snapshot = this.snapshots.get(target.id);
    if (!snapshot) return [];
    const diffs: FileDiffItem[] = [];
    const diskReads: string[] = [];
    for (const [file, before] of snapshot.before) {
      const owned = snapshot.owned.get(file);
      // recordMutation swaps in a new state object; same reference means no harness mutation.
      if (owned && owned !== before) {
        if (!this.same(before, owned)) diffs.push(this.toDiffItem(file, before, owned));
      } else diskReads.push(file);
    }
    // Parallel fallback for external changes only; harness-tracked files never touch disk.
    // ① Manifest prefilter (one stat-only Rust walk): skip content reads for fingerprint-unchanged files.
    let needRead = diskReads;
    if (diskReads.length >= MANIFEST_PREFILTER_THRESHOLD) {
      const entries = nativeScanManifest(this.workspaceDir, []);
      if (entries) {
        const fingerprints = new Map(entries.map(e => [e.relPath, e.fingerprint]));
        needRead = diskReads.filter(file => {
          const before = snapshot.before.get(file)!;
          // shortcut: floor both sides (Rust truncates to whole ms); missing entry or >500KB skip → must read.
          const baseline = before.size !== undefined && before.mtimeMs !== undefined
            ? `${before.size}:${Math.floor(before.mtimeMs)}`
            : undefined;
          // Rust rel paths always use forward slashes; safe paths use the OS separator.
          return baseline === undefined || fingerprints.get(file.replace(/\\/g, '/')) !== baseline;
        });
      }
    }
    // ② Bulk content reads on a libuv worker; misses (binary/too-large/missing) degrade to exact reads.
    const states = new Map((await this.readCurrentStates(needRead)).map(r => [r.file, r]));
    for (const file of needRead) {
      const hit = states.get(file)!;
      const before = snapshot.before.get(file)!;
      const unchanged = hit.exact ? this.same(before, hit.state) : this.sameContent(before, hit.state);
      if (!unchanged) diffs.push(this.toDiffItem(file, before, hit.state));
    }
    return diffs;
  }
  private sameContent(left: FileState, right: FileState): boolean {
    return left.content === undefined ? right.content === undefined : right.content !== undefined && left.content.equals(right.content);
  }
  /** Current disk states: one native bulk crossing first, exact per-file reads only for misses. */
  private async readCurrentStates(files: string[]): Promise<Array<{ file: string; state: FileState; exact: boolean }>> {
    if (files.length === 0) return [];
    const batch = await nativeBatchReadFilesAsync(this.workspaceDir, files, DIFF_BATCH_MAX_BYTES);
    if (!batch) {
      return Promise.all(files.map(async (file) => ({ file, state: await this.readState(file), exact: true })));
    }
    const byPath = new Map(batch.map(r => [r.relPath, r]));
    const out: Array<{ file: string; state: FileState; exact: boolean }> = [];
    const misses: string[] = [];
    for (const file of files) {
      const hit = byPath.get(file);
      if (hit && !hit.error && hit.content != null) {
        // shortcut: batch carries no mode; mode-only changes skip here (cosmetic, no content diff).
        out.push({ file, state: { content: Buffer.from(hit.content, 'utf8') }, exact: false });
      } else misses.push(file);
    }
    const exact = await Promise.all(misses.map(async (file) => ({ file, state: await this.readState(file), exact: true })));
    return [...out, ...exact];
  }
  private toDiffItem(file: string, before: FileState, after: FileState): FileDiffItem {
    const beforeText = before.content?.toString('utf8') ?? '';
    const afterText = after.content?.toString('utf8') ?? '';
    if (before.content === undefined && after.content !== undefined) return { filePath: file, diff: computeLineDiff('', afterText, file), status: 'CREATED' };
    if (before.content !== undefined && after.content === undefined) return { filePath: file, diff: computeLineDiff(beforeText, '', file), status: 'DELETED' };
    return { filePath: file, diff: computeLineDiff(beforeText, afterText, file), status: 'MODIFIED' };
  }
  getLastCheckpoint(): Checkpoint | undefined { const cp = this.checkpoints.at(-1); return cp ? { ...cp } : undefined; }
}
