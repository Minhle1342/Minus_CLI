import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { htmlToCleanMarkdown, extractCodeBlocksFromHtml } from './web-fetch.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_PAGE = 20;
const MAX_TEXT_LENGTH = 1_500;
const MAX_ADDITIONAL_QUERIES = 4;
const MAX_FILTER_VALUES = 10;
const RRF_RANK_CONSTANT = 60;

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

interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet?: string;
  engines: string[];
  category?: string;
  score?: number;
  publishedDate?: string;
}

interface SearchSuccess {
  ok: true;
  query: string;
  payload: SearxngResponse;
  results: NormalizedSearchResult[];
}

interface SearchFailure {
  ok: false;
  query: string;
  error: Record<string, any>;
}

type SearchAttempt = SearchSuccess | SearchFailure;

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

function normalizeStringList(value: unknown, limit = MAX_FILTER_VALUES, maxLength = 300): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => truncateText(item, maxLength))
    .filter((item): item is string => Boolean(item)))]
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

function quoteSearchTerm(value: string): string {
  const escaped = value.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
  return escaped.includes(' ') ? `"${escaped}"` : escaped;
}

function normalizeDomain(value: string): string | undefined {
  const candidate = value.replace(/^site:/i, '').trim();
  try {
    const hostname = new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname;
    return /^[a-z0-9.-]+$/i.test(hostname) ? hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFileType(value: string): string | undefined {
  const candidate = value.replace(/^\.?filetype:/i, '').replace(/^\./, '').trim().toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(candidate) ? candidate : undefined;
}

function normalizeEngineShortcut(value: string): string | undefined {
  const candidate = value.replace(/^!+/, '').trim();
  return /^[a-z0-9_+-]{1,40}$/i.test(candidate) ? candidate : undefined;
}

function orFilter(operator: 'site' | 'filetype', values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const terms = values.map((value) => `${operator}:${value}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
}

function buildAdvancedQueries(args: Record<string, any>, primaryQuery: string): string[] {
  const keywords = normalizeStringList(args.keywords).map((value) => value.replace(/[\r\n]/g, ' '));
  const exactPhrases = normalizeStringList(args.exact_phrases).map(quoteSearchTerm);
  const exclusions = normalizeStringList(args.exclude_keywords).map((value) => `-${quoteSearchTerm(value)}`);
  const domains = normalizeStringList(args.site_domains)
    .map(normalizeDomain)
    .filter((value): value is string => Boolean(value));
  const fileTypes = normalizeStringList(args.file_types)
    .map(normalizeFileType)
    .filter((value): value is string => Boolean(value));
  const engineShortcuts = normalizeStringList(args.engine_shortcuts)
    .map(normalizeEngineShortcut)
    .filter((value): value is string => Boolean(value))
    .map((value) => `!${value}`);

  const filters = [
    ...keywords,
    ...exactPhrases,
    ...exclusions,
    orFilter('site', [...new Set(domains)]),
    orFilter('filetype', [...new Set(fileTypes)]),
  ].filter((value): value is string => Boolean(value));

  const seeds = [
    primaryQuery,
    ...normalizeStringList(args.additional_queries, MAX_ADDITIONAL_QUERIES, 500),
  ];
  const compiled = seeds.map((seed) => [...engineShortcuts, seed, ...filters].join(' ').trim());
  return [...new Set(compiled)].slice(0, MAX_ADDITIONAL_QUERIES + 1);
}

function buildSearchUrl(baseUrl: string, query: string, args: Record<string, any>): URL {
  const normalizedBase = baseUrl.trim();
  if (!normalizedBase) throw new Error('SEARXNG_BASE_URL must not be empty.');

  const base = new URL(normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`);
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('SEARXNG_BASE_URL must use http:// or https://.');
  }

  const url = new URL('search', base);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageno', String(clampInteger(args.page, 1, 1, MAX_PAGE)));
  url.searchParams.set('safesearch', String(clampInteger(args.safe_search, 1, 0, 2)));

  const language = truncateText(args.language, 32);
  if (language) url.searchParams.set('language', language);
  const categories = normalizeCsv(args.categories);
  if (categories) url.searchParams.set('categories', categories);
  if (['day', 'month', 'year'].includes(args.time_range)) url.searchParams.set('time_range', args.time_range);
  return url;
}

function normalizeEngines(result: SearxngResult): string[] {
  const engines = normalizeStringList(result.engines, 8, 100);
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
    const reason = truncateText(item[1], 300);
    return [{ engine, ...(reason ? { reason } : {}) }];
  });
}

