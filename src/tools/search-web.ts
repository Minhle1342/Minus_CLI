import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';

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
}

/**
 * Tìm kiếm web qua DuckDuckGo HTML endpoint hoặc public JSON API
 */
export async function executeWebSearch(query: string, domain?: string): Promise<SearchWebResponse> {
  const effectiveQuery = domain ? `site:${domain} ${query}` : query;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(effectiveQuery)}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        query,
        domain,
        results: [],
        summary: `Tìm kiếm web trả về HTTP status ${res.status}.`,
      };
    }

    const html = await res.text();
    const results: SearchWebResultItem[] = [];

    // Parse kết quả HTML từ DuckDuckGo
    const resultRegex = /<a class="result__url" href="([^"]+)">[\s\S]*?<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const titleRegex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    
    // Parse khối kết quả chuẩn
    const blocks = html.split('<div class="result results_links');
    for (let i = 1; i < Math.min(blocks.length, 10); i++) {
      const block = blocks[i];
      const linkMatch = block.match(/href="([^"]+)"/);
      const titleMatch = block.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

      if (titleMatch && (linkMatch || snippetMatch)) {
        let rawUrl = linkMatch ? linkMatch[1] : '';
        // Giải mã DuckDuckGo redirect URL nếu có
        if (rawUrl.includes('uddg=')) {
          const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
          if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);
        }
        const cleanTitle = (titleMatch[1] || '').replace(/<[^>]+>/g, '').trim();
        const cleanSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        if (cleanTitle && rawUrl) {
          results.push({
            title: cleanTitle,
            url: rawUrl,
            snippet: cleanSnippet,
          });
        }
      }
    }

    return {
      query,
      domain,
      results,
      summary: results.length > 0
        ? `Tìm thấy ${results.length} kết quả liên quan cho "${query}".`
        : `Không tìm thấy kết quả trực tiếp cho "${query}".`,
    };
  } catch (err: any) {
    return {
      query,
      domain,
      results: [],
      summary: `Không thể kết nối đến Web Search Engine: ${err.message}`,
    };
  }
}

/**
 * Tool: search_web
 * Chuẩn Google Antigravity CLI: Thực hiện tìm kiếm web và trả về summary kèm URL citations.
 */
export const searchWebTool: ToolDefinition = {
  name: 'search_web',
  description: 'Performs a web search for a given query. Returns a summary of relevant information along with URL citations and snippets.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search query string.',
      },
      domain: {
        type: Type.STRING,
        description: 'Optional domain to recommend the search prioritize (e.g. "github.com", "nodejs.org").',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>): Promise<Record<string, any>> {
    const query = String(args.query || '').trim();
    const domain = args.domain ? String(args.domain).trim() : undefined;

    if (!query) {
      return { error: 'Tham số "query" là bắt buộc đối với search_web.' };
    }

    const searchResponse = await executeWebSearch(query, domain);
    return {
      success: true,
      ...searchResponse,
    };
  },
};
