import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodeSearchEngine } from '../search/code-search-engine.js';

let sharedSearchEngine: CodeSearchEngine | null = null;
let lastIndexedPath: string | null = null;

function getSearchEngine(workspaceDir: string): CodeSearchEngine {
  if (!sharedSearchEngine || lastIndexedPath !== workspaceDir) {
    sharedSearchEngine = new CodeSearchEngine(workspaceDir);
    lastIndexedPath = workspaceDir;
  }
  return sharedSearchEngine;
}

/**
 * createSearchCodebaseFastTool
 * Công cụ tìm kiếm mã nguồn cục bộ BM25 siêu tốc bằng MiniSearch (0 Token tiêu tốn)
 */
export function createSearchCodebaseFastTool(): ToolDefinition {
  return {
    name: 'search_codebase_fast',
    description:
      'Tìm kiếm mã nguồn toàn cục siêu tốc bằng thuật toán BM25 & Fuzzy Search (MiniSearch cục bộ, tiêu tốn 0 token). ' +
      'Định vị nhanh các file chứa hàm, class, biến, kiểu dữ liệu hoặc đoạn mã trước khi quyết định đọc chi tiết.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Từ khóa tìm kiếm (tên hàm, tên class, biến, chuỗi thông báo lỗi, hoặc biểu thức code).',
        },
        limit: {
          type: Type.NUMBER,
          description: 'Số lượng kết quả phù hợp tối đa cần trả về (mặc định: 8).',
        },
        fuzzy: {
          type: Type.BOOLEAN,
          description: 'Bật tính năng tìm kiếm mờ/gần đúng cho phép gõ sai nhẹ (mặc định: true).',
        },
      },
      required: ['query'],
    },
    async execute(args, workspace: Workspace) {
      const query = String(args.query || '').trim();
      if (!query) {
        return { error: 'Tham số "query" là bắt buộc.' };
      }

      const limit = typeof args.limit === 'number' ? args.limit : 8;
      const fuzzy = args.fuzzy !== false;

      try {
        const engine = getSearchEngine(workspace.rootDir);
        const hits = await engine.search(query, { limit, fuzzy });

        if (hits.length === 0) {
          return {
            query,
            totalHits: 0,
            message: `Không tìm thấy kết quả phù hợp cho từ khóa "${query}" trong codebase.`,
          };
        }

        return {
          query,
          totalHits: hits.length,
          hits: hits.map((h) => ({
            path: h.path,
            score: h.score,
            matchingTerms: h.matchTerms,
            snippet: h.snippet,
            lines: h.lineMatches,
          })),
          tip: 'Dùng tool "read_file" với startLine/endLine hoặc "read_compressed_code" để đọc chi tiết các file trên.',
        };
      } catch (err: any) {
        return {
          error: `Lỗi khi tìm kiếm với MiniSearch: ${err.message}`,
          errorCode: 'MINISEARCH_ERROR',
        };
      }
    },
  };
}