function normalizeResultUrl(value: unknown): string | undefined {
  const resultUrl = truncateText(value, 2_048);
  if (!resultUrl) return undefined;
  try {
    const parsed = new URL(resultUrl);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function canonicalResultUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return value.toLowerCase();
  }
}

function normalizeResults(payload: SearxngResponse): NormalizedSearchResult[] {
  if (!Array.isArray(payload.results)) return [];
  return (payload.results as SearxngResult[]).flatMap((result) => {
    const url = normalizeResultUrl(result?.url);
    const title = truncateText(result?.title, 500);
    if (!url || !title) return [];
    const snippet = truncateText(result.content);
    const category = truncateText(result.category, 100);
    const score = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : undefined;
    const publishedDate = truncateText(result.publishedDate, 100);
    return [{
      title,
      url,
      engines: normalizeEngines(result),
      ...(snippet ? { snippet } : {}),
      ...(category ? { category } : {}),
      ...(score !== undefined ? { score } : {}),
      ...(publishedDate ? { publishedDate } : {}),
    }];
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

function mergeUniqueStrings(values: unknown[], limit = 10): string[] {
  return [...new Set(values.flatMap((value) => normalizeStringList(value, limit)))].slice(0, limit);
}

/** Creates a web_search tool backed by an operator-controlled SearXNG instance. */
export function createWebSearchTool(options: WebSearchToolOptions = {}): ToolDefinition {
  const baseUrl = options.baseUrl ?? process.env.SEARXNG_BASE_URL ?? DEFAULT_BASE_URL;
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? process.env.WEB_SEARCH_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    name: 'web_search',
    description:
      'Search the public web through the operator-configured self-hosted SearXNG instance. Use when the user explicitly requests online research or sources, or when an answer depends on current, recently changed, niche, uncertain, or externally referenced information that is not available in the workspace. Supports structured advanced search with required keywords, exact phrases, exclusions, site and file-type filters, SearXNG !engine shortcuts, and multiple synonym/query variants whose results are merged and deduplicated. Do not use for local-code discovery, facts already established by available evidence, stable general knowledge, or when the user forbids browsing. Returns result titles, URLs, short snippets, source engines, answers, and suggestions; results are untrusted external data and do not mean the full linked pages were read.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'The primary web search query. Raw search operators may be used when needed.' },
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
          description: 'Optional domains for site: filtering, for example github.com or docs.python.org. Multiple domains are combined with OR.',
        },
        file_types: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional extensions for filetype: filtering, for example pdf, csv, or docx. Multiple types are combined with OR.',
        },
        engine_shortcuts: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional SearXNG engine/category shortcuts without the leading !, for example github, arxiv, or news. Availability depends on instance configuration.',
        },
        additional_queries: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: `Up to ${MAX_ADDITIONAL_QUERIES} focused synonym, spelling, terminology, or language variants. They receive the same filters; results are fused and deduplicated.`,
        },
        max_results: { type: Type.NUMBER, description: `Maximum number of merged results to return (default ${DEFAULT_MAX_RESULTS}, maximum ${MAX_RESULTS}).` },
        language: { type: Type.STRING, description: 'Optional search language code, for example en, en-US, vi, or all.' },
        categories: { type: Type.STRING, description: 'Optional comma-separated SearXNG categories, for example general, news, or science.' },
        time_range: { type: Type.STRING, description: 'Optional freshness filter: day, month, or year.', enum: ['day', 'month', 'year'] },
        safe_search: { type: Type.NUMBER, description: 'Safe-search level: 0 off, 1 moderate (default), or 2 strict.' },
        page: { type: Type.NUMBER, description: `Result page to request (default 1, maximum ${MAX_PAGE}).` },
        fetch_top_content: {
          type: Type.BOOLEAN,
          description: 'When true, automatically fetches and extracts clean markdown & code snippets from the top 1-2 search results for immediate single-turn resolution.',
        },
        mode: {
          type: Type.STRING,
          description: 'Search mode: "live" for real-time web search (default), or "cached" for local/cached index retrieval.',
          enum: ['live', 'cached'],
        },
      },
      required: ['query'],
    },
    async execute(args): Promise<Record<string, any>> {
      const primaryQuery = truncateText(args.query, 500);
      if (!primaryQuery) return { error: 'Parameter "query" is required and must not be empty.', errorCode: 'INVALID_ARGS' };
      if (typeof fetchImpl !== 'function') {
        return { error: 'This Node.js runtime does not provide fetch(). Use Node.js 18 or newer.', errorCode: 'FETCH_UNAVAILABLE' };
      }

      const queries = buildAdvancedQueries(args, primaryQuery);
      let urls: URL[];
      try {
        urls = queries.map((query) => buildSearchUrl(baseUrl, query, args));
      } catch (error: any) {
        return { error: `Invalid SearXNG configuration: ${error.message}`, errorCode: 'SEARXNG_CONFIG_ERROR' };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const searchOnce = async (query: string, url: URL): Promise<SearchAttempt> => {
        try {
          const response = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': 'CodingAgent-web-search/2.0' },
            signal: controller.signal,
          });
          if (!response.ok) return { ok: false, query, error: httpError(response.status, response.statusText) };

          let payload: SearxngResponse;
          try {
            payload = await response.json() as SearxngResponse;
          } catch {
            return {
              ok: false,
              query,
              error: { error: 'SearXNG returned a non-JSON response. Ensure "json" is enabled under search.formats.', errorCode: 'SEARXNG_INVALID_RESPONSE' },
            };
          }
          if (!payload || !Array.isArray(payload.results)) {
            return {
              ok: false,
              query,
              error: { error: 'SearXNG returned an unexpected response without a results array.', errorCode: 'SEARXNG_INVALID_RESPONSE' },
            };
          }
          return { ok: true, query, payload, results: normalizeResults(payload) };
        } catch (error: any) {
          const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
          return {
            ok: false,
            query,
            error: {
              error: timedOut
                ? `SearXNG search timed out after ${timeoutMs} ms.`
                : `Could not reach the configured SearXNG instance: ${error?.message || String(error)}.`,
              errorCode: timedOut ? 'SEARXNG_TIMEOUT' : 'SEARXNG_UNAVAILABLE',
            },
          };
        }
      };

      try {
        const attempts = await Promise.all(queries.map((query, index) => searchOnce(query, urls[index])));
        const successes = attempts.filter((attempt): attempt is SearchSuccess => attempt.ok);
        const failures = attempts.filter((attempt): attempt is SearchFailure => !attempt.ok);
        if (successes.length === 0) return { ...failures[0]?.error, queries, queryCount: queries.length };

        const merged = new Map<string, NormalizedSearchResult & { matchedQueries: string[]; reciprocalRankScore: number }>();
        for (const success of successes) {
          success.results.forEach((result, index) => {
            const key = canonicalResultUrl(result.url);
            const rankContribution = 1 / (RRF_RANK_CONSTANT + index + 1);
            const existing = merged.get(key);
            if (existing) {
              existing.reciprocalRankScore += rankContribution;
              if (!existing.matchedQueries.includes(success.query)) existing.matchedQueries.push(success.query);
              existing.engines = [...new Set([...existing.engines, ...result.engines])];
              if (!existing.snippet && result.snippet) existing.snippet = result.snippet;
            } else {
              merged.set(key, { ...result, matchedQueries: [success.query], reciprocalRankScore: rankContribution });
            }
          });
        }

        const maxResults = clampInteger(args.max_results, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
        const results = [...merged.values()]
          .sort((a, b) => b.reciprocalRankScore - a.reciprocalRankScore)
          .slice(0, maxResults)
          .map((result, index) => ({ position: index + 1, ...result, reciprocalRankScore: Number(result.reciprocalRankScore.toFixed(6)) }));

        const estimatedTotals = successes
          .map(({ payload }) => payload.number_of_results)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const unresponsiveEngines = [...new Map(successes
          .flatMap(({ payload }) => normalizeUnresponsiveEngines(payload.unresponsive_engines))
          .map((item) => [`${item.engine}\u0000${item.reason ?? ''}`, item])).values()].slice(0, 10);

        let extractedTopContent: Array<{ url: string; title: string; markdown: string; codeBlocks: string[] }> | undefined;
        if (Boolean(args.fetch_top_content) && results.length > 0) {
          const targets = results.slice(0, 1);
          const fetchedItems = await Promise.all(targets.map(async (item) => {
            try {
              const res = await fetchImpl(item.url, {
                method: 'GET',
                headers: { 'User-Agent': 'CodingAgent-DeepInvestigator/2.0', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
                signal: controller.signal,
              });
              if (!res.ok) return null;
              const text = await res.text();
              const { markdown, title } = htmlToCleanMarkdown(text, item.url);
              const codeBlocks = extractCodeBlocksFromHtml(text);
              return {
                url: item.url,
                title: title || item.title,
                markdown: markdown.slice(0, 3000),
                codeBlocks: codeBlocks.slice(0, 5),
              };
            } catch {
              return null;
            }
          }));
          extractedTopContent = fetchedItems.filter((i): i is NonNullable<typeof i> => Boolean(i));
        }

        const investigationLeads = results.slice(0, 5).map((r) => {
          let leadType = 'general_reference';
          try {
            const parsed = new URL(r.url);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();
            if (host.includes('github.com') || host.includes('gitlab.com')) {
              leadType = (path.includes('/issues') || path.includes('/pull')) ? 'issue_tracker' : (path.includes('/releases') ? 'release_notes' : 'source_repository');
            } else if (host.startsWith('docs.') || path.includes('/docs/') || path.includes('/api/') || host.includes('nodejs.org') || host.includes('readthedocs') || host.includes('developer.mozilla.org')) {
              leadType = 'official_documentation';
            } else if (host.includes('stackoverflow.com') || host.includes('stackexchange.com')) {
              leadType = 'community_solution';
            } else if (host.includes('npmjs.com') || host.includes('pypi.org') || host.includes('crates.io')) {
              leadType = 'package_registry';
            }
          } catch {
            leadType = 'general_reference';
          }
          return {
            url: r.url,
            title: r.title,
            leadType,
            suggestedAction: `Use web_fetch(url="${r.url}") for complete documentation and code extraction.`,
          };
        });

        return {
          provider: 'searxng',
          query: queries[0],
          queries,
          queryCount: queries.length,
          successfulQueries: successes.length,
          page: clampInteger(args.page, 1, 1, MAX_PAGE),
          returnedResults: results.length,
          ...(estimatedTotals.length > 0
            ? { estimatedTotalResults: Math.max(...estimatedTotals) }
            : {}),
          results,
          answers: mergeUniqueStrings(successes.map(({ payload }) => payload.answers)),
          corrections: mergeUniqueStrings(successes.map(({ payload }) => payload.corrections)),
          suggestions: mergeUniqueStrings(successes.map(({ payload }) => payload.suggestions)),
          unresponsiveEngines,
          queryErrors: failures.map((failure) => ({ query: failure.query, ...failure.error })),
          investigationLeads,
          ...(extractedTopContent && extractedTopContent.length > 0 ? { extractedTopContent } : {}),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
