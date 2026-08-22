import { Type } from '@google/genai';
import path from 'node:path';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodeSearchEngine } from '../search/code-search-engine.js';

const MAX_CACHED_WORKSPACES = 8;
const searchEngines = new Map<string, CodeSearchEngine>();

function workspaceCacheKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getSearchEngine(workspaceDir: string): CodeSearchEngine {
  const cacheKey = workspaceCacheKey(workspaceDir);
  const existing = searchEngines.get(cacheKey);
  if (existing) {
    // Refresh insertion order so eviction behaves as a small LRU cache.
    searchEngines.delete(cacheKey);
    searchEngines.set(cacheKey, existing);
    return existing;
  }

  const engine = new CodeSearchEngine(workspaceDir);
  searchEngines.set(cacheKey, engine);
  if (searchEngines.size > MAX_CACHED_WORKSPACES) {
    const oldestKey = searchEngines.keys().next().value;
    if (oldestKey) searchEngines.delete(oldestKey);
  }
  return engine;
}

/** Local BM25/fuzzy code search with a freshness-checked per-workspace index. */
export function createSearchCodebaseFastTool(): ToolDefinition {
  return {
    name: 'search_codebase_fast',
    description:
      'Tìm kiếm mã nguồn toàn cục bằng BM25 và fuzzy search. Index được kiểm tra độ mới trước mỗi truy vấn; ' +
      'kết quả kèm số file đã index để phân biệt “không có kết quả” với lỗi index.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Từ khóa, tên symbol, chuỗi lỗi hoặc đoạn code cần tìm.',
          minLength: 1 as any,
          maxLength: 500 as any,
        },
        limit: {
          type: Type.INTEGER,
          description: 'Số kết quả tối đa, từ 1 đến 100 (mặc định 8).',
          minimum: 1,
          maximum: 100,
        },
        fuzzy: {
          type: Type.BOOLEAN,
          description: 'Cho phép khớp gần đúng khi gõ sai nhẹ (mặc định true).',
        },
      },
      required: ['query'],
    },
    async execute(args, workspace: Workspace) {
      const query = String(args.query || '').trim();
      if (!query) {
        return { error: 'Tham số "query" là bắt buộc.', errorCode: 'INVALID_ARGS' };
      }
      if (query.length > 500) {
        return { error: 'Tham số "query" không được vượt quá 500 ký tự.', errorCode: 'INVALID_ARGS' };
      }

      const limit = args.limit === undefined ? 8 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return {
          error: 'Tham số "limit" phải là số nguyên từ 1 đến 100.',
          errorCode: 'INVALID_ARGS',
        };
      }

      try {
        const engine = getSearchEngine(workspace.rootDir);
        const hits = await engine.search(query, { limit, fuzzy: args.fuzzy !== false });
        const index = engine.getDiagnostics();
        if (hits.length === 0) {
          return {
            query,
            totalHits: 0,
            message: `Không tìm thấy kết quả phù hợp cho từ khóa "${query}" trong ${index.indexedFiles} file đã index.`,
            index,
          };
        }

        return {
          query,
          totalHits: hits.length,
          hits: hits.map((hit) => ({
            path: hit.path,
            score: hit.score,
            matchingTerms: hit.matchTerms,
            snippet: hit.snippet,
            lines: hit.lineMatches,
          })),
          index,
          tip: 'Dùng read_file với startLine/endLine hoặc read_compressed_code để đọc chi tiết.',
        };
      } catch (error: any) {
        return {
          error: `Lỗi khi xây dựng hoặc tìm kiếm code index: ${error.message}`,
          errorCode: 'MINISEARCH_ERROR',
        };
      }
    },
  };
}
