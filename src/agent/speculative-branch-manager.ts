import path from 'node:path';
import fs from 'node:fs';
import { WorktreeManager } from '../workspace/worktree-manager.js';
import { Workspace } from '../workspace/workspace.js';

export interface SpeculativeSession {
  hypothesisId: string;
  branchName: string;
  worktreePath: string;
  workspace: Workspace;
  createdAt: string;
}

/**
 * SpeculativeBranchManager - Quản lý Phân nhánh Thử nghiệm trên Shadow Worktrees (Codex CLI Standard)
 * 
 * Cho phép:
 * 1. Tách biệt hoàn toàn các thử nghiệm sửa lỗi rủi ro cao vào một Git worktree ngầm.
 * 2. Thực hiện mutation và chạy test trên worktree này.
 * 3. Nếu hypothesis được Validate -> Merge an toàn vào Main Workspace.
 * 4. Nếu hypothesis bị Falsify -> Discard/Prune worktree ngay lập tức với 0% ô nhiễm mã nguồn chính.
 */
export class SpeculativeBranchManager {
  readonly mainWorkspaceRoot: string;
  readonly worktreeManager: WorktreeManager;
  private activeSpeculativeSessions = new Map<string, SpeculativeSession>();

  constructor(mainWorkspaceRoot: string) {
    this.mainWorkspaceRoot = path.resolve(mainWorkspaceRoot);
    this.worktreeManager = new WorktreeManager(this.mainWorkspaceRoot);
  }

  /**
   * Tạo một Speculative Branch & Worktree riêng biệt cho một Hypothesis
   */
  async createSpeculative(hypothesisId: string): Promise<SpeculativeSession> {
    const cleanId = hypothesisId.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const branchName = `speculative-repair-${cleanId}-${Date.now().toString(36)}`;
    const customName = `speculative-${cleanId}`;

    // Nếu đã có session cũ với id này, hủy trước
    if (this.activeSpeculativeSessions.has(hypothesisId)) {
      await this.abortSpeculative(hypothesisId).catch(() => {});
    }

    try {
      const { worktreePath } = await this.worktreeManager.create(branchName, customName);
      const specWorkspace = new Workspace(worktreePath);

      const session: SpeculativeSession = {
        hypothesisId,
        branchName,
        worktreePath,
        workspace: specWorkspace,
        createdAt: new Date().toISOString(),
      };

      this.activeSpeculativeSessions.set(hypothesisId, session);
      return session;
    } catch (err: any) {
      // Fallback nếu Git repo chưa sẵn sàng hoặc môi trường không hỗ trợ worktree
      const fallbackDir = path.join(this.mainWorkspaceRoot, '.codingagent', 'speculative', cleanId);
      fs.mkdirSync(fallbackDir, { recursive: true });
      const specWorkspace = new Workspace(fallbackDir);

      const session: SpeculativeSession = {
        hypothesisId,
        branchName: 'fallback-memory',
        worktreePath: fallbackDir,
        workspace: specWorkspace,
        createdAt: new Date().toISOString(),
      };

      this.activeSpeculativeSessions.set(hypothesisId, session);
      return session;
    }
  }

  /**
   * Lấy session đang chạy của một Hypothesis
   */
  getSpeculative(hypothesisId: string): SpeculativeSession | undefined {
    return this.activeSpeculativeSessions.get(hypothesisId);
  }

  /**
   * Hủy bỏ hoàn toàn nhánh thử nghiệm khi Hypothesis bị bác bỏ (Falsified)
   */
  async abortSpeculative(hypothesisId: string): Promise<boolean> {
    const session = this.activeSpeculativeSessions.get(hypothesisId);
    if (!session) return false;

    this.activeSpeculativeSessions.delete(hypothesisId);

    try {
      if (session.branchName !== 'fallback-memory') {
        await this.worktreeManager.remove(session.worktreePath, true);
      } else if (fs.existsSync(session.worktreePath)) {
        fs.rmSync(session.worktreePath, { recursive: true, force: true });
      }
      return true;
    } catch {
      // Fallback cleanup directory
      if (fs.existsSync(session.worktreePath)) {
        try {
          fs.rmSync(session.worktreePath, { recursive: true, force: true });
          return true;
        } catch {}
      }
      return false;
    }
  }

  /**
   * Dọn dẹp toàn bộ các nhánh speculative còn sót lại
   */
  async cleanupAll(): Promise<void> {
    const entries = Array.from(this.activeSpeculativeSessions.keys());
    for (const id of entries) {
      await this.abortSpeculative(id).catch(() => {});
    }
  }
}
