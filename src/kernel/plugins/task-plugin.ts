import { AgentPlugin, KernelContext } from '../kernel.js';
import { createStartBackgroundTaskTool, createGetTaskOutputTool, createStopTaskTool } from '../../tools/task-tools.js';

/**
 * TaskPlugin - Quản lý các tiến trình nền bất đồng bộ (Asynchronous Subprocesses)
 */
export const TaskPlugin: AgentPlugin = {
  name: 'task-plugin',
  version: '1.0.0',
  description: 'Quản lý các tiến trình nền (background tasks, dev servers, test watchers)',
  apply(ctx: KernelContext) {
    ctx.registerTool(createStartBackgroundTaskTool(ctx.tasks));
    ctx.registerTool(createGetTaskOutputTool(ctx.tasks));
    ctx.registerTool(createStopTaskTool(ctx.tasks));
  },
  async dispose(ctx: KernelContext) {
    if (ctx.tasks) {
      await ctx.tasks.dispose();
    }
  },
};
