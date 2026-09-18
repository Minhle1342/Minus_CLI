import { AgentPlugin, KernelContext } from '../kernel.js';

export const FILE_MUTATION_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'replace_text',
  'replace_file_content',
  'multi_replace_file_content',
  'apply_patch',
  'create_file',
  'delete_file',
  'move_file',
  'run_command',
]);

let checkpointQueue: Promise<unknown> = Promise.resolve();
let onToolBeforeHandler: ((toolName: string, args: Record<string, any>) => void) | undefined;

/**
 * WorkspacePlugin - Quản lý thư mục dự án và Shadow Git Rollback (/undo)
 */
export const WorkspacePlugin: AgentPlugin = {
  name: 'workspace-plugin',
  version: '1.0.0',
  description: 'Quản lý Workspace, Shadow Checkpoint Snapshots và lệnh Rollback',
  apply(ctx: KernelContext) {
    onToolBeforeHandler = (toolName: string, args: Record<string, any>) => {
      if (FILE_MUTATION_TOOLS.has(toolName)) {
        checkpointQueue = checkpointQueue
          .then(async () => {
            const desc = `Tool ${toolName}: ${JSON.stringify(args || {})}`;
            await ctx.checkpoints.createCheckpoint(desc);
          })
          .catch(() => {});
      }
    };
    ctx.events.on('tool:before', onToolBeforeHandler);
  },
  dispose(ctx: KernelContext) {
    if (onToolBeforeHandler) {
      ctx.events.off('tool:before', onToolBeforeHandler);
      onToolBeforeHandler = undefined;
    }
  },
};
