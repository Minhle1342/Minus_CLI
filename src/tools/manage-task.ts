import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import type { ToolDefinition } from './types.js';
import type { TaskManager } from '../tasks/task-manager.js';

/**
 * manage_task — kiểm tra và điều khiển background task của run_command.
 * Contract `commandCompletion` phải khớp completion-evidence.ts (status action
 * được dùng làm bằng chứng hoàn thành lệnh).
 */
export function createManageTaskTool(taskManager: TaskManager): ToolDefinition {
  const norm = (v: any) => String(v ?? '').trim();
  const notFound = (action: string, taskId: string) => ({
    action,
    taskId,
    errorCode: 'TASK_NOT_FOUND',
    error: `No background task found with id "${taskId}". Call manage_task with Action="list" to see running tasks.`,
  });
  return {
    name: 'manage_task',
    description: 'List, inspect, feed stdin to, or stop background tasks started by run_command. Actions: list, status, logs, send_input, kill.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        Action: { type: Type.STRING, description: 'One of: list, status, logs, send_input, kill.' },
        TaskId: { type: Type.STRING, description: 'Background task id (e.g. task_1); required for every action except list.' },
        Input: { type: Type.STRING, description: 'Text to write to the task stdin (send_input), e.g. an answer to a prompt.' },
        Lines: { type: Type.INTEGER, description: 'Log tail length for status/logs (default 40).' },
      },
      required: ['Action'],
    } as FunctionDeclaration['parameters'],
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const action = norm(args.Action || args.action).toLowerCase();
      const taskId = norm(args.TaskId || args.taskId);
      const lines = Math.max(1, Number(args.Lines || args.lines) || 40);

      if (action === 'list') {
        const tasks = taskManager.listTasks().map((t) => ({ ...t, logs: undefined }));
        return { action: 'list', count: tasks.length, tasks };
      }
      if (action === 'status') {
        const task = taskManager.getTask(taskId);
        if (!task) return notFound(action, taskId);
        const running = task.status === 'running';
        const terminalStatus = task.stopRequested ? 'cancelled'
          : task.status === 'stopped' ? 'completed'
          : task.status === 'failed' ? 'failed'
          : 'running';
        const commandOutcome = task.stopRequested ? 'cancelled'
          : !running && task.status === 'stopped' && task.exitCode === 0 ? 'succeeded'
          : running ? undefined
          : 'failed_unexpected';
        const stall = taskManager.getStallInfo(taskId);
        return {
          action: 'status',
          taskId,
          status: task.status,
          commandCompletion: {
            taskId,
            command: task.command,
            completed: !running,
            terminalStatus,
            commandOutcome,
            ...(typeof task.exitCode === 'number' ? { exitCode: task.exitCode } : {}),
          },
          logTail: taskManager.getTaskLogs(taskId, lines),
          ...(stall?.stalled ? { stalled: true, stallSuggestion: stall.suggestion } : {}),
        };
      }
      if (action === 'logs') {
        if (!taskManager.getTask(taskId)) return notFound(action, taskId);
        return { action: 'logs', taskId, logTail: taskManager.getTaskLogs(taskId, lines) };
      }
      if (action === 'send_input') {
        const input = String(args.Input ?? args.input ?? '');
        const success = taskManager.sendInput(taskId, input);
        return {
          action: 'send_input',
          taskId,
          success,
          ...(success ? {} : { error: `Could not send input to task "${taskId}" — it may not exist or is not running.` }),
        };
      }
      if (action === 'kill') {
        const success = await taskManager.stopTask(taskId);
        return {
          action: 'kill',
          taskId,
          success,
          ...(success ? {} : { error: `Could not stop task "${taskId}" — it may not exist or already exited.` }),
        };
      }
      return {
        action,
        errorCode: 'UNKNOWN_ACTION',
        error: `Unknown Action "${action}". Use one of: list, status, logs, send_input, kill.`,
      };
    },
  };
}
