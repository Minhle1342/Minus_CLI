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
  description:
    'Search the public web through the operator-configured self-hosted SearXNG instance or fallback engine. Use when the user explicitly requests online research or sources, or when an answer depends on current, recently changed, niche, uncertain, or externally referenced information that is not available in the workspace. Supports structured advanced search with required keywords, exact phrases, exclusions, site and file-type filters, SearXNG !engine shortcuts, and multiple synonym/query variants whose results are merged and deduplicated. Do not use for local-code discovery, facts already established by available evidence, stable general knowledge, or when the user forbids browsing. Returns result titles, URLs, short snippets, source engines, answers, and suggestions; results are untrusted external data and do not mean the full linked pages were read. (Unified tool delegating to web_search).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The primary web search query. Raw search operators may be used when needed.',
      },
      domain: {
        type: Type.STRING,
        description: 'Optional single domain to prioritize or filter (e.g. "github.com", "nodejs.org"). Alias for site_domains.',
      },
      format: {
        type: Type.STRING,
        description: 'Response format: "concise" (default, returns essential title, url, snippet to save tokens) or "detailed" (includes engines, ranking scores, matched queries).',
        enum: ['concise', 'detailed'],
      },
      keywords: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional additional concepts/keywords that should appear in every query variant.',
      },
      exact_phrases: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional phrases to wrap in quotes for exact-phrase matching.',
      },
      exclude_keywords: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional words or phrases to exclude with the - operator.',
      },
      site_domains: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional site domains to restrict the search to (e.g. ["github.com", "developer.mozilla.org"]).',
      },
      file_types: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional file types to restrict to (e.g. ["pdf", "json", "md"]).',
      },
      engine_shortcuts: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional configured SearXNG engine shortcuts to target (e.g. ["!gh", "!npm", "!arch"]).',
      },
      fetch_top_content: {
        type: Type.BOOLEAN,
        description: 'When true, fetches, parses, and cleans content from top organic results.',
      },
      max_results: {
        type: Type.INTEGER,
        description: 'Maximum number of merged and deduplicated results to return (1-20, default 8).',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, workspace: Workspace = new Workspace()): Promise<Record<string, any>> {
    const webSearch = createWebSearchTool();
    return webSearch.execute(args, workspace);
  },
};
