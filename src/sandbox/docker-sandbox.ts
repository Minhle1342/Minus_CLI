import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { ISandboxProvider, SandboxExecutionResult, SandboxOptions, SandboxStatus } from './types.js';
import os from 'node:os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const DOCKER_FAIL_CACHE_PATH = path.join(os.tmpdir(), 'mini-agent-docker-unavail.timestamp');
const DOCKER_FAIL_CACHE_TTL_MS = 30_000;

export function markDockerUnavailable(): void {
  try {
    fs.writeFileSync(DOCKER_FAIL_CACHE_PATH, String(Date.now()), 'utf-8');
  } catch {}
}

export function clearDockerUnavailable(): void {
  try {
    if (fs.existsSync(DOCKER_FAIL_CACHE_PATH)) {
      fs.unlinkSync(DOCKER_FAIL_CACHE_PATH);
    }
  } catch {}
}

export function isDockerRecentlyFailed(): boolean {
  try {
    if (!fs.existsSync(DOCKER_FAIL_CACHE_PATH)) return false;
    const content = fs.readFileSync(DOCKER_FAIL_CACHE_PATH, 'utf-8').trim();
    const timestamp = parseInt(content, 10);
    if (!timestamp || isNaN(timestamp)) return false;
    return Date.now() - timestamp < DOCKER_FAIL_CACHE_TTL_MS;
  } catch {
    return false;
  }
}

export interface DockerSandboxConfig {
  image?: string;
  runtime?: string;
  detectedFrom?: string;
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
  private runtime: string;
  private detectedFrom?: string;
  private workspacePath: string;
  private memoryLimitMb: number;
  private cpuLimit: number;
  private containerId: string | null = null;
  private isDockerReady = false;

  constructor(config: DockerSandboxConfig) {
    this.image = config.image || 'node:20-alpine';
    this.runtime = config.runtime || 'custom';
    this.detectedFrom = config.detectedFrom;
    this.workspacePath = path.resolve(config.workspacePath);
    this.memoryLimitMb = config.memoryLimitMb || 1024;
    this.cpuLimit = config.cpuLimit || 2.0;
  }

