import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ISandboxProvider, SandboxExecutionResult, SandboxOptions, SandboxStatus } from './types.js';
import { getNativeCore, nativeExecuteSandboxed } from '../native/index.js';
import { sanitizeTerminalOutput } from '../tools/terminal-sanitizer.js';

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
    // Đồng thời ép buộc môi trường Non-Interactive (Claude Code & SWE-agent standard) để chống treo terminal
    const sanitizedEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || process.env.USERPROFILE || '',
      USER: process.env.USER || process.env.USERNAME || '',
      NODE_ENV: 'development',
      CI: 'true',
      DEBIAN_FRONTEND: 'noninteractive',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      FORCE_COLOR: '0',
      npm_config_yes: 'true',
      PYTHONIOENCODING: 'utf-8',
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

    const sandboxedRes = nativeExecuteSandboxed(command, cwd, timeout, 5 * 1024 * 1024, 2048);
    if (sandboxedRes && !options?.signal) {
      return {
        stdout: sanitizeTerminalOutput(sandboxedRes.stdout),
        stderr: sanitizeTerminalOutput(sandboxedRes.stderr),
        exitCode: sandboxedRes.exitCode,
        durationMs: sandboxedRes.durationMs,
        sandboxType: 'local',
        success: sandboxedRes.exitCode === 0,
        timedOut: sandboxedRes.timedOut,
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
        stdout: sanitizeTerminalOutput(stdout || ''),
        stderr: sanitizeTerminalOutput(stderr || ''),
        exitCode: 0,
        durationMs: Date.now() - startTime,
        sandboxType: 'local',
        success: true,
      };
    } catch (err: any) {
      const isCancelled = options?.signal?.aborted || err?.name === 'AbortError';
      const exitCode = isCancelled ? 130 : typeof err.code === 'number' ? err.code : 1;
      return {
        stdout: sanitizeTerminalOutput(err.stdout || ''),
        stderr: isCancelled ? 'Command was cancelled by user.' : sanitizeTerminalOutput(err.stderr || err.message || ''),
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
    const native = getNativeCore();
    return {
      mode: 'local',
      activeProvider: this.name,
      isIsolated: Boolean(native),
      dockerAvailable: false,
    };
  }

  async dispose(): Promise<void> {
    // Cleanup nếu cần
  }
}
