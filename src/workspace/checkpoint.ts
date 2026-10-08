import path from 'node:path';
import fs from 'node:fs/promises';

export interface Checkpoint {
  id: string; index: number; timestamp: string; description: string;
  commitHash?: string; diffSummary?: string; isTaskCheckpoint?: boolean; taskId?: string; workspaceDigest?: string;
}
type FileState = { content?: Buffer; mode?: number };
type RollbackResult = { success: boolean; message: string; checkpoint?: Checkpoint; restoredFiles?: string[] };
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
      return { content: await fs.readFile(absolute), mode: stat.mode };
    } catch (error: any) { if (error?.code === 'ENOENT') return {}; throw error; }
  }
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
    try {
      for (const [file] of snapshot.before) if (!this.same(await this.readState(file), snapshot.owned.get(file)!)) return { success: false, message: `Rollback refused: ${file} changed outside the recorded mutation. User changes were preserved.` };
      const restoredFiles: string[] = [];
      for (const [file, state] of snapshot.before) {
        if (!this.same(await this.readState(file), snapshot.owned.get(file)!)) throw new Error(`Concurrent external change: ${file}`);
        const absolute = path.join(this.workspaceDir, file);
        if (state.content === undefined) await fs.rm(absolute, { force: true });
        else { await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, state.content); if (state.mode !== undefined) await fs.chmod(absolute, state.mode); }
        restoredFiles.push(file);
      }
      await this.recordMutation(restoredFiles);
      return { success: true, message: `Restored ${restoredFiles.length} scoped file(s) to checkpoint ${target.id}.`, checkpoint: target, restoredFiles };
    } catch (error: any) { return { success: false, message: `Scoped rollback failed: ${error.message}. No broad Git restore was attempted.` }; }
  }
  getHistory(): Checkpoint[] { return this.checkpoints.map(cp => ({ ...cp })); }
  getTaskCheckpoints(): Checkpoint[] { return this.getHistory().filter(cp => cp.isTaskCheckpoint); }
  getLastCheckpoint(): Checkpoint | undefined { const cp = this.checkpoints.at(-1); return cp ? { ...cp } : undefined; }
}
