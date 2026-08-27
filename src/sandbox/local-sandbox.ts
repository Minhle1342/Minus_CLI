import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ISandboxProvider, SandboxExecutionResult, SandboxOptions, SandboxStatus } from './types.js';

const execAsync = promisify(exec);

/**
 * LocalProcessSandbox - Môi trường thực thi tiến trình cục bộ với cách ly biến môi trường
 */
export class LocalProcessSandbox implements ISandboxProvider {
  readonly name = 'Local Process Sandbox';
  readonly type = 'local' as const;
  private defaultCwd: string;

  constructor(defaultCwd: string = process.cwd()) {
    this.defaultCwd = defaultCwd;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async init(): Promise<void> {
    // Không cần khởi tạo container
  }

  async exec(command: string, options?: SandboxOptions): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const timeout = options?.timeoutMs ?? 30000;
    const cwd = options?.cwd ?? this.defaultCwd;

    // Lọc và làm sạch biến môi trường (loại trừ các secret nhạy cảm nếu có)
    const sanitizedEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || process.env.USERPROFILE || '',
      USER: process.env.USER || process.env.USERNAME || '',
      NODE_ENV: 'development',
      ...options?.env,
    };

    if (options?.signal?.aborted) {
      return {
        stdout: '',
        stderr: 'Command was cancelled by user before execution.',
        exitCode: 130,
        durationMs: 0,
        sandboxType: 'local',
        success: false,
        errorCode: 'COMMAND_CANCELLED',
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env: sanitizedEnv,
        timeout,
        signal: options?.signal,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
      });

      return {
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0,
        durationMs: Date.now() - startTime,
        sandboxType: 'local',
        success: true,
      };
    } catch (err: any) {
      const isCancelled = options?.signal?.aborted || err?.name === 'AbortError';
      const exitCode = isCancelled ? 130 : typeof err.code === 'number' ? err.code : 1;
      return {
        stdout: (err.stdout || '').trim(),
        stderr: isCancelled ? 'Command was cancelled by user.' : (err.stderr || err.message || '').trim(),
        exitCode,
        durationMs: Date.now() - startTime,
        sandboxType: 'local',
        success: false,
        timedOut: !isCancelled && Boolean(err?.killed && err?.signal === 'SIGTERM'),
        ...(isCancelled ? { errorCode: 'COMMAND_CANCELLED' } : {}),
      };
    }
  }

  getStatus(): SandboxStatus {
    return {
      mode: 'local',
      activeProvider: this.name,
      isIsolated: false,
      dockerAvailable: false,
    };
  }

  async dispose(): Promise<void> {
    // Cleanup nếu cần
  }
}
