import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ISandboxProvider, SandboxExecutionResult, SandboxOptions, SandboxStatus } from './types.js';
import { getNativeCore, nativeExecuteSandboxed } from '../native/index.js';
import { sanitizeTerminalOutput } from '../tools/terminal-sanitizer.js';
import { nativeTruncateToolOutput } from '../native/index.js';
import { MAX_STRING_LENGTH, checkStringLength } from './output-limits.js';

const execAsync = promisify(exec);

// shortcut: byte-based head/tail truncation via Rust (TS fallback inside); fixes UTF-16-vs-bytes mismatch.
function capOutput(text: string): { text: string; truncated: boolean } {
  const res = nativeTruncateToolOutput(text, 2000, MAX_STRING_LENGTH, true);
  return { text: res.text, truncated: res.wasTruncated };
}

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
    // shortcut: fail fast before spawning when the command itself exceeds the string cap (bytes, not UTF-16 units).
    try { checkStringLength(Buffer.byteLength(command, 'utf8')); } catch {
      return { stdout: '', stderr: `Command exceeds ${MAX_STRING_LENGTH} chars; refused before spawn.`, exitCode: 1, durationMs: 0, sandboxType: 'local', success: false, errorCode: 'COMMAND_TOO_LARGE' };
    }
    const requestedTimeout = options?.timeoutMs ?? 30000;
    // Convention: timeoutMs === 0 disables the timeout. Node exec treats 0 as
    // disabled, but the Rust core takes u32 milliseconds, so map disabled to
    // u32::MAX (~49.7 days — effectively unlimited) to keep tree-kill intact.
    const timeout = requestedTimeout === 0 ? 0 : requestedTimeout;
    const nativeTimeout = requestedTimeout === 0 ? 0xffffffff : requestedTimeout;
    const cwd = options?.cwd ?? this.defaultCwd;

    // Lọc và làm sạch biến môi trường (loại trừ các secret nhạy cảm nếu có)
    // Đồng thời ép buộc môi trường Non-Interactive (Claude Code & SWE-agent standard) để chống treo terminal
    const sanitizedEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || process.env.USERPROFILE || '',
      USER: process.env.USER || process.env.USERNAME || '',
      ...(process.platform === 'win32' ? {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
        WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
        ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
        TEMP: process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp',
        TMP: process.env.TMP || process.env.TEMP || 'C:\\Windows\\Temp',
      } : {}),
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

    const sandboxedRes = await nativeExecuteSandboxed(
      command,
      cwd,
      nativeTimeout,
      5 * 1024 * 1024,
      options?.memoryLimitMb ?? 2048,
      options?.signal,
      sanitizedEnv,
    );
    if (sandboxedRes) {
      const out = capOutput(sanitizeTerminalOutput(sandboxedRes.stdout));
      const err = capOutput(sanitizeTerminalOutput(sandboxedRes.stderr));
      return {
        stdout: out.text,
        stderr: err.text,
        exitCode: sandboxedRes.exitCode,
        durationMs: sandboxedRes.durationMs,
        sandboxType: 'local',
        success: sandboxedRes.exitCode === 0 && !sandboxedRes.cancelled,
        timedOut: sandboxedRes.timedOut,
        ...(sandboxedRes.outputIncomplete || out.truncated || err.truncated ? { outputIncomplete: true } : {}),
        ...(sandboxedRes.cancelled ? { errorCode: 'COMMAND_CANCELLED' } : {}),
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

      const okOut = capOutput(sanitizeTerminalOutput(stdout || ''));
      const okErr = capOutput(sanitizeTerminalOutput(stderr || ''));
      return {
        stdout: okOut.text,
        stderr: okErr.text,
        exitCode: 0,
        durationMs: Date.now() - startTime,
        sandboxType: 'local',
        success: true,
        ...((okOut.truncated || okErr.truncated) ? { outputIncomplete: true } : {}),
      };
    } catch (err: any) {
      const isCancelled = options?.signal?.aborted || err?.name === 'AbortError';
      const exitCode = isCancelled ? 130 : typeof err.code === 'number' ? err.code : 1;
      const out = capOutput(sanitizeTerminalOutput(err.stdout || ''));
      const errText = capOutput(sanitizeTerminalOutput(err.stderr || err.message || ''));
      return {
        stdout: out.text,
        stderr: isCancelled ? 'Command was cancelled by user.' : errText.text,
        exitCode,
        durationMs: Date.now() - startTime,
        sandboxType: 'local',
        success: false,
        timedOut: !isCancelled && Boolean(err?.killed && err?.signal === 'SIGTERM'),
        ...(isCancelled ? { errorCode: 'COMMAND_CANCELLED' } : {}),
        ...((out.truncated || errText.truncated) ? { outputIncomplete: true } : {}),
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
