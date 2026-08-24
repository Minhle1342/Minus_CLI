import { spawn, ChildProcess, execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  status: 'running' | 'stopped' | 'failed';
  startedAt: string;
  exitCode?: number | null;
  logs: string[];
  process?: ChildProcess;
  stopRequested?: boolean;
}

/**
 * TaskManager - Quản lý các tiến trình bất đồng bộ chạy nền (Asynchronous Subprocesses)
 * 
 * Tính năng:
 * 1. Cho phép khởi chạy các server nền (npm run dev, test servers, database watchers).
 * 2. Lưu trữ circular log buffer (1000 dòng gần nhất) cho mỗi tiến trình.
 * 3. Cho phép Agent hoặc người dùng xem logs thời gian thực mà không chặn Agent Loop.
 * 4. Tự động dọn dẹp (kill) toàn bộ tiến trình con khi Agent thoát.
 */
export class TaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private defaultCwd: string;
  private taskCounter = 0;

  constructor(defaultCwd: string = process.cwd()) {
    this.defaultCwd = path.resolve(defaultCwd);
  }

  /**
   * Khởi chạy một tiến trình nền mới
   */
  startTask(command: string, cwd?: string): BackgroundTask {
    this.taskCounter++;
    const id = `task_${this.taskCounter}`;
    const effectiveCwd = cwd ? path.resolve(cwd) : this.defaultCwd;
    const startedAt = new Date().toLocaleTimeString('vi-VN');

    const task: BackgroundTask = {
      id,
      command,
      cwd: effectiveCwd,
      status: 'running',
      startedAt,
      logs: [],
    };

    // Khởi chạy child process với shell
    const child = spawn(command, [], {
      cwd: effectiveCwd,
      shell: true,
      // POSIX process groups make whole-tree termination possible. Windows
      // uses taskkill /T against the exact shell PID instead.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    task.pid = child.pid;
    task.process = child;

    const appendLog = (data: Buffer | string) => {
      const text = data.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          task.logs.push(`[${new Date().toLocaleTimeString('vi-VN')}] ${line}`);
          if (task.logs.length > 1000) {
            task.logs.shift();
          }
        }
      }
    };

    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    child.on('exit', (code) => {
      task.status = task.stopRequested || code === 0 ? 'stopped' : 'failed';
      task.exitCode = code;
      task.logs.push(`[SYSTEM] Tiến trình kết thúc với mã thoát: ${code}`);
    });

    child.on('error', (err) => {
      task.status = 'failed';
      task.logs.push(`[SYSTEM ERROR] ${err.message}`);
    });

    this.tasks.set(id, task);
    return task;
  }

  /**
   * Gửi dữ liệu (chuỗi văn bản/lệnh) vào stdin của một background task đang chạy
   */
  sendInput(taskId: string, input: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !task.process || task.status !== 'running') {
      return false;
    }
    if (!task.process.stdin || task.process.stdin.destroyed) {
      return false;
    }
    try {
      const sanitized = input.endsWith('\n') ? input : input + '\n';
      task.process.stdin.write(sanitized);
      task.logs.push(`[STDIN INPUT] ${input}`);
      return true;
    } catch (err: any) {
      task.logs.push(`[STDIN ERROR] ${err.message}`);
      return false;
    }
  }

  /**
   * Lấy thông tin chi tiết một task
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Lấy logs mới nhất của một background task
   */
  getTaskLogs(taskId: string, linesCount: number = 30): string {
    const task = this.tasks.get(taskId);
    if (!task) {
      return `Không tìm thấy background task với ID: ${taskId}`;
    }
    const count = Math.max(1, linesCount);
    return task.logs.slice(-count).join('\n') || '(Chưa có log output)';
  }

  /**
   * Dừng một background task
   */
  async stopTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || !task.process || task.status !== 'running') {
      return false;
    }

    task.stopRequested = true;
    const stopped = await this.terminateProcessTree(task);
    task.status = stopped ? 'stopped' : 'failed';
    if (!stopped) task.logs.push('[SYSTEM ERROR] Process tree did not terminate after stop request.');
    return stopped;
  }

  /**
   * Liệt kê tất cả các background tasks
   */
  listTasks(): Array<Omit<BackgroundTask, 'process'>> {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      command: t.command,
      cwd: t.cwd,
      pid: t.pid,
      status: t.status,
      startedAt: t.startedAt,
      exitCode: t.exitCode,
      logs: t.logs,
    }));
  }

  /**
   * Dọn dẹp toàn bộ tiến trình khi thoát
   */
  async dispose(): Promise<void> {
    const failedTaskIds: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.process) {
        const stopped = await this.stopTask(task.id);
        if (!stopped) failedTaskIds.push(task.id);
      }
    }
    if (failedTaskIds.length > 0) {
      throw new Error(`Failed to terminate background process tree(s): ${failedTaskIds.join(', ')}.`);
    }
    this.tasks.clear();
  }

  private async terminateProcessTree(task: BackgroundTask): Promise<boolean> {
    const child = task.process;
    const pid = task.pid;
    if (!child || !pid) return false;

    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch (error: any) {
      // taskkill reports a failure when the process exited between observation
      // and termination. Treat that as success only after liveness verification.
      task.logs.push(`[SYSTEM] Stop command reported: ${error.message}`);
    }

    if (await this.waitUntilExited(child, pid, 3000)) return true;
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {}
    return this.waitUntilExited(child, pid, 2000);
  }

  private async waitUntilExited(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || !this.isProcessAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return child.exitCode !== null || !this.isProcessAlive(pid);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
