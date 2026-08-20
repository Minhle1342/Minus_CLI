import { AgentPlugin, KernelContext } from '../kernel.js';
import { createSearchCodebaseFastTool } from '../../tools/search-code-tool.js';

/**
 * SearchPlugin - Module hóa công cụ tìm kiếm toàn văn mã nguồn cục bộ BM25 (MiniSearch)
 */
export const SearchPlugin: AgentPlugin = {
  name: 'search-plugin',
  version: '1.0.0',
  description: 'Tìm kiếm mã nguồn toàn cục siêu tốc BM25 & Fuzzy Search (0 token tiêu tốn)',
  apply(ctx: KernelContext) {
    ctx.registerTool(createSearchCodebaseFastTool());
  },
};
