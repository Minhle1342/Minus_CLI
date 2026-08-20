import { AgentPlugin, KernelContext } from '../kernel.js';

/**
 * WorkspacePlugin - Quản lý thư mục dự án và Shadow Git Rollback (/undo)
 */
export const WorkspacePlugin: AgentPlugin = {
  name: 'workspace-plugin',
  version: '1.0.0',
  description: 'Quản lý Workspace, Shadow Checkpoint Snapshots và lệnh Rollback',
  apply(ctx: KernelContext) {
    // Lắng nghe sự kiện trước khi gọi tool ghi file để tự động snapshot
    ctx.events.on('tool:before', async (toolName: string, args: Record<string, any>) => {
      if (['write_file', 'replace_text', 'run_command'].includes(toolName)) {
        await ctx.checkpoints.createCheckpoint(`Tool ${toolName}: ${JSON.stringify(args)}`);
      }
    });
  },
};
