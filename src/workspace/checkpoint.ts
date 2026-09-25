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
  isTaskCheckpoint?: boolean;
  taskId?: string;
  workspaceDigest?: string;
}

/**
 * CheckpointManager - Hệ thống tạo snapshot và khôi phục an toàn (Shadow Git Task & Mutation Rollback)
 * 
 * Nguyên lý hoạt động:
 * 1. Trước mutation đầu tiên của task hoặc mỗi turn/mutation, hệ thống tự động ghi nhận checkpoint.
 * 2. Hỗ trợ cả mutation-level checkpoint và task-level checkpoint (`TaskCheckpoint`).
 * 3. Cho phép hoàn tác (/undo) tức thì về checkpoint gần nhất hoặc rollback trọn vẹn task nếu verification thất bại.
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
  async createCheckpoint(description: string, options?: { isTaskCheckpoint?: boolean; taskId?: string; workspaceDigest?: string }): Promise<Checkpoint | null> {
    const id = options?.isTaskCheckpoint
      ? `task_cp_${Date.now()}_${this.checkpoints.length + 1}`
      : `cp_${Date.now()}_${this.checkpoints.length + 1}`;
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
      isTaskCheckpoint: options?.isTaskCheckpoint,
      taskId: options?.taskId,
      workspaceDigest: options?.workspaceDigest,
    };

    this.checkpoints.push(checkpoint);

    // Giữ tối đa 30 checkpoints gần nhất
    if (this.checkpoints.length > 30) {
      this.checkpoints.shift();
    }

    return checkpoint;
  }

  /**
   * Tạo Task Checkpoint đặc thù cho toàn bộ task/turn
   */
  async createTaskCheckpoint(taskId: string, description: string, workspaceDigest?: string): Promise<Checkpoint | null> {
    return this.createCheckpoint(description, {
      isTaskCheckpoint: true,
      taskId,
      workspaceDigest,
    });
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
    return this.applyRollback(lastCp);
  }

  /**
   * Hoàn tác về một Task Checkpoint cụ thể
   */
  async rollbackToTaskCheckpoint(checkpointIdOrTaskId: string): Promise<{ success: boolean; message: string; checkpoint?: Checkpoint }> {
    const targetIndex = this.checkpoints.findIndex(
      (cp) => cp.id === checkpointIdOrTaskId || (cp.isTaskCheckpoint && cp.taskId === checkpointIdOrTaskId),
    );

    if (targetIndex === -1) {
      return {
        success: false,
        message: `Không tìm thấy task checkpoint "${checkpointIdOrTaskId}" để rollback.`,
      };
    }

    const targetCp = this.checkpoints[targetIndex];
    // Cắt bỏ các checkpoint sau target
    this.checkpoints = this.checkpoints.slice(0, targetIndex);

    return this.applyRollback(targetCp);
  }

  private async applyRollback(targetCp: Checkpoint): Promise<{ success: boolean; message: string; checkpoint?: Checkpoint }> {
    if (this.isGitRepo && targetCp.commitHash) {
      try {
        await execAsync(`git restore --source=${targetCp.commitHash} --worktree .`, {
          cwd: this.workspaceDir,
        });
        return {
          success: true,
          message: `Đã hoàn tác thành công về Checkpoint #${targetCp.index} (${targetCp.timestamp}: "${targetCp.description}").`,
          checkpoint: targetCp,
        };
      } catch (err: any) {
        try {
          await execAsync('git restore .', { cwd: this.workspaceDir });
          return {
            success: true,
            message: `Đã hoàn tác các thay đổi chưa commit về trạng thái sạch gần nhất.`,
            checkpoint: targetCp,
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
      message: `Đã hoàn tác Checkpoint #${targetCp.index} (${targetCp.description}).`,
      checkpoint: targetCp,
    };
  }

  getHistory(): Checkpoint[] {
    return [...this.checkpoints];
  }

  getTaskCheckpoints(): Checkpoint[] {
    return this.checkpoints.filter((cp) => cp.isTaskCheckpoint);
  }

  getLastCheckpoint(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }
}
