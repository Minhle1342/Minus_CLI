import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';

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
      detached: false,
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
      task.status = code === 0 ? 'stopped' : 'failed';
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

    try {
      task.process.kill('SIGTERM');
      task.status = 'stopped';
      return true;
    } catch {
      try {
        task.process.kill('SIGKILL');
        task.status = 'stopped';
        return true;
      } catch {
        return false;
      }
    }
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
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.process) {
        try {
          task.process.kill('SIGTERM');
        } catch {
          // Bỏ qua lỗi
        }
      }
    }
    this.tasks.clear();
  }
}
