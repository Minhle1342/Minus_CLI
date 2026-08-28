import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  IExecutionSubstrate,
  SubstrateCommandOptions,
  SubstrateExecutionResult,
  SubstrateTelemetry,
  SubstrateType,
} from './types.js';

export interface LocalExecutionSubstrateConfig {
  defaultCwd?: string;
  defaultTimeoutMs?: number;
  maxBufferBytes?: number;
  defaultEnv?: Record<string, string>;
}

/**
 * LocalExecutionSubstrate - Tầng Thực thi Bản địa (Local Host Execution Substrate)
 * 
 * Quản lý vòng đời tiến trình, stream buffering, signal handling, process tree termination
 * theo tiêu chuẩn Codex CLI và SWE-agent.
 */
export class LocalExecutionSubstrate implements IExecutionSubstrate {
  readonly name = 'local-substrate';
  readonly type: SubstrateType = 'local';

  private defaultCwd: string;
  private defaultTimeoutMs: number;
  private maxBufferBytes: number;
  private defaultEnv: Record<string, string>;
  private activeProcesses = new Set<ChildProcess>();

  private telemetry: SubstrateTelemetry = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    timedOutExecutions: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    activeProcesses: 0,
  };

  constructor(config: LocalExecutionSubstrateConfig = {}) {
    this.defaultCwd = config.defaultCwd || process.cwd();
    this.defaultTimeoutMs = config.defaultTimeoutMs || 60000;
    this.maxBufferBytes = config.maxBufferBytes || 10 * 1024 * 1024; // 10MB default buffer
    this.defaultEnv = config.defaultEnv || {};
  }

  async init(): Promise<void> {
    // No-op for local substrate
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Thực thi lệnh shell với quản lý tiến trình an toàn, timeout và signal handling
   */
  async exec(command: string, options: SubstrateCommandOptions = {}): Promise<SubstrateExecutionResult> {
    const startTime = Date.now();
    const cwd = options.cwd ? path.resolve(this.defaultCwd, options.cwd) : this.defaultCwd;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBuffer = options.maxBufferBytes ?? this.maxBufferBytes;
    const signal = options.signal;

    this.telemetry.totalExecutions++;
    this.telemetry.activeProcesses = this.activeProcesses.size + 1;

    if (signal?.aborted) {
      return this.createAbortedResult(startTime);
    }

    const isWindows = os.platform() === 'win32';
    const shellExecutable = isWindows
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || '/bin/bash');
    const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

    const mergedEnv = options.isolatedEnv
      ? { ...options.env }
      : { ...process.env, ...this.defaultEnv, ...options.env };

    return new Promise<SubstrateExecutionResult>((resolve) => {
      let stdoutAcc = '';
      let stderrAcc = '';
      let isSettled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      let child: ChildProcess;
      try {
        child = spawn(shellExecutable, shellArgs, {
          cwd,
          env: mergedEnv,
          windowsHide: true,
          detached: !isWindows, // Cho phép kill process tree trên POSIX
        });
      } catch (err: any) {
        this.recordFailure(Date.now() - startTime);
        return resolve({
          stdout: '',
          stderr: `Failed to spawn substrate process: ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
          substrateType: this.type,
          success: false,
          diagnostic: err.message,
        });
      }

      this.activeProcesses.add(child);

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(child);
        this.telemetry.activeProcesses = this.activeProcesses.size;
      };

      const killProcessTree = () => {
        if (!child.pid) return;
        try {
          if (isWindows) {
            spawn('taskkill', ['/F', '/T', '/PID', child.pid.toString()], { windowsHide: true });
          } else {
            // Kill entire process group on POSIX
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (isSettled) return;
          timedOut = true;
          this.telemetry.timedOutExecutions++;
          killProcessTree();
        }, timeoutMs);
      }

      if (signal) {
        const onAbort = () => {
          if (isSettled) return;
          killProcessTree();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutAcc.length < maxBuffer) {
          stdoutAcc += chunk.toString('utf-8');
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrAcc.length < maxBuffer) {
          stderrAcc += chunk.toString('utf-8');
        }
      });

      child.on('error', (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        const durationMs = Date.now() - startTime;
        this.recordFailure(durationMs);
        resolve({
          stdout: stdoutAcc,
          stderr: stderrAcc ? `${stderrAcc}\n${err.message}` : err.message,
          exitCode: 1,
          durationMs,
          substrateType: this.type,
          success: false,
          diagnostic: `Substrate process execution error: ${err.message}`,
        });
      });

      child.on('close', (code: number | null, signalCode: string | null) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();

        const durationMs = Date.now() - startTime;
        const exitCode = code ?? (signalCode ? 128 : 0);
        const success = exitCode === 0 && !timedOut && !signal?.aborted;

        if (success) {
          this.recordSuccess(durationMs);
        } else {
          this.recordFailure(durationMs);
        }

        resolve({
          stdout: stdoutAcc,
          stderr: timedOut
            ? `${stderrAcc}\n[Execution Substrate]: Command timed out after ${timeoutMs}ms.`
            : stderrAcc,
          exitCode: timedOut ? 124 : exitCode,
          durationMs,
          substrateType: this.type,
          success,
          timedOut,
          aborted: signal?.aborted,
          pid: child.pid,
        });
      });
    });
  }

  private createAbortedResult(startTime: number): SubstrateExecutionResult {
    const durationMs = Date.now() - startTime;
    this.recordFailure(durationMs);
    return {
      stdout: '',
      stderr: 'Substrate execution aborted by client signal before execution.',
      exitCode: 130,
      durationMs,
      substrateType: this.type,
      success: false,
      aborted: true,
    };
  }

  private recordSuccess(durationMs: number): void {
    this.telemetry.successfulExecutions++;
    this.telemetry.totalDurationMs += durationMs;
    this.telemetry.avgDurationMs = Math.round(
      this.telemetry.totalDurationMs / this.telemetry.totalExecutions
    );
  }

  private recordFailure(durationMs: number): void {
    this.telemetry.failedExecutions++;
    this.telemetry.totalDurationMs += durationMs;
    this.telemetry.avgDurationMs = Math.round(
      this.telemetry.totalDurationMs / this.telemetry.totalExecutions
    );
  }

  getTelemetry(): SubstrateTelemetry {
    return { ...this.telemetry };
  }

  async dispose(): Promise<void> {
    const isWindows = os.platform() === 'win32';
    for (const child of this.activeProcesses) {
      if (child.pid) {
        try {
          if (isWindows) {
            spawn('taskkill', ['/F', '/T', '/PID', child.pid.toString()], { windowsHide: true });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }
    }
    this.activeProcesses.clear();
    this.telemetry.activeProcesses = 0;
  }
}
