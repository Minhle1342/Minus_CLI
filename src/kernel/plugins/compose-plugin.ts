import { AgentPlugin, KernelContext } from '../kernel.js';
import { createComposeTools } from '../../tools/compose-tools.js';

export class ComposePlugin implements AgentPlugin {
  readonly name = 'compose';
  readonly version = '1.0.0';
  readonly description = 'Spec-driven isolated coding lifecycle with durable acceptance gates';

  private onToolAfter?: (toolName: string, result: Record<string, any>, _durationMs: number, args: Record<string, any>) => void;
  private onWorkspaceChanged?: (oldPath: string, newPath: string) => void;

  async apply(ctx: KernelContext): Promise<void> {
    for (const tool of createComposeTools(ctx.compose)) ctx.tools.register(tool);

    this.onToolAfter = (toolName: string, result: Record<string, any>, _durationMs: number, args: Record<string, any>) => {
      void ctx.compose.observeToolResult(toolName, args || {}, result || {}).catch(() => {});
    };
    ctx.events.on('tool:after', this.onToolAfter);

    this.onWorkspaceChanged = () => {
      for (const tool of createComposeTools(ctx.compose)) ctx.tools.register(tool);
    };
    ctx.events.on('workspace:changed', this.onWorkspaceChanged);

    ctx.systemPrompt.unregister('compose-static-contract');
    ctx.systemPrompt.register({
      id: 'compose-static-contract',
      priority: 76,
      content: 'When a Compose run is active, its dynamic phase contract is authoritative. Never mutate before SPEC_LOCKED/IMPLEMENTING, never work outside its isolated worktree, and never claim completion without fresh acceptance evidence and a registered diff.',
    });
  }

  dispose(ctx: KernelContext): void {
    if (this.onToolAfter) {
      ctx.events.off('tool:after', this.onToolAfter);
      this.onToolAfter = undefined;
    }
    if (this.onWorkspaceChanged) {
      ctx.events.off('workspace:changed', this.onWorkspaceChanged);
      this.onWorkspaceChanged = undefined;
    }
    ctx.systemPrompt.unregister('compose-static-contract');
  }
}
