import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { createWebSearchTool } from './web-search.js';

export interface SearchWebResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchWebResponse {
  query: string;
  domain?: string;
  results: SearchWebResultItem[];
  summary?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  errorCode?: string;
  hint?: string;
}

/**
 * Unified Web Search execution with SearXNG and DuckDuckGo fallback.
 */
export async function executeWebSearch(query: string, domain?: string): Promise<SearchWebResponse> {
  const tool = createWebSearchTool();
  try {
    const res = await tool.execute({ query, domain, format: 'concise' }, new Workspace());

    if (res.results && Array.isArray(res.results)) {
      const mappedResults: SearchWebResultItem[] = res.results.map((r: any) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.snippet || '',
      }));

      return {
        query,
        domain,
        results: mappedResults,
        summary: mappedResults.length > 0
          ? `Found ${mappedResults.length} relevant results for "${query}".`
          : `No direct results found for "${query}".`,
        provider: res.provider,
        success: true,
      };
    }

    return {
      query,
      domain,
      results: [],
      summary: res.error || 'Failed to search web.',
      error: res.error,
      errorCode: res.errorCode,
      hint: res.hint,
      success: false,
    };
  } catch (err: any) {
    return {
      query,
      domain,
      results: [],
      summary: `Web search execution error: ${err?.message || String(err)}`,
      error: err?.message || String(err),
      errorCode: 'EXECUTION_ERROR',
      success: false,
    };
  }
}

/**
 * Tool: search_web
 * Google Antigravity CLI compatibility alias wrapper for web_search.
 */
export const searchWebTool: ToolDefinition = {
  name: 'search_web',
  description: 'Search the public web for current information, documentation, and external references. (Unified tool delegating to web_search).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search query string.',
      },
      domain: {
        type: Type.STRING,
        description: 'Optional domain to prioritize (e.g. "github.com", "nodejs.org").',
      },
      format: {
        type: Type.STRING,
        description: 'Response format: "concise" (default) or "detailed".',
        enum: ['concise', 'detailed'],
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, workspace: Workspace = new Workspace()): Promise<Record<string, any>> {
    const webSearch = createWebSearchTool();
    return webSearch.execute(args, workspace);
  },
};
