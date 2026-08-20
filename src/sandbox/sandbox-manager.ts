import { ISandboxProvider, SandboxExecutionResult, SandboxMode, SandboxOptions, SandboxStatus } from './types.js';
import { LocalProcessSandbox } from './local-sandbox.js';
import { DockerSandbox } from './docker-sandbox.js';

export interface SandboxManagerConfig {
  mode?: SandboxMode;
  workspacePath: string;
  dockerImage?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

/**
 * SandboxManager - Bộ quản lý và điều phối các lớp môi trường thực thi (Sandbox Orchestrator)
 */
export class SandboxManager {
  private activeProvider: ISandboxProvider;
  private mode: SandboxMode;
  private workspacePath: string;
  private dockerImage: string;
  private memoryLimitMb: number;
  private cpuLimit: number;

  constructor(config: SandboxManagerConfig) {
    this.mode = config.mode || (process.env.SANDBOX_MODE as SandboxMode) || 'auto';
    this.workspacePath = config.workspacePath;
    this.dockerImage = config.dockerImage || process.env.SANDBOX_DOCKER_IMAGE || 'node:20-alpine';
    this.memoryLimitMb = config.memoryLimitMb || 1024;
    this.cpuLimit = config.cpuLimit || 2.0;

    // Khởi tạo mặc định với Local Sandbox trước
    this.activeProvider = new LocalProcessSandbox(this.workspacePath);
  }

  /**
   * Khởi tạo Sandbox phù hợp dựa trên chế độ cấu hình và môi trường máy chủ
   */
  async init(): Promise<void> {
    if (this.mode === 'docker' || this.mode === 'auto') {
      const dockerProvider = new DockerSandbox({
        workspacePath: this.workspacePath,
        image: this.dockerImage,
        memoryLimitMb: this.memoryLimitMb,
        cpuLimit: this.cpuLimit,
      });

      const dockerAvailable = await dockerProvider.isAvailable();

      if (dockerAvailable) {
        try {
          await dockerProvider.init();
          this.activeProvider = dockerProvider;
          return;
        } catch {
          // Khởi tạo Docker lỗi, fallback nếu ở chế độ auto
          if (this.mode === 'docker') {
            throw new Error('Chế độ SANDBOX_MODE=docker được chỉ định nhưng không thể khởi động Docker container.');
          }
        }
      } else if (this.mode === 'docker') {
        throw new Error('Chế độ SANDBOX_MODE=docker được chỉ định nhưng Docker Daemon không hoạt động.');
      }
    }

    // Fallback sang Local Process Sandbox
    this.activeProvider = new LocalProcessSandbox(this.workspacePath);
    await this.activeProvider.init();
  }

  /**
   * Chạy lệnh shell thông qua Sandbox Provider hiện tại
   */
  async exec(command: string, options?: SandboxOptions): Promise<SandboxExecutionResult> {
    return this.activeProvider.exec(command, options);
  }

  /**
   * Lấy trạng thái Sandbox hiện tại
   */
  getStatus(): SandboxStatus {
    return this.activeProvider.getStatus();
  }

  getProviderName(): string {
    return this.activeProvider.name;
  }

  /**
   * Cập nhật thư mục workspace
   */
  async updateWorkspace(newWorkspacePath: string): Promise<void> {
    await this.dispose();
    this.workspacePath = newWorkspacePath;
    await this.init();
  }

  /**
   * Dọn dẹp tài nguyên
   */
  async dispose(): Promise<void> {
    if (this.activeProvider) {
      await this.activeProvider.dispose();
    }
  }
}
