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
    description: 'Launch an async background shell command (background task) such as a dev server or test watcher without blocking the Agent Loop.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Terminal command to run in the background (e.g. "npm run dev", "node server.js")',
        },
      },
      required: ['command'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const command = String(args.command || '').trim();
      if (!command) {
        return { error: 'The "command" parameter is required.' };
      }

      const task = taskManager.startTask(command, workspace.rootDir);
      return {
        success: true,
        message: `Successfully started background task.`,
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
    description: 'Fetch the latest log lines from a running background task.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: {
          type: Type.STRING,
          description: 'ID of the background task (e.g. "task_1")',
        },
        lines: {
          type: Type.INTEGER,
          description: 'Number of recent log lines to fetch (default: 30 lines)',
        },
      },
      required: ['taskId'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const taskId = String(args.taskId || '').trim();
      if (!taskId) {
        return { error: 'The "taskId" parameter is required.' };
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
    description: 'Stop a running background task.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: {
          type: Type.STRING,
          description: 'ID of the background task to stop (e.g. "task_1")',
        },
      },
      required: ['taskId'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const taskId = String(args.taskId || '').trim();
      if (!taskId) {
        return { error: 'The "taskId" parameter is required.' };
      }

      const stopped = await taskManager.stopTask(taskId);
      return {
        taskId,
        success: stopped,
        message: stopped ? `Stopped task ${taskId} successfully.` : `Failed to stop task ${taskId} (task does not exist or already stopped).`,
      };
    },
  };
}
