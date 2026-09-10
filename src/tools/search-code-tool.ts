import { Type } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodeSearchEngine } from '../search/code-search-engine.js';
import { SemanticCodeIndex, type GraphExpansionMode } from '../search/semantic-code-index.js';
import { decideRetrievalMode, fuseSearchResults, type RetrievalMode } from '../search/hybrid-ranker.js';
import { buildAdaptiveCodeBundle } from '../search/adaptive-code-reader.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';

const MAX_CACHED_WORKSPACES = 8;
const searchEngines = new Map<string, CodeSearchEngine>();
const semanticIndexes = new Map<string, SemanticCodeIndex>();

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

function getSemanticIndex(workspaceDir: string): SemanticCodeIndex {
  const cacheKey = workspaceCacheKey(workspaceDir);
  const existing = semanticIndexes.get(cacheKey);
  if (existing) return existing;
  const index = new SemanticCodeIndex(workspaceDir);
  semanticIndexes.set(cacheKey, index);
  if (semanticIndexes.size > MAX_CACHED_WORKSPACES) {
    const oldestKey = semanticIndexes.keys().next().value;
    if (oldestKey) semanticIndexes.delete(oldestKey);
  }
  return index;
}

/** Freshness-checked lexical search with opt-in hybrid semantic retrieval. */
export function createSearchCodebaseFastTool(): ToolDefinition {
  return {
    name: 'search_codebase_fast',
    description:
      'Tìm kiếm mã nguồn toàn cục bằng BM25/fuzzy và semantic symbol index tùy chọn. ' +
      'Chế độ auto giữ lexical cho identifier/path/error literal và chỉ dùng hybrid cho truy vấn ý định tự nhiên.',
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
        mode: {
          type: Type.STRING,
          enum: ['auto', 'lexical', 'hybrid', 'semantic'],
          description: 'Chiến lược retrieval. auto dùng selective gate (mặc định).',
        },
        contextMode: {
          type: Type.STRING,
          enum: ['hits', 'adaptive_bundle'],
          description: 'Chỉ trả hits hoặc kèm context bundle đa độ phân giải.',
        },
        maxContextTokens: {
          type: Type.INTEGER,
          minimum: 64,
          maximum: 100000,
          description: 'Ngân sách token cho adaptive_bundle (mặc định 4000).',
        },
        graphExpansion: {
          type: Type.STRING,
          enum: ['none', 'dependencies', 'impact', 'auto'],
          description: 'Mở rộng tối đa một hop theo import graph sau seed retrieval.',
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

      const requestedMode = ['auto', 'lexical', 'hybrid', 'semantic'].includes(String(args.mode))
        ? String(args.mode) as RetrievalMode
        : 'auto';
      const selectiveContextFeature = normalizeSelectiveContextFeature(process.env.MINUS_SELECTIVE_CONTEXT);
      const proposedDecision = decideRetrievalMode(query, requestedMode);
      const decision = requestedMode === 'auto' && selectiveContextFeature !== 'on'
        ? { mode: 'lexical' as const, reason: selectiveContextFeature === 'shadow' ? 'selective_gate_shadow' : 'selective_gate_disabled' }
        : proposedDecision;
      const semanticFeature = normalizeSemanticFeature(process.env.MINUS_SEMANTIC_SEARCH);
      const graphExpansion = ['none', 'dependencies', 'impact', 'auto'].includes(String(args.graphExpansion))
        ? String(args.graphExpansion) as GraphExpansionMode
        : 'auto';

      try {
        const engine = getSearchEngine(workspace.rootDir);
        const lexicalLimit = decision.mode === 'lexical' ? limit : Math.min(100, Math.max(40, limit * 4));
        const lexicalHits = await engine.search(query, { limit: lexicalLimit, fuzzy: args.fuzzy !== false });
        const index = engine.getDiagnostics();
        let semanticHits: Awaited<ReturnType<SemanticCodeIndex['search']>> = [];
        let semanticError: string | undefined;
        const semanticIndex = getSemanticIndex(workspace.rootDir);
        const wantsSemantic = decision.mode === 'hybrid' || decision.mode === 'semantic';
        if (wantsSemantic && semanticFeature === 'on') {
          try {
            semanticHits = await semanticIndex.search(query, {
              limit: Math.min(100, Math.max(40, limit * 4)),
              graphExpansion,
            });
          } catch (error: any) {
            semanticError = error.message;
          }
        } else if (wantsSemantic && semanticFeature === 'shadow') {
          void semanticIndex.search(query, {
            limit: Math.min(100, Math.max(40, limit * 4)),
            graphExpansion,
          }).catch(() => {});
        }

        const effectiveMode = wantsSemantic && semanticFeature === 'on' && !semanticError
          ? decision.mode
          : 'lexical';
        const hits = effectiveMode === 'lexical'
          ? lexicalHits.slice(0, limit).map((hit) => ({
              id: `file:${hit.path}`,
              path: hit.path,
              score: hit.score,
              scoreComponents: { lexicalRrf: hit.score, semanticRrf: 0, exactBoost: 0, graphBoost: 0 },
              matchingTerms: hit.matchTerms,
              snippet: hit.snippet,
              lines: hit.lineMatches,
            }))
          : fuseSearchResults(query, decision.mode === 'semantic' ? [] : lexicalHits, semanticHits, limit).map((hit) => ({
              ...hit,
              lines: hit.startLine ? [{ line: hit.startLine, text: hit.snippet.split('\n')[0] || '' }] : [],
            }));

        const semanticDiagnostics = semanticIndex.getDiagnostics();
        const retrieval = {
          requestedMode,
          selectedMode: decision.mode,
          effectiveMode,
          reason: decision.reason,
          selectiveContextFeature,
          ...(selectiveContextFeature === 'shadow' ? { shadowSelectedMode: proposedDecision.mode } : {}),
          semanticFeature,
          semantic: semanticDiagnostics,
          ...(semanticError ? { fallbackReason: semanticError } : {}),
        };
        if (hits.length === 0) {
          return {
            query,
            totalHits: 0,
            message: `Không tìm thấy kết quả phù hợp cho từ khóa "${query}" trong ${index.indexedFiles} file đã index.`,
            index,
            retrieval,
          };
        }

        let contextBundle: ReturnType<typeof buildAdaptiveCodeBundle> | undefined;
        if (args.contextMode === 'adaptive_bundle') {
          const selectedPaths = [...new Set(hits.map((hit) => hit.path))].slice(0, 8);
          const sourceFiles = await Promise.all(selectedPaths.map(async (filePath) => {
            const content = await fs.readFile(workspace.resolveSafePath(filePath), 'utf8');
            return {
              path: filePath,
              content,
              compressedContent: SemanticSlicer.extractOutline(filePath, content).summary,
            };
          }));
          const focusSymbols = hits
            .map((hit) => 'symbol' in hit && typeof hit.symbol === 'string' ? `${hit.path}::${hit.symbol}` : undefined)
            .filter((value): value is string => Boolean(value))
            .slice(0, 2);
          contextBundle = buildAdaptiveCodeBundle(sourceFiles, {
            focusSymbols,
            maxTokens: args.maxContextTokens === undefined ? 4_000 : Number(args.maxContextTokens),
            includeDirectoryStructure: true,
          });
        }

        return {
          query,
          totalHits: hits.length,
          hits,
          index,
          retrieval,
          ...(contextBundle ? { contextBundle } : {}),
          tip: contextBundle
            ? 'Context bundle đã chứa full body cho symbol trọng tâm và preview/fold cho hàng xóm.'
            : 'Dùng contextMode="adaptive_bundle" hoặc read_compressed_code fidelity="adaptive" để đọc chi tiết trong một lượt.',
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

function normalizeSemanticFeature(value: string | undefined): 'off' | 'shadow' | 'on' {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'on' || normalized === 'shadow' ? normalized : 'off';
}

function normalizeSelectiveContextFeature(value: string | undefined): 'off' | 'shadow' | 'on' {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'on' || normalized === 'shadow' ? normalized : 'off';
}
