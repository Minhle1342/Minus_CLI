import { createComposeTools } from '../../tools/compose-tools.js';

export class ComposePlugin {
  readonly name = 'compose';
  readonly version = '1.0.0';
  readonly description = 'Spec-driven isolated coding lifecycle with durable acceptance gates';

  async apply(ctx: any): Promise<void> {
    for (const tool of createComposeTools(ctx.compose)) ctx.tools.register(tool);
    ctx.events.on('tool:after', (toolName: string, result: Record<string, any>, _durationMs: number, args: Record<string, any>) => {
      void ctx.compose.observeToolResult(toolName, args || {}, result || {}).catch(() => {});
    });
    ctx.systemPrompt.register({
      id: 'compose-static-contract',
      priority: 76,
      content: 'When a Compose run is active, its dynamic phase contract is authoritative. Never mutate before SPEC_LOCKED/IMPLEMENTING, never work outside its isolated worktree, and never claim completion without fresh acceptance evidence and a registered diff.',
    });
  }
}
