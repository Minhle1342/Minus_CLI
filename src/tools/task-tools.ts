import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { TaskManager } from '../tasks/task-manager.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * Tool: start_background_task
 * Khởi chạy một tiến trình chạy nền (như dev server, test server)
 */
export function createStartBackgroundTaskTool(taskManager: TaskManager): ToolDefinition {
  return {
    name: 'start_background_task',
    description: 'Khởi chạy một lệnh shell bất đồng bộ chạy nền (background task) như server dev, test watcher mà không chặn Agent Loop.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Lệnh terminal cần chạy nền (ví dụ: "npm run dev", "node server.js")',
        },
      },
      required: ['command'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const command = String(args.command || '').trim();
      if (!command) {
        return { error: 'Tham số "command" là bắt buộc.' };
      }

      const task = taskManager.startTask(command, workspace.rootDir);
      return {
        success: true,
        message: `Đã khởi chạy background task thành công.`,
        task: {
          id: task.id,
          command: task.command,
          pid: task.pid,
          status: task.status,
          startedAt: task.startedAt,
        },
      };
    },
  };
}

/**
 * Tool: get_task_output
 * Xem logs mới nhất từ một background task
 */
export function createGetTaskOutputTool(taskManager: TaskManager): ToolDefinition {
  return {
    name: 'get_task_output',
    description: 'Lấy các dòng log mới nhất từ một background task đang chạy nền.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: {
          type: Type.STRING,
          description: 'ID của background task (ví dụ: "task_1")',
        },
        lines: {
          type: Type.INTEGER,
          description: 'Số dòng log gần nhất cần lấy (mặc định: 30 dòng)',
        },
      },
      required: ['taskId'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const taskId = String(args.taskId || '').trim();
      if (!taskId) {
        return { error: 'Tham số "taskId" là bắt buộc.' };
      }

      const lines = typeof args.lines === 'number' ? args.lines : 30;
      const logs = taskManager.getTaskLogs(taskId, lines);

      return {
        taskId,
        logs,
      };
    },
  };
}

/**
 * Tool: stop_task
 * Dừng một background task
 */
export function createStopTaskTool(taskManager: TaskManager): ToolDefinition {
  return {
    name: 'stop_task',
    description: 'Dừng một background task đang chạy nền.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: {
          type: Type.STRING,
          description: 'ID của background task cần dừng (ví dụ: "task_1")',
        },
      },
      required: ['taskId'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const taskId = String(args.taskId || '').trim();
      if (!taskId) {
        return { error: 'Tham số "taskId" là bắt buộc.' };
      }

      const stopped = await taskManager.stopTask(taskId);
      return {
        taskId,
        success: stopped,
        message: stopped ? `Đã dừng task ${taskId} thành công.` : `Không thể dừng task ${taskId} (task không tồn tại hoặc đã dừng).`,
      };
    },
  };
}
