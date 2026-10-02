import { AgentPlugin, KernelContext } from '../kernel.js';
import { createSaveMemoryTool, createReadMemoryTool } from '../../tools/memory-tools.js';

/**
 * MemoryPlugin - Module hoá công cụ Bộ nhớ dài hạn đa tầng (.codingagent/)
 */
export const MemoryPlugin: AgentPlugin = {
  name: 'memory-plugin',
  version: '1.0.0',
  description: 'Long-term knowledge management, Warm-Start Digest, and Memory tools',
  apply(ctx: KernelContext) {
    ctx.registerTool(createSaveMemoryTool(ctx.memory));
    ctx.registerTool(createReadMemoryTool(ctx.memory));
  },
};
