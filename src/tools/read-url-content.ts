/**
 * read-url-content.ts (Google Antigravity CLI Compatibility Alias)
 * 
 * Hợp nhất hoàn toàn vào src/tools/web-fetch.ts.
 * File này duy trì tương thích ngược 100% bằng cách re-export trực tiếp từ web-fetch.js.
 */

export {
  readUrlContentTool,
  webFetchTool,
  createReadUrlContentTool,
  createWebFetchTool,
  htmlToMarkdown,
  htmlToCleanMarkdown,
  extractCodeBlocksFromHtml,
  decodeHtmlEntities,
  clearWebFetchCache,
  type WebFetchToolOptions,
} from './web-fetch.js';

