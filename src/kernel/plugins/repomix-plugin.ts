import { AgentPlugin, KernelContext } from '../kernel.js';
import { createReadCompressedCodeTool, createPackCodebaseTool } from '../../tools/repomix-tool.js';

/**
 * RepomixPlugin - Module hóa công cụ nén code & đóng gói Tree-sitter (yamadashy/repomix)
 */
export const RepomixPlugin: AgentPlugin = {
  name: 'repomix-plugin',
  version: '1.0.0',
  description: 'Token-efficient source reading via Tree-sitter structural compression (Repomix)',
  apply(ctx: KernelContext) {
    ctx.registerTool(createReadCompressedCodeTool());
    ctx.registerTool(createPackCodebaseTool());
  },
};
