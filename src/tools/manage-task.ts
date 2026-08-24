import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { TaskManager } from '../tasks/task-manager.js';

/**
 * Tool: manage_task
 * Chuẩn Google Antigravity CLI: Quản lý background tasks (list, status, kill, send_input)
 */
export function createManageTaskTool(taskManager: TaskManager): ToolDefinition {
  return {
    name: 'manage_task',
    description: `Manage background tasks. Use this tool to list running tasks or interact with tasks that were sent to the background.

Actions:
- 'list': List all currently running background tasks
- 'kill': Cancel the task's execution
- 'status': Check the task's current status and log tail
- 'send_input': Send input (stdin) to a running task (e.g. interactive prompts, REPL, confirm dialogs)`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        Action: {
          type: Type.STRING,
          description: "The action to perform: 'list' (list all running tasks), 'kill' (cancel the task), 'status' (check task status and log tail), 'send_input' (send input to a running task).",
        },
        TaskId: {
          type: Type.STRING,
          description: "The task ID to manage. Required when Action is 'kill', 'status', or 'send_input'.",
        },
        Input: {
          type: Type.STRING,
          description: "The input string to send to the task stdin. Required when Action is 'send_input'.",
        },
      },
      required: ['Action'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const action = String(args.Action || args.action || '').trim().toLowerCase();
      const taskId = args.TaskId || args.taskId ? String(args.TaskId || args.taskId).trim() : undefined;
      const input = args.Input || args.input !== undefined ? String(args.Input ?? args.input) : undefined;

      switch (action) {
        case 'list': {
          const tasks = taskManager.listTasks();
          return {
            action: 'list',
            count: tasks.length,
            tasks: tasks.map((t) => ({
              taskId: t.id,
              command: t.command,
              status: t.status,
              pid: t.pid,
              startedAt: t.startedAt,
              exitCode: t.exitCode,
              recentLogs: t.logs.slice(-5),
            })),
          };
        }

        case 'status': {
          if (!taskId) {
            return { error: "Tham số 'TaskId' là bắt buộc đối với action 'status'." };
          }
          const task = taskManager.getTask(taskId);
          if (!task) {
            return { error: `Không tìm thấy task với ID: ${taskId}` };
          }
          const logs = taskManager.getTaskLogs(taskId, 30);
          return {
            taskId: task.id,
            command: task.command,
            status: task.status,
            pid: task.pid,
            startedAt: task.startedAt,
            exitCode: task.exitCode,
            logTail: logs,
          };
        }

        case 'kill': {
          if (!taskId) {
            return { error: "Tham số 'TaskId' là bắt buộc đối với action 'kill'." };
          }
          const stopped = await taskManager.stopTask(taskId);
          return {
            taskId,
            action: 'kill',
            success: stopped,
            message: stopped
              ? `Đã dừng background task ${taskId} thành công.`
              : `Không thể dừng task ${taskId} (có thể task không tồn tại hoặc đã kết thúc).`,
          };
        }

        case 'send_input': {
          if (!taskId) {
            return { error: "Tham số 'TaskId' là bắt buộc đối với action 'send_input'." };
          }
          if (input === undefined) {
            return { error: "Tham số 'Input' là bắt buộc đối với action 'send_input'." };
          }
          const sent = taskManager.sendInput(taskId, input);
          return {
            taskId,
            action: 'send_input',
            success: sent,
            message: sent
              ? `Đã gửi input vào stdin của task ${taskId} thành công.`
              : `Gửi input thất bại (task ${taskId} có thể không hoạt động hoặc stdin đã đóng).`,
          };
        }

        default:
          return {
            error: `Action không hợp lệ: "${action}". Các action được hỗ trợ: 'list', 'status', 'kill', 'send_input'.`,
          };
      }
    },
  };
}
