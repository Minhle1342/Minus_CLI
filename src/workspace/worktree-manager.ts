import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.worktreeDir = path.join(this.workspaceRoot, '.codingagent', 'worktrees');
  }

  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd: this.workspaceRoot,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
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
    const relative = path.relative(this.worktreeDir, resolvedTarget);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Unsafe worktree path: Can only remove worktrees inside .codingagent/worktrees');
    }

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
