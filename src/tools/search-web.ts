/**
 * search-web.ts (Google Antigravity CLI Compatibility Alias)
 * 
 * Hợp nhất hoàn toàn vào src/tools/web-search.ts.
 * File này duy trì tương thích ngược 100% bằng cách re-export trực tiếp từ web-search.js.
 */

export {
  searchWebTool,
  webSearchTool,
  createSearchWebTool,
  createWebSearchTool,
  executeWebSearch,
  type SearchWebResultItem,
  type SearchWebResponse,
  type WebSearchToolOptions,
} from './web-search.js';

