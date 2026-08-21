import { ISandboxProvider, SandboxExecutionResult, SandboxMode, SandboxOptions, SandboxStatus } from './types.js';
import { LocalProcessSandbox } from './local-sandbox.js';
import { DockerSandbox } from './docker-sandbox.js';
import {
  createCustomRuntimeProfile,
  detectWorkspaceRuntimeProfile,
  getRuntimeProfile,
  inferCommandRuntime,
  SandboxRuntimeProfile,
} from './runtime-profiles.js';

export interface SandboxManagerConfig {
  mode?: SandboxMode;
  workspacePath: string;
  dockerImage?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
  autoSwitchRuntimes?: boolean;
}

/**
 * SandboxManager - Bộ quản lý và điều phối các lớp môi trường thực thi (Sandbox Orchestrator)
 */
export class SandboxManager {
  private activeProvider: ISandboxProvider;
  private mode: SandboxMode;
  private workspacePath: string;
  private explicitDockerImage?: string;
  private memoryLimitMb: number;
  private cpuLimit: number;
  private autoSwitchRuntimes: boolean;
  private activeRuntimeProfile?: SandboxRuntimeProfile;
  private readonly dockerProviders = new Map<string, DockerSandbox>();

  constructor(config: SandboxManagerConfig) {
    this.mode = config.mode || (process.env.SANDBOX_MODE as SandboxMode) || 'auto';
    this.workspacePath = config.workspacePath;
    this.explicitDockerImage = config.dockerImage || process.env.SANDBOX_DOCKER_IMAGE || undefined;
    this.memoryLimitMb = config.memoryLimitMb || 1024;
    this.cpuLimit = config.cpuLimit || 2.0;
    this.autoSwitchRuntimes = config.autoSwitchRuntimes
      ?? !['0', 'false', 'off', 'no'].includes(String(process.env.SANDBOX_RUNTIME_AUTO_SWITCH || '').toLowerCase());

    // Khởi tạo mặc định với Local Sandbox trước
    this.activeProvider = new LocalProcessSandbox(this.workspacePath);
  }

  /**
   * Khởi tạo Sandbox phù hợp dựa trên chế độ cấu hình và môi trường máy chủ
   */
  async init(): Promise<void> {
    if (this.mode === 'docker' || this.mode === 'auto') {
      const profile = this.explicitDockerImage
        ? createCustomRuntimeProfile(this.explicitDockerImage)
        : detectWorkspaceRuntimeProfile(this.workspacePath);
      const dockerProvider = this.createDockerProvider(profile);

      let dockerAvailable = await dockerProvider.isAvailable();

      // Nếu Docker chưa chạy, tự động kích hoạt Docker Desktop
      if (!dockerAvailable) {
        dockerAvailable = await dockerProvider.startDockerDaemon(25);
      }

      if (dockerAvailable) {
        try {
          await dockerProvider.init();
          this.activeProvider = dockerProvider;
          this.activeRuntimeProfile = profile;
          this.dockerProviders.set(this.profileKey(profile), dockerProvider);
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
    if (this.activeProvider.type === 'docker' && !this.explicitDockerImage && this.autoSwitchRuntimes) {
      const inference = inferCommandRuntime(command);
      if (inference.mixed) {
        return {
          stdout: '',
          stderr: `The command requires multiple runtime profiles (${inference.runtimes.join(', ')}) in one shell invocation.`,
          exitCode: 126,
          durationMs: 0,
          sandboxType: 'docker',
          success: false,
          errorCode: 'MULTIPLE_RUNTIMES_REQUIRED',
          diagnostic: 'One isolated command cannot switch Docker images midway through a compound shell expression.',
          suggestion: 'Split the operation into separate run_command calls, one runtime per call.',
          runtime: this.activeRuntimeProfile?.runtime,
          image: this.activeRuntimeProfile?.image,
        };
      }

      if (inference.runtime && inference.runtime !== 'generic' && inference.runtime !== this.activeRuntimeProfile?.runtime) {
        const profile = getRuntimeProfile(inference.runtime, this.workspacePath, inference.executable);
        try {
          this.activeProvider = await this.getOrCreateDockerProvider(profile);
          this.activeRuntimeProfile = profile;
        } catch (error: any) {
          return {
            stdout: '',
            stderr: error?.message || String(error),
            exitCode: 125,
            durationMs: 0,
            sandboxType: 'docker',
            success: false,
            errorCode: 'RUNTIME_SANDBOX_INIT_FAILED',
            diagnostic: `Could not initialize the ${profile.runtime} sandbox runtime.`,
            suggestion: `Verify Docker connectivity and image ${profile.image}, then retry after correcting the environment.`,
            runtime: profile.runtime,
            image: profile.image,
          };
        }
      }
    }

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
    this.activeRuntimeProfile = undefined;
    await this.init();
  }

  /**
   * Dọn dẹp tài nguyên
   */
  async dispose(): Promise<void> {
    const providers = [...new Set(this.dockerProviders.values())];
    for (const provider of providers) {
      await provider.dispose();
    }
    this.dockerProviders.clear();
    if (this.activeProvider.type !== 'docker') await this.activeProvider.dispose();
    this.activeRuntimeProfile = undefined;
  }

  private createDockerProvider(profile: SandboxRuntimeProfile): DockerSandbox {
    return new DockerSandbox({
      workspacePath: this.workspacePath,
      image: profile.image,
      runtime: profile.runtime,
      detectedFrom: profile.detectedFrom,
      memoryLimitMb: this.memoryLimitMb,
      cpuLimit: this.cpuLimit,
    });
  }

  private async getOrCreateDockerProvider(profile: SandboxRuntimeProfile): Promise<DockerSandbox> {
    const key = this.profileKey(profile);
    const existing = this.dockerProviders.get(key);
    if (existing) return existing;

    const provider = this.createDockerProvider(profile);
    await provider.init();
    this.dockerProviders.set(key, provider);
    return provider;
  }

  private profileKey(profile: SandboxRuntimeProfile): string {
    return `${profile.runtime}:${profile.image}`;
  }
}
