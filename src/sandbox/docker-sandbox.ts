import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { ISandboxProvider, SandboxExecutionResult, SandboxOptions, SandboxStatus } from './types.js';

const execAsync = promisify(exec);

export interface DockerSandboxConfig {
  image?: string;
  workspacePath: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
  containerNamePrefix?: string;
}

/**
 * DockerSandbox - Môi trường thực thi cô lập bên trong Docker Container (Production Grade)
 * 
 * Tính năng bảo mật:
 * 1. Toàn bộ lệnh shell được thực thi bên trong container cô lập hoàn toàn với Host OS.
 * 2. Mount thư mục Workspace vào `/workspace` với quyền kiểm soát.
 * 3. Giới hạn tài nguyên phần cứng (RAM 1024MB, CPU 2.0 Cores, Process Limit 200).
 * 4. Ngăn chặn leo thang đặc quyền với flag `--security-opt=no-new-privileges`.
 */
export class DockerSandbox implements ISandboxProvider {
  readonly name = 'Docker Container Sandbox';
  readonly type = 'docker' as const;
  private image: string;
  private workspacePath: string;
  private memoryLimitMb: number;
  private cpuLimit: number;
  private containerId: string | null = null;
  private isDockerReady = false;

  constructor(config: DockerSandboxConfig) {
    this.image = config.image || 'node:20-alpine';
    this.workspacePath = path.resolve(config.workspacePath);
    this.memoryLimitMb = config.memoryLimitMb || 1024;
    this.cpuLimit = config.cpuLimit || 2.0;
  }

