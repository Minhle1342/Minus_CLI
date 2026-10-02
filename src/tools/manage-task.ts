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
            return { error: "The 'TaskId' parameter is required for action 'status'." };
          }
          const task = taskManager.getTask(taskId);
          if (!task) {
            return { error: `No task found with ID: ${taskId}` };
          }
          const logs = taskManager.getTaskLogs(taskId, 30);
          const isTerminal = task.status !== 'running';
          const terminalStatus = !isTerminal
            ? undefined
            : task.stopRequested
              ? 'cancelled'
              : task.exitCode === undefined || task.exitCode === null
                ? 'spawn_error'
                : task.exitCode === 0
                  ? 'completed'
                  : 'failed';
          const commandOutcome = terminalStatus === 'completed' ? 'succeeded'
            : isTerminal ? 'failed_unexpected' : undefined;
          return {
            action: 'status',
            taskId: task.id,
            command: task.command,
            status: task.status,
            pid: task.pid,
            startedAt: task.startedAt,
            exitCode: task.exitCode,
            logTail: logs,
            ...(commandOutcome ? { commandOutcome, processStarted: true, success: commandOutcome === 'succeeded' } : {}),
            ...(isTerminal ? {
              commandCompletion: {
                taskId: task.id,
                command: task.command,
                completed: true,
                terminalStatus,
                commandOutcome,
                ...(typeof task.exitCode === 'number' ? { exitCode: task.exitCode } : {}),
              },
            } : {}),
          };
        }

        case 'kill': {
          if (!taskId) {
            return { error: "The 'TaskId' parameter is required for action 'kill'." };
          }
          const stopped = await taskManager.stopTask(taskId);
          return {
            taskId,
            action: 'kill',
            success: stopped,
            message: stopped
              ? `Stopped background task ${taskId} successfully.`
              : `Failed to stop task ${taskId} (task may not exist or already finished).`,
          };
        }

        case 'send_input': {
          if (!taskId) {
            return { error: "The 'TaskId' parameter is required for action 'send_input'." };
          }
          if (input === undefined) {
            return { error: "The 'Input' parameter is required for action 'send_input'." };
          }
          const sent = taskManager.sendInput(taskId, input);
          return {
            taskId,
            action: 'send_input',
            success: sent,
            message: sent
              ? `Sent input to stdin of task ${taskId} successfully.`
              : `Failed to send input (task ${taskId} may be inactive or stdin is closed).`,
          };
        }

        default:
          return {
            error: `Invalid action: "${action}". Supported actions: 'list', 'status', 'kill', 'send_input'.`,
          };
      }
    },
  };
}
