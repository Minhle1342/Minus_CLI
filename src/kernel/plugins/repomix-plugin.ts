import { AgentPlugin, KernelContext } from '../kernel.js';

/**
 * RepomixPlugin - Module hóa công cụ nén code & đóng gói Tree-sitter (yamadashy/repomix)
 */
export const RepomixPlugin: AgentPlugin = {
  name: 'repomix-plugin',
  version: '1.0.0',
  description: 'Token-efficient source reading via Tree-sitter structural compression (Repomix)',
  apply(_ctx: KernelContext) {
  },
};

