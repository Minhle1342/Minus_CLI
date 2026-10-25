import { AgentPlugin, KernelContext } from '../kernel.js';

/**
 * TaskPlugin - Quản lý các tiến trình nền và lịch trình (Antigravity CLI Background & Schedule Plugin)
 */
export const TaskPlugin: AgentPlugin = {
  name: 'task-plugin',
  version: '2.0.0',
  description: 'Background process management (manage_task with send_input stdin) and scheduled jobs (schedule)',
  apply(_ctx: KernelContext) {
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
