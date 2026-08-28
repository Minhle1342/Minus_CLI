import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { IExecutionSubstrate } from '../execution/types.js';
import { LocalExecutionSubstrate } from '../execution/local-substrate.js';

export interface ScratchWorkspaceConfig {
  sourceWorkspaceRoot: string;
  id?: string;
  substrate?: IExecutionSubstrate;
}

export interface ScratchDiffResult {
  hasChanges: boolean;
  modifiedFiles: string[];
  rawDiff?: string;
}

/**
 * EphemeralScratchWorkspace - Không gian Làm việc Thử nghiệm Phân lập Tạm thời (Codex Point-in-Time Sandbox)
 * 
 * Cho phép Agent thử nghiệm các bản vá lỗi (Hypothesis Speculative Patching),
 * chạy test harness phân lập hoàn toàn mà không làm xáo trộn Workspace thật.
 */
export class EphemeralScratchWorkspace {
  readonly id: string;
  readonly sourceWorkspaceRoot: string;
  readonly scratchPath: string;
  private substrate: IExecutionSubstrate;
  private isCreated = false;

  constructor(config: ScratchWorkspaceConfig) {
    this.sourceWorkspaceRoot = path.resolve(config.sourceWorkspaceRoot);
    this.id = config.id || `scratch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.scratchPath = path.join(os.tmpdir(), 'minus-scratch-workspaces', this.id);
    this.substrate = config.substrate || new LocalExecutionSubstrate({ defaultCwd: this.scratchPath });
  }

  /**
   * Khởi tạo thư mục scratch workspace trên hệ thống
   */
  async create(): Promise<void> {
    if (this.isCreated) return;
    await fs.mkdir(this.scratchPath, { recursive: true });
    this.isCreated = true;
  }

  /**
   * Đồng bộ các file quan trọng từ workspace nguồn sang scratch workspace
   */
  async syncFiles(relativePaths: string[]): Promise<void> {
    await this.create();
    for (const relPath of relativePaths) {
      const src = path.join(this.sourceWorkspaceRoot, relPath);
      const dest = path.join(this.scratchPath, relPath);
      try {
        const stat = await fs.stat(src);
        if (stat.isDirectory()) {
          await fs.mkdir(dest, { recursive: true });
          await this.copyDirRecursive(src, dest);
        } else {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(src, dest);
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          console.warn(`[ScratchWorkspace] Không thể sao chép file "${relPath}": ${err.message}`);
        }
      }
    }
  }

  private async copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      // Bỏ qua node_modules và .git lớn nếu không cần thiết
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true });
        await this.copyDirRecursive(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Ghi file vào không gian scratch
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    await this.create();
    const dest = path.join(this.scratchPath, relativePath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf-8');
  }

  /**
   * Đọc file từ không gian scratch
   */
  async readFile(relativePath: string): Promise<string> {
    const dest = path.join(this.scratchPath, relativePath);
    return await fs.readFile(dest, 'utf-8');
  }

  /**
   * Thực thi lệnh shell bên trong không gian scratch phân lập
   */
  async exec(command: string, timeoutMs: number = 30000) {
    await this.create();
    return this.substrate.exec(command, {
      cwd: this.scratchPath,
      timeoutMs,
    });
  }

  /**
   * So sánh diff giữa Scratch Workspace và Source Workspace
   */
  async getDiff(): Promise<ScratchDiffResult> {
    const diffRes = await this.substrate.exec('git diff --no-index', {
      cwd: this.scratchPath,
      timeoutMs: 5000,
    });
    return {
      hasChanges: diffRes.stdout.trim().length > 0,
      modifiedFiles: [],
      rawDiff: diffRes.stdout,
    };
  }

  /**
   * Xóa sạch không gian scratch sau khi hoàn tất kiểm thử
   */
  async dispose(): Promise<void> {
    try {
      await fs.rm(this.scratchPath, { recursive: true, force: true });
      this.isCreated = false;
    } catch {
      // Ignore cleanup error
    }
  }
}
