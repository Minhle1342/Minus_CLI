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

      let dockerAvailable = await dockerProvider.isAvailable();

      // Nếu Docker chưa chạy, tự động kích hoạt Docker Desktop
      if (!dockerAvailable) {
        dockerAvailable = await dockerProvider.startDockerDaemon(25);
      }

      if (dockerAvailable) {
        try {
          await dockerProvider.init();
          this.activeProvider = dockerProvider;
          return;
        } catch (err: any) {
          // Khởi tạo Docker lỗi, fallback nếu ở chế độ auto hoặc docker
          console.warn(`\n\x1b[33m⚠️  [Docker Sandbox]: Không thể khởi động Docker container: ${err.message}\x1b[0m`);
          console.warn(`\x1b[90m👉 Đang tự động chuyển sang Local Process Sandbox (Host OS).\x1b[0m\n`);
        }
      } else if (this.mode === 'docker') {
        console.warn(`\n\x1b[33m⚠️  [Docker Sandbox]: Không thể tự động khởi chạy Docker Desktop hoặc Docker Daemon chưa sẵn sàng.\x1b[0m`);
        console.warn(`\x1b[90m👉 Đang tự động chuyển sang Local Process Sandbox (Host OS với bộ lọc Allowlist).\x1b[0m`);
        console.warn(`\x1b[90m💡 Để chạy lệnh không giới hạn (Zero-Restriction), vui lòng kiểm tra Docker Desktop trên máy tính.\x1b[0m\n`);
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
