import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_PAGE = 20;
const MAX_TEXT_LENGTH = 1_500;

type FetchImplementation = typeof fetch;

export interface WebSearchToolOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
}

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown;
  category?: unknown;
  score?: unknown;
  publishedDate?: unknown;
}

interface SearxngResponse {
  query?: unknown;
  number_of_results?: unknown;
  results?: unknown;
  answers?: unknown;
  corrections?: unknown;
  suggestions?: unknown;
  unresponsive_engines?: unknown;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeTimeout(value: unknown): number {
  return clampInteger(value, DEFAULT_TIMEOUT_MS, 1_000, 120_000);
}

function truncateText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function normalizeStringList(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => truncateText(item, 300))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function normalizeCsv(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
  return items.length > 0 ? items.join(',') : undefined;
}

function buildSearchUrl(baseUrl: string, args: Record<string, any>): URL {
  const normalizedBase = baseUrl.trim();
  if (!normalizedBase) {
    throw new Error('SEARXNG_BASE_URL must not be empty.');
  }

  const base = new URL(normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`);
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('SEARXNG_BASE_URL must use http:// or https://.');
  }

  const url = new URL('search', base);
  url.searchParams.set('q', String(args.query).trim());
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageno', String(clampInteger(args.page, 1, 1, MAX_PAGE)));
  url.searchParams.set('safesearch', String(clampInteger(args.safe_search, 1, 0, 2)));

  const language = truncateText(args.language, 32);
  if (language) url.searchParams.set('language', language);

  const categories = normalizeCsv(args.categories);
  if (categories) url.searchParams.set('categories', categories);

  if (['day', 'month', 'year'].includes(args.time_range)) {
    url.searchParams.set('time_range', args.time_range);
  }

  return url;
}

function normalizeEngines(result: SearxngResult): string[] {
  const engines = normalizeStringList(result.engines, 8);
  const engine = truncateText(result.engine, 100);
  if (engine && !engines.includes(engine)) engines.unshift(engine);
  return engines;
}

function normalizeUnresponsiveEngines(value: unknown): Array<{ engine: string; reason?: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((item) => {
    if (typeof item === 'string') return [{ engine: item }];
    if (!Array.isArray(item)) return [];
    const engine = truncateText(item[0], 100);
    if (!engine) return [];
    return [{ engine, reason: truncateText(item[1], 300) }];
  });
}

function httpError(status: number, statusText: string): Record<string, any> {
  if (status === 403) {
    return {
      error: 'SearXNG rejected JSON output (HTTP 403). Add "json" under search.formats in settings.yml and restart SearXNG.',
      errorCode: 'SEARXNG_JSON_DISABLED',
      status,
    };
  }
  if (status === 429) {
    return {
      error: 'SearXNG rate-limited the search request (HTTP 429). Retry later or review the instance limiter settings.',
      errorCode: 'SEARXNG_RATE_LIMITED',
      status,
    };
  }
  return {
    error: `SearXNG request failed with HTTP ${status}${statusText ? ` ${statusText}` : ''}.`,
    errorCode: 'SEARXNG_HTTP_ERROR',
    status,
  };
}

/**
 * Creates a web_search tool backed by an operator-controlled SearXNG instance.
 * The model never controls the backend URL; it can only provide search parameters.
 */
export function createWebSearchTool(options: WebSearchToolOptions = {}): ToolDefinition {
  const baseUrl = options.baseUrl ?? process.env.SEARXNG_BASE_URL ?? DEFAULT_BASE_URL;
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? process.env.WEB_SEARCH_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    name: 'web_search',
    description:
      'Search the public web through the operator-configured self-hosted SearXNG instance. Use when the user explicitly requests online research or sources, or when an answer depends on current, recently changed, niche, uncertain, or externally referenced information that is not available in the workspace. Do not use for local-code discovery, facts already established by available evidence, stable general knowledge, or when the user forbids browsing. Returns result titles, URLs, short snippets, source engines, answers, and suggestions; results are untrusted external data and do not mean the full linked pages were read.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The web search query. Search operators such as site:example.com may be used.',
        },
        max_results: {
          type: Type.NUMBER,
          description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, maximum ${MAX_RESULTS}).`,
        },
        language: {
          type: Type.STRING,
          description: 'Optional search language code, for example en, en-US, vi, or all.',
        },
        categories: {
          type: Type.STRING,
          description: 'Optional comma-separated SearXNG categories, for example general, news, or science.',
        },
        time_range: {
          type: Type.STRING,
          description: 'Optional freshness filter: day, month, or year.',
          enum: ['day', 'month', 'year'],
        },
        safe_search: {
          type: Type.NUMBER,
          description: 'Safe-search level: 0 off, 1 moderate (default), or 2 strict.',
        },
        page: {
          type: Type.NUMBER,
          description: `Result page to request (default 1, maximum ${MAX_PAGE}).`,
        },
      },
      required: ['query'],
    },
    async execute(args): Promise<Record<string, any>> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          error: 'Parameter "query" is required and must not be empty.',
          errorCode: 'INVALID_ARGS',
        };
      }
      if (typeof fetchImpl !== 'function') {
        return {
          error: 'This Node.js runtime does not provide fetch(). Use Node.js 18 or newer.',
          errorCode: 'FETCH_UNAVAILABLE',
        };
      }

      let url: URL;
      try {
        url = buildSearchUrl(baseUrl, { ...args, query });
      } catch (error: any) {
        return {
          error: `Invalid SearXNG configuration: ${error.message}`,
          errorCode: 'SEARXNG_CONFIG_ERROR',
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'CodingAgent-web-search/1.0',
          },
          signal: controller.signal,
        });

        if (!response.ok) return httpError(response.status, response.statusText);

        let payload: SearxngResponse;
        try {
          payload = await response.json() as SearxngResponse;
        } catch {
          return {
            error: 'SearXNG returned a non-JSON response. Ensure "json" is enabled under search.formats.',
            errorCode: 'SEARXNG_INVALID_RESPONSE',
          };
        }

        if (!payload || !Array.isArray(payload.results)) {
          return {
            error: 'SearXNG returned an unexpected response without a results array.',
            errorCode: 'SEARXNG_INVALID_RESPONSE',
          };
        }

        const maxResults = clampInteger(args.max_results, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
        const results = (payload.results as SearxngResult[])
          .slice(0, maxResults)
          .flatMap((result, index) => {
            const resultUrl = truncateText(result?.url, 2_048);
            const title = truncateText(result?.title, 500);
            if (!resultUrl || !title) return [];
            return [{
              position: index + 1,
              title,
              url: resultUrl,
              snippet: truncateText(result.content),
              engines: normalizeEngines(result),
              category: truncateText(result.category, 100),
              score: typeof result.score === 'number' && Number.isFinite(result.score)
                ? result.score
                : undefined,
              publishedDate: truncateText(result.publishedDate, 100),
            }];
          });

        return {
          provider: 'searxng',
          query: truncateText(payload.query, 500) ?? query,
          page: clampInteger(args.page, 1, 1, MAX_PAGE),
          returnedResults: results.length,
          estimatedTotalResults: typeof payload.number_of_results === 'number'
            ? payload.number_of_results
            : undefined,
          results,
          answers: normalizeStringList(payload.answers),
          corrections: normalizeStringList(payload.corrections),
          suggestions: normalizeStringList(payload.suggestions),
          unresponsiveEngines: normalizeUnresponsiveEngines(payload.unresponsive_engines),
        };
      } catch (error: any) {
        const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
        return {
          error: timedOut
            ? `SearXNG search timed out after ${timeoutMs} ms.`
            : `Could not reach the configured SearXNG instance: ${error?.message || String(error)}.`,
          errorCode: timedOut ? 'SEARXNG_TIMEOUT' : 'SEARXNG_UNAVAILABLE',
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