  /**
   * Kiểm tra xem Docker CLI và Docker Daemon có đang hoạt động trên hệ thống không
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('docker info', { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tự động khởi chạy Docker Desktop trên hệ điều hành và chờ Docker Daemon sẵn sàng
   */
  async startDockerDaemon(maxWaitSeconds: number = 30): Promise<boolean> {
    const platform = process.platform;
    let launched = false;

    try {
      if (platform === 'win32') {
        const standardPaths = [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Docker', 'Docker', 'Docker Desktop.exe'),
          'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
        ];

        const exePath = standardPaths.find((p) => fs.existsSync(p));
        if (exePath) {
          const child = spawn(exePath, [], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          launched = true;
        } else {
          // Thử mở qua lệnh start của Windows
          const child = spawn('cmd.exe', ['/c', 'start', '""', 'Docker Desktop'], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          launched = true;
        }
      } else if (platform === 'darwin') {
        // macOS
        const child = spawn('open', ['-a', 'Docker'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        launched = true;
      } else if (platform === 'linux') {
        // Linux
        try {
          await execAsync('sudo systemctl start docker || systemctl --user start docker', { timeout: 5000 });
          launched = true;
        } catch {}
      }
    } catch {
      launched = false;
    }

    if (!launched) {
      return false;
    }

    console.log(`\n\x1b[36m🚀 Đang tự động khởi chạy Docker Desktop...\x1b[0m`);
    process.stdout.write(`\x1b[33m⏳ Đang chờ Docker Daemon khởi động và sẵn sàng...\x1b[0m`);

    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        await execAsync('docker info', { timeout: 3000 });
        console.log(`\n\x1b[32m✔ Docker Daemon đã sẵn sàng!\x1b[0m\n`);
        return true;
      } catch {
        process.stdout.write('.');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n\x1b[33m⚠️  Docker Desktop chưa phản hồi sau ${maxWaitSeconds}s.\x1b[0m\n`);
    return false;
  }

  /**
   * Khởi tạo Container cô lập và mount Workspace
   */
  async init(): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      this.isDockerReady = false;
      throw new Error('Docker Daemon không khả dụng trên hệ thống.');
    }

    const containerName = `minus-sandbox-${Date.now()}`;
    const normalizedWsPath = this.workspacePath.replace(/\\/g, '/');

    // Chạy container ở chế độ background (detached)
    const runCommand = `docker run -d --name ${containerName} ` +
      `--memory=${this.memoryLimitMb}m ` +
      `--cpus=${this.cpuLimit} ` +
      `--pids-limit=200 ` +
      `--security-opt=no-new-privileges ` +
      `-v "${normalizedWsPath}:/workspace:rw" ` +
      `-w /workspace ` +
      `${this.image} tail -f /dev/null`;

    try {
      const { stdout } = await execAsync(runCommand, { timeout: 15000 });
      this.containerId = (stdout || '').trim().slice(0, 12);
      this.isDockerReady = true;

      // Cài đặt trước các công cụ thiết yếu (curl, git, bash, ca-certificates) nếu container chưa có
      try {
        await execAsync(
          `docker exec ${this.containerId} sh -c "which curl >/dev/null 2>&1 || (apk add --no-cache curl git bash ca-certificates 2>/dev/null || (apt-get update && apt-get install -y curl git bash ca-certificates) 2>/dev/null || true)"`,
          { timeout: 25000 }
        );
      } catch {
        // Không block tiến trình khởi động nếu container bị giới hạn mạng
      }
    } catch (err: any) {
      this.isDockerReady = false;
      throw new Error(`Không thể khởi tạo Docker Sandbox: ${err.message}`);
    }
  }

  /**
   * Thực thi lệnh bên trong Docker Container
   */
  async exec(command: string, options?: SandboxOptions): Promise<SandboxExecutionResult> {
    if (!this.containerId || !this.isDockerReady) {
      throw new Error('Docker Sandbox chưa được khởi tạo.');
    }

    const startTime = Date.now();
    const timeout = options?.timeoutMs ?? 30000;
    
    // Thoát các ký tự đặc biệt cho shell
    const escapedCmd = command.replace(/"/g, '\\"');
    const dockerExecCmd = `docker exec ${this.containerId} sh -c "${escapedCmd}"`;

    try {
      const { stdout, stderr } = await execAsync(dockerExecCmd, {
        timeout,
        maxBuffer: 1024 * 1024 * 5,
      });

      return {
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0,
        durationMs: Date.now() - startTime,
        sandboxType: 'docker',
      };
    } catch (err: any) {
      const stderr = (err.stderr || err.message || '').trim();
      const isMissingUtility =
        stderr.includes('curl: not found') ||
        stderr.includes('git: not found') ||
        stderr.includes('bash: not found') ||
        stderr.includes('wget: not found');

      // Tự động cài đặt gói bị thiếu và thực thi lại một lần (Self-healing Sandbox)
      if (isMissingUtility && this.containerId) {
        try {
          await execAsync(
            `docker exec ${this.containerId} sh -c "apk add --no-cache curl git bash ca-certificates 2>/dev/null || (apt-get update && apt-get install -y curl git bash ca-certificates) 2>/dev/null || true"`,
            { timeout: 25000 }
          );
          const retried = await execAsync(dockerExecCmd, {
            timeout,
            maxBuffer: 1024 * 1024 * 5,
          });
          return {
            stdout: (retried.stdout || '').trim(),
            stderr: (retried.stderr || '').trim(),
            exitCode: 0,
            durationMs: Date.now() - startTime,
            sandboxType: 'docker',
          };
        } catch (retryErr: any) {
          const exitCode = typeof retryErr.code === 'number' ? retryErr.code : 1;
          return {
            stdout: (retryErr.stdout || '').trim(),
            stderr: (retryErr.stderr || retryErr.message || '').trim(),
            exitCode,
            durationMs: Date.now() - startTime,
            sandboxType: 'docker',
          };
        }
      }

      const exitCode = typeof err.code === 'number' ? err.code : 1;
      return {
        stdout: (err.stdout || '').trim(),
        stderr,
        exitCode,
        durationMs: Date.now() - startTime,
        sandboxType: 'docker',
      };
    }
  }

  getStatus(): SandboxStatus {
    return {
      mode: 'docker',
      activeProvider: this.name,
      isIsolated: true,
      dockerAvailable: this.isDockerReady,
      containerId: this.containerId || undefined,
      image: this.image,
    };
  }

  /**
   * Dọn dẹp và tiêu huỷ Container khi kết thúc phiên làm việc
   */
  async dispose(): Promise<void> {
    if (this.containerId) {
      try {
        await execAsync(`docker rm -f ${this.containerId}`, { timeout: 5000 });
      } catch {
        // Bỏ qua lỗi cleanup
      } finally {
        this.containerId = null;
        this.isDockerReady = false;
      }
    }
  }
}
