import { AgentPlugin, KernelContext } from '../kernel.js';
import { createManageTaskTool } from '../../tools/manage-task.js';
import { createScheduleTool } from '../../tools/schedule-tool.js';
import { createStartBackgroundTaskTool, createGetTaskOutputTool, createStopTaskTool } from '../../tools/task-tools.js';

/**
 * TaskPlugin - Quản lý các tiến trình nền và lịch trình (Antigravity CLI Background & Schedule Plugin)
 */
export const TaskPlugin: AgentPlugin = {
  name: 'task-plugin',
  version: '2.0.0',
  description: 'Quản lý các tiến trình nền (manage_task với send_input stdin) và lịch trình hẹn giờ (schedule)',
  apply(ctx: KernelContext) {
    if (ctx.tasks) {
      ctx.registerTool(createManageTaskTool(ctx.tasks));
      ctx.registerTool(createStartBackgroundTaskTool(ctx.tasks));
      ctx.registerTool(createGetTaskOutputTool(ctx.tasks));
      ctx.registerTool(createStopTaskTool(ctx.tasks));
    }
    if (ctx.schedules) {
      ctx.registerTool(createScheduleTool(ctx.schedules));
    }
  },
  async dispose(ctx: KernelContext) {
    if (ctx.tasks) {
      await ctx.tasks.dispose();
    }
    if (ctx.schedules) {
      ctx.schedules.dispose();
    }
  },
};