  /**
   * Kiểm tra xem Docker CLI và Docker Daemon có đang hoạt động trên hệ thống không
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 4000 });
      clearDockerUnavailable();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tự động khởi chạy Docker Desktop trên hệ điều hành và chờ Docker Daemon sẵn sàng
   */
  async startDockerDaemon(maxWaitSeconds: number = 20, force: boolean = false): Promise<boolean> {
    if (!force && isDockerRecentlyFailed()) {
      return false;
    }
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
            windowsHide: true,
          });
          child.unref();
          launched = true;
        } else {
          // Thử mở qua lệnh start của Windows
          const child = spawn('cmd.exe', ['/c', 'start', '""', 'Docker Desktop'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
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
      markDockerUnavailable();
      return false;
    }

    console.log(`\n\x1b[36m🚀 Đang tự động khởi chạy Docker Desktop...\x1b[0m`);
    process.stdout.write(`\x1b[33m⏳ Đang chờ Docker Daemon khởi động và sẵn sàng...\x1b[0m`);

    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        await execFileAsync('docker', ['info'], { timeout: 3000 });
        console.log(`\n\x1b[32m✔ Docker Daemon đã sẵn sàng!\x1b[0m\n`);
        clearDockerUnavailable();
        return true;
      } catch {
        process.stdout.write('.');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n\x1b[33m⚠️  Docker Desktop chưa phản hồi sau ${maxWaitSeconds}s.\x1b[0m\n`);
    markDockerUnavailable();
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
    const runArgs = [
      'run', '-d', '--name', containerName,
      `--memory=${this.memoryLimitMb}m`,
      `--cpus=${this.cpuLimit}`,
      '--pids-limit=200',
      '--security-opt=no-new-privileges',
      '-v', `${normalizedWsPath}:/workspace:rw`,
      '-w', '/workspace',
      this.image,
      'tail', '-f', '/dev/null',
    ];

    try {
      const { stdout } = await execFileAsync('docker', runArgs, { timeout: 300000, maxBuffer: 1024 * 1024 * 5 });
      this.containerId = (stdout || '').trim().slice(0, 12);
      this.isDockerReady = true;

      // Kiểm tra trước các công cụ thiết yếu (curl, git, bash, ripgrep)
      try {
        const { stdout: checkOut } = await execFileAsync(
          'docker',
          ['exec', this.containerId, 'sh', '-c', 'command -v curl >/dev/null 2>&1 && command -v git >/dev/null 2>&1 && command -v bash >/dev/null 2>&1 && (command -v rg >/dev/null 2>&1 || command -v ripgrep >/dev/null 2>&1) && echo "READY"'],
          { timeout: 3000 }
        );
        if (!checkOut || !checkOut.includes('READY')) {
          // Cài đặt bổ sung nếu container thiếu công cụ
          await execFileAsync(
            'docker',
            ['exec', this.containerId, 'sh', '-c', 'apk add --no-cache curl git bash ca-certificates ripgrep 2>/dev/null || (apt-get update && apt-get install -y curl git bash ca-certificates ripgrep) 2>/dev/null || true'],
            { timeout: 8000 }
          );
        }
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
    
    const dockerExecArgs = ['exec', this.containerId, 'sh', '-c', command];

    try {
      const { stdout, stderr } = await execFileAsync('docker', dockerExecArgs, {
        timeout,
        maxBuffer: 1024 * 1024 * 5,
      });

      return {
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0,
        durationMs: Date.now() - startTime,
        sandboxType: 'docker',
        success: true,
        runtime: this.runtime,
        image: this.image,
      };
    } catch (err: any) {
      const stderr = (err.stderr || err.message || '').trim();
      const timedOut = Boolean(err?.killed && err?.signal === 'SIGTERM');
      const isMissingUtility =
        stderr.includes('curl: not found') ||
        stderr.includes('git: not found') ||
        stderr.includes('bash: not found') ||
        stderr.includes('wget: not found') ||
        stderr.includes('rg: not found') ||
        stderr.includes('ripgrep: not found');

      // Tự động cài đặt gói bị thiếu và thực thi lại một lần (Self-healing Sandbox)
      if (isMissingUtility && this.containerId) {
        try {
          await execFileAsync(
            'docker',
            ['exec', this.containerId, 'sh', '-c', 'apk add --no-cache curl git bash ca-certificates ripgrep 2>/dev/null || (apt-get update && apt-get install -y curl git bash ca-certificates ripgrep) 2>/dev/null || true'],
            { timeout: 25000 }
          );
          const retried = await execFileAsync('docker', dockerExecArgs, {
            timeout,
            maxBuffer: 1024 * 1024 * 5,
          });
          return {
            stdout: (retried.stdout || '').trim(),
            stderr: (retried.stderr || '').trim(),
            exitCode: 0,
            durationMs: Date.now() - startTime,
            sandboxType: 'docker',
            success: true,
            runtime: this.runtime,
            image: this.image,
          };
        } catch (retryErr: any) {
          const exitCode = typeof retryErr.code === 'number' ? retryErr.code : 1;
          return {
            stdout: (retryErr.stdout || '').trim(),
            stderr: (retryErr.stderr || retryErr.message || '').trim(),
            exitCode,
            durationMs: Date.now() - startTime,
            sandboxType: 'docker',
            success: false,
            runtime: this.runtime,
            image: this.image,
            timedOut: Boolean(retryErr?.killed && retryErr?.signal === 'SIGTERM'),
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
        success: false,
        runtime: this.runtime,
        image: this.image,
        timedOut,
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
      runtime: this.runtime,
      detectedFrom: this.detectedFrom,
    };
  }

  /**
   * Dọn dẹp và tiêu huỷ Container khi kết thúc phiên làm việc
   */
  async dispose(): Promise<void> {
    if (this.containerId) {
      try {
        await execFileAsync('docker', ['rm', '-f', this.containerId], { timeout: 5000 });
      } catch {
        // Bỏ qua lỗi cleanup
      } finally {
        this.containerId = null;
        this.isDockerReady = false;
      }
    }
  }
}
