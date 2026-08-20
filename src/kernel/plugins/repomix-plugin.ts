import { AgentPlugin, KernelContext } from '../kernel.js';
import { createReadCompressedCodeTool, createPackCodebaseTool } from '../../tools/repomix-tool.js';

/**
 * RepomixPlugin - Module hóa công cụ nén code & đóng gói Tree-sitter (yamadashy/repomix)
 */
export const RepomixPlugin: AgentPlugin = {
  name: 'repomix-plugin',
  version: '1.0.0',
  description: 'Tối ưu hóa token khi đọc mã nguồn bằng nén cấu trúc Tree-sitter qua Repomix',
  apply(ctx: KernelContext) {
    ctx.registerTool(createReadCompressedCodeTool());
    ctx.registerTool(createPackCodebaseTool());
  },
};
