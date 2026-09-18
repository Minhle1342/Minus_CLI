import { AgentPlugin, KernelContext } from '../kernel.js';
import { SandboxMode } from '../../sandbox/types.js';

export interface SandboxPluginOptions {
  mode?: SandboxMode;
  dockerImage?: string;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

/**
 * SandboxPlugin - Môi trường thực thi lệnh cô lập (True Execution Sandbox)
 */
export function createSandboxPlugin(options?: SandboxPluginOptions): AgentPlugin {
  return {
    name: 'sandbox-plugin',
    version: '1.0.0',
    description: 'Cung cấp môi trường thực thi lệnh cô lập bằng Docker hoặc Local Process Sandbox',
    async apply(ctx: KernelContext) {
      if (options && (options.mode || options.dockerImage || options.memoryLimitMb || options.cpuLimit)) {
        const { SandboxManager } = await import('../../sandbox/sandbox-manager.js');
        const configuredSandbox = new SandboxManager({
          workspacePath: ctx.workspace.rootDir,
          mode: options.mode,
          dockerImage: options.dockerImage,
          memoryLimitMb: options.memoryLimitMb,
          cpuLimit: options.cpuLimit,
        });
        (ctx as any).sandbox = configuredSandbox;
        ctx.tools.attachSandboxManager(configuredSandbox);
      }
      // Khởi tạo Sandbox Provider
      await ctx.sandbox.init();
    },
    async dispose(ctx: KernelContext) {
      await ctx.sandbox.dispose();
    },
  };
}

export const SandboxPlugin = createSandboxPlugin();
