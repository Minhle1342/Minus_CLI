import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { ScheduleManager, TimerCondition } from '../tasks/schedule-manager.js';

/**
 * Tool: schedule
 * Chuẩn Google Antigravity CLI: Đặt timer một lần hoặc lịch cron định kỳ với Reactive Wakeup.
 */
export function createScheduleTool(scheduleManager: ScheduleManager): ToolDefinition {
  return {
    name: 'schedule',
    description: `Schedule a one-shot timer or a recurring cron job that sends notifications in the background.

Modes:
1. One-shot timer: Set DurationSeconds + Prompt. Use TimerCondition ('never' | 'any' | '<sender-id>') for early termination.
2. Recurring cron: Set CronExpression (e.g. '*/5 * * * *') + Prompt + MaxIterations.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        DurationSeconds: {
          type: Type.INTEGER,
          description: 'The number of seconds to wait for a one-shot timer. Mutually exclusive with CronExpression.',
        },
        CronExpression: {
          type: Type.STRING,
          description: "A cron expression (e.g. '*/5 * * * *' for every 5 minutes). Mutually exclusive with DurationSeconds.",
        },
        Prompt: {
          type: Type.STRING,
          description: 'The message content to include in the high-priority notification when the timer fires or cron triggers.',
        },
        TimerCondition: {
          type: Type.STRING,
          description: "Controls when a one-shot timer should early terminate upon receiving a message: 'never' (default), 'any', or a specific sender/task ID.",
        },
        MaxIterations: {
          type: Type.INTEGER,
          description: 'Optional maximum number of times the cron schedule will fire before stopping.',
        },
      },
      required: ['Prompt'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const prompt = String(args.Prompt || args.prompt || '').trim();
      const durationSeconds = typeof args.DurationSeconds === 'number'
        ? args.DurationSeconds
        : (typeof args.duration_seconds === 'number' ? args.duration_seconds : undefined);
      const cronExpression = args.CronExpression || args.cron_expression
        ? String(args.CronExpression || args.cron_expression).trim()
        : undefined;
      const timerCondition = (args.TimerCondition || args.timer_condition || 'never') as TimerCondition;
      const maxIterations = typeof args.MaxIterations === 'number'
        ? args.MaxIterations
        : (typeof args.max_iterations === 'number' ? args.max_iterations : undefined);

      if (!prompt) {
        return { error: "Tham số 'Prompt' là bắt buộc đối với tool schedule." };
      }

      if (durationSeconds === undefined && !cronExpression) {
        return { error: "Phải cung cấp chính xác một trong hai tham số: 'DurationSeconds' hoặc 'CronExpression'." };
      }

      if (durationSeconds !== undefined && cronExpression) {
        return { error: "'DurationSeconds' và 'CronExpression' là hai chế độ loại trừ lẫn nhau (mutually exclusive)." };
      }

      if (durationSeconds !== undefined) {
        if (durationSeconds <= 0) {
          return { error: "'DurationSeconds' phải là số dương lớn hơn 0." };
        }

        const scheduled = scheduleManager.scheduleOneShot({
          durationSeconds,
          prompt,
          timerCondition,
        });

        return {
          success: true,
          mode: 'one_shot',
          scheduleId: scheduled.id,
          durationSeconds,
          timerCondition,
          prompt,
          message: `Đã thiết lập timer ${durationSeconds}s thành công. Task ID: ${scheduled.id}. Bạn có thể dừng gọi tool để chuyển giao diện sang chế độ chờ reactive.`,
        };
      }

      if (cronExpression) {
        const scheduled = scheduleManager.scheduleCron({
          cronExpression,
          prompt,
          maxIterations,
        });

        return {
          success: true,
          mode: 'cron',
          scheduleId: scheduled.id,
          cronExpression,
          maxIterations,
          prompt,
          message: `Đã thiết lập cron '${cronExpression}' thành công. Task ID: ${scheduled.id}.`,
        };
      }

      return { error: 'Tham số không hợp lệ.' };
    },
  };
}
