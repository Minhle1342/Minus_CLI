import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workspace } from './workspace.js';
import { MutationTransaction, type StagedMutationOp } from './mutation-transaction.js';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

export class WorktreeManager {
  readonly workspaceRoot: string;
  readonly worktreeDir: string;
  readonly composeWorktreeDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.worktreeDir = path.join(this.workspaceRoot, '.codingagent', 'worktrees');
    this.composeWorktreeDir = path.join(this.workspaceRoot, '.minus', 'worktrees');
  }

  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd: this.workspaceRoot,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  private async execGitIn(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, { cwd, timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
  }

  /** Create a unique Compose branch under .minus/worktrees. */
  async createFeatureWorktree(featureName: string, branch?: string): Promise<{ worktreePath: string; branch: string; reused?: boolean }> {
    const safeName = featureName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'feature';
    const resolvedBranch = branch || `compose/${safeName}-${Date.now().toString(36)}`;
    await fs.promises.mkdir(this.composeWorktreeDir, { recursive: true });
    const targetPath = path.join(this.composeWorktreeDir, safeName);
    const relative = path.relative(this.composeWorktreeDir, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe Compose worktree path.');
    if (fs.existsSync(targetPath)) {
      const existing = (await this.list()).find((item) => item.path === path.resolve(targetPath));
      if (existing?.branch === resolvedBranch) return { worktreePath: targetPath, branch: resolvedBranch, reused: true };
      throw new Error(`Compose worktree path is occupied by another branch: ${targetPath}`);
    }
    try {
      await this.execGit(['worktree', 'add', '-b', resolvedBranch, targetPath, 'HEAD']);
      return { worktreePath: targetPath, branch: resolvedBranch };
    } catch (error: any) {
      try {
        await this.execGit(['show-ref', '--verify', `refs/heads/${resolvedBranch}`]);
        await this.execGit(['worktree', 'add', targetPath, resolvedBranch]);
        return { worktreePath: targetPath, branch: resolvedBranch, reused: true };
      } catch {}
      throw new Error(`Failed to create Compose worktree: ${error.message}`);
    }
  }

  /** Apply preflighted mutations atomically inside an isolated worktree. */
  async applyTransaction(targetWorktreePath: string, operations: StagedMutationOp[]) {
    this.assertManagedWorktree(targetWorktreePath);
    const transaction = new MutationTransaction(new Workspace(targetWorktreePath));
    for (const op of operations) {
      if (op.type === 'create') transaction.stageCreate(op.path, op.content, op.expectedAbsent);
      else if (op.type === 'update') transaction.stageUpdate(op.path, op.newContent, op.expectedFileHash);
      else if (op.type === 'delete') transaction.stageDelete(op.path, op.expectedFileHash, op.reason);
      else transaction.stageMove(op.sourcePath, op.targetPath, op.expectedSourceHash);
    }
    return transaction.commit();
  }

  /** Commit, fast-forward into the original branch, and clean up only after success. */
  async mergeAndCleanup(params: { worktreePath: string; branch: string; commitMessage: string }): Promise<{ commit: string }> {
    this.assertManagedWorktree(params.worktreePath);
    const status = (await this.execGitIn(params.worktreePath, ['status', '--porcelain'])).stdout.trim();
    if (status) {
      await this.execGitIn(params.worktreePath, ['add', '-A']);
      await this.execGitIn(params.worktreePath, ['commit', '-m', params.commitMessage]);
    }
    const commit = (await this.execGitIn(params.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    await this.execGit(['merge', '--ff-only', params.branch]);
    await this.remove(params.worktreePath, false);
    await this.execGit(['branch', '-d', params.branch]).catch(() => {});
    return { commit };
  }

  /** Discard only a managed Compose worktree and its dedicated branch. */
  async discardFeatureWorktree(worktreePath: string, branch?: string): Promise<void> {
    await this.remove(worktreePath, true);
    if (branch?.startsWith('compose/')) await this.execGit(['branch', '-D', branch]).catch(() => {});
  }

  private assertManagedWorktree(targetWorktreePath: string): void {
    const target = path.resolve(targetWorktreePath);
    if (target === this.workspaceRoot) throw new Error('Cannot operate on the main workspace as an isolated worktree.');
    const managed = [this.worktreeDir, this.composeWorktreeDir].some((root) => {
      const relative = path.relative(root, target);
      return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!managed) throw new Error('Unsafe worktree path: target is outside managed worktree directories.');
  }

  /**
   * Tạo một Worktree mới trong thư mục .codingagent/worktrees
   */
  async create(branch: string, customName?: string): Promise<{ worktreePath: string; branch: string }> {
    if (!branch || typeof branch !== 'string') {
      throw new Error('Branch name is required to create a worktree.');
    }

    // Đảm bảo thư mục cha tồn tại
    if (!fs.existsSync(this.worktreeDir)) {
      fs.mkdirSync(this.worktreeDir, { recursive: true });
    }

    const safeName = (customName || branch).replace(/[^a-zA-Z0-9_-]/g, '-');
    const targetPath = path.join(this.worktreeDir, safeName);

    // Kiểm tra an toàn: targetPath phải nằm trong worktreeDir
    const relative = path.relative(this.worktreeDir, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Unsafe worktree path: target directory must reside inside .codingagent/worktrees');
    }

    if (fs.existsSync(targetPath)) {
      throw new Error(`Worktree directory already exists: ${targetPath}`);
    }

    // Chạy git worktree add
    try {
      await this.execGit(['worktree', 'add', '-B', branch, targetPath]);
      return { worktreePath: targetPath, branch };
    } catch (err: any) {
      throw new Error(`Failed to create git worktree: ${err.message}`);
    }
  }

  /**
   * Liệt kê các Worktrees
   */
  async list(): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await this.execGit(['worktree', 'list', '--porcelain']);
      const worktrees: WorktreeInfo[] = [];
      const blocks = stdout.split('\n\n');

      for (const block of blocks) {
        const lines = block.trim().split('\n');
        let wtPath = '';
        let head = '';
        let branch = '';

        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            wtPath = line.slice(9).trim();
          } else if (line.startsWith('HEAD ')) {
            head = line.slice(5).trim();
          } else if (line.startsWith('branch ')) {
            branch = line.slice(7).replace('refs/heads/', '').trim();
          }
        }

        if (wtPath) {
          const resolvedWt = path.resolve(wtPath);
          const isMain = resolvedWt === this.workspaceRoot;
          worktrees.push({
            path: resolvedWt,
            branch: branch || 'detached',
            head,
            isMain,
          });
        }
      }

      return worktrees;
    } catch (err: any) {
      return [];
    }
  }

  /**
   * Xóa một isolated worktree an toàn
   */
  async remove(targetWorktreePath: string, force = false): Promise<boolean> {
    const resolvedTarget = path.resolve(targetWorktreePath);

    // Tuyệt đối không xóa main workspace
    if (resolvedTarget === this.workspaceRoot) {
      throw new Error('Cannot remove the main active workspace worktree.');
    }

    // Phải nằm trong .codingagent/worktrees
    this.assertManagedWorktree(resolvedTarget);

    try {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push(resolvedTarget);
      await this.execGit(args);
      return true;
    } catch (err: any) {
      // Fallback xóa thư mục nếu git worktree prune cần
      if (fs.existsSync(resolvedTarget)) {
        try {
          fs.rmSync(resolvedTarget, { recursive: true, force: true });
          await this.execGit(['worktree', 'prune']).catch(() => {});
          return true;
        } catch {}
      }
      throw new Error(`Failed to remove worktree: ${err.message}`);
    }
  }
}
