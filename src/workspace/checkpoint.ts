import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const execAsync = promisify(exec);

export interface Checkpoint {
  id: string;
  index: number;
  timestamp: string;
  description: string;
  commitHash?: string;
  diffSummary?: string;
}

/**
 * CheckpointManager - Hệ thống tạo snapshot và khôi phục an toàn (Shadow Git Rollback)
 * 
 * Nguyên lý hoạt động:
 * 1. Trước mỗi hành động sửa đổi file (write_file, replace_text) hoặc chạy lệnh,
 *    hệ thống tự động ghi nhận một checkpoint.
 * 2. Lưu trữ diff trạng thái và cho phép người dùng hoàn tác (/undo) tức thì
 *    về trạng thái ổn định trước đó nếu Agent gây ra lỗi hoặc sửa sai.
 */
export class CheckpointManager {
  private workspaceDir: string;
  private checkpoints: Checkpoint[] = [];
  private isGitRepo: boolean = false;
  private checkpointDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.checkpointDir = path.join(this.workspaceDir, '.codingagent', 'checkpoints');
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(this.checkpointDir, { recursive: true });
      const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', {
        cwd: this.workspaceDir,
      });
      this.isGitRepo = stdout.trim() === 'true';
    } catch {
      this.isGitRepo = false;
    }
  }

  /**
   * Tạo checkpoint mới trước khi thực hiện hành động ghi/sửa file
   */
  async createCheckpoint(description: string): Promise<Checkpoint | null> {
    const id = `cp_${Date.now()}_${this.checkpoints.length + 1}`;
    const timestamp = new Date().toLocaleTimeString('vi-VN');

    let diffSummary = '';
    let commitHash = '';

    if (this.isGitRepo) {
      try {
        // Lấy diff hiện tại để kiểm tra
        const { stdout: diffOut } = await execAsync('git diff HEAD', {
          cwd: this.workspaceDir,
        });
        diffSummary = diffOut.slice(0, 500);

        // Tạo shadow stash commit mà không làm thay đổi working branch
        const { stdout: stashHash } = await execAsync(`git stash create "Checkpoint: ${description}"`, {
          cwd: this.workspaceDir,
        });

        commitHash = stashHash.trim();
      } catch (err: any) {
        // Fallback nhẹ nếu git fail
        commitHash = '';
      }
    }

    const checkpoint: Checkpoint = {
      id,
      index: this.checkpoints.length + 1,
      timestamp,
      description,
      commitHash,
      diffSummary,
    };

    this.checkpoints.push(checkpoint);

    // Giữ tối đa 20 checkpoints gần nhất
    if (this.checkpoints.length > 20) {
      this.checkpoints.shift();
    }

    return checkpoint;
  }

  /**
   * Hoàn tác về Checkpoint gần nhất (/undo)
   */
  async rollbackLast(): Promise<{ success: boolean; message: string; checkpoint?: Checkpoint }> {
    if (this.checkpoints.length === 0) {
      return {
        success: false,
        message: 'Không tìm thấy checkpoint nào trong phiên làm việc hiện tại để hoàn tác.',
      };
    }

    const lastCp = this.checkpoints.pop()!;

    if (this.isGitRepo && lastCp.commitHash) {
      try {
        // Khôi phục code từ commitHash đã lưu
        await execAsync(`git restore --source=${lastCp.commitHash} --worktree .`, {
          cwd: this.workspaceDir,
        });
        return {
          success: true,
          message: `Đã hoàn tác thành công về Checkpoint #${lastCp.index} (${lastCp.timestamp}: "${lastCp.description}").`,
          checkpoint: lastCp,
        };
      } catch (err: any) {
        // Nếu restore commitHash thất bại, thử git checkout / restore thông thường
        try {
          await execAsync('git restore .', { cwd: this.workspaceDir });
          return {
            success: true,
            message: `Đã hoàn tác các thay đổi chưa commit về trạng thái sạch gần nhất.`,
            checkpoint: lastCp,
          };
        } catch (subErr: any) {
          return {
            success: false,
            message: `Lỗi khi hoàn tác git: ${subErr.message}`,
          };
        }
      }
    }

    return {
      success: true,
      message: `Đã loại bỏ Checkpoint #${lastCp.index} (${lastCp.description}).`,
      checkpoint: lastCp,
    };
  }

  getHistory(): Checkpoint[] {
    return [...this.checkpoints];
  }

  getLastCheckpoint(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }
}
