import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { getGitHubCredential } from './github-credential.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LENGTH = 4_000;
const MAX_ALLOWED_LENGTH = 50_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

export interface WebFetchToolOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  githubCredentialProvider?: () => Promise<string | undefined>;
}

/** GCM credentials are only sent to the GitHub REST API, never to a browser URL or redirect. */
function githubApiUrl(input: URL): URL | undefined {
  if (input.protocol !== 'https:' || input.port || input.username || input.password || input.hash) return undefined;
  if ([...input.searchParams.keys()].some((key) => /token|secret|password|api[_-]?key|auth/i.test(key))) return undefined;
  if (input.hostname === 'api.github.com' && /^\/repos\/[^/]+\/[^/]+(?:\/|$)/.test(input.pathname)) return input;
  if (input.hostname !== 'github.com' || input.search) return undefined;
  const segments = input.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const [owner, repo, type, ref, ...rest] = segments;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  if (!type && !ref) return new URL(`https://api.github.com/repos/${owner}/${repo}/contents`);
  if ((type === 'blob' || type === 'tree') && ref && (type === 'tree' || rest.length)) {
    const suffix = rest.length ? `/${rest.map(encodeURIComponent).join('/')}` : '';
    return new URL(`https://api.github.com/repos/${owner}/${repo}/contents${suffix}?ref=${encodeURIComponent(ref)}`);
  }
  if ((type === 'issues' || type === 'pull') && /^\d+$/.test(ref) && rest.length === 0) {
    return new URL(`https://api.github.com/repos/${owner}/${repo}/${type === 'pull' ? 'pulls' : 'issues'}/${ref}`);
  }
  return undefined;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

interface CachedPage {
  url: string;
  markdown: string;
  text: string;
  codeBlocks: string[];
  title: string;
  contentType: string;
  statusCode: number;
  fetchedAt: number;
}

const memoryCache = new Map<string, CachedPage>();

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCharCode(Number(code));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return '';
      }
    });
}

function sanitizeHtmlForExtraction(html: string): string {
  // Strip comments
  let sanitized = html.replace(/<!--[\s\S]*?-->/g, ' ');
  // Strip scripts, styles, noscript, svg, canvas, iframe, head
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  sanitized = sanitized.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  sanitized = sanitized.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
  sanitized = sanitized.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ');
  sanitized = sanitized.replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, ' ');
  return sanitized;
}

export function extractCodeBlocksFromHtml(html: string): string[] {
  const codeBlocks: string[] = [];
  const preCodeRegex = /<pre\b[^>]*>(?:<code\b(?:\s+class="[^"]*language-([^"\s]+)[^"]*")?[^>]*>)?([\s\S]*?)<\/code><\/pre>|<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;
  let match: RegExpExecArray | null;

  while ((match = preCodeRegex.exec(html)) !== null) {
    const lang = match[1] || '';
    const rawContent = match[2] ?? match[3] ?? '';
    const cleanContent = decodeHtmlEntities(rawContent.replace(/<[^>]+>/g, '')).trim();
    if (cleanContent.length > 0) {
      codeBlocks.push(lang ? `\`\`\`${lang}\n${cleanContent}\n\`\`\`` : `\`\`\`\n${cleanContent}\n\`\`\``);
    }
  }

  return codeBlocks;
}

export function htmlToCleanMarkdown(html: string, baseUrl?: string): { markdown: string; title: string } {
  // Extract Title
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '';

  let content = sanitizeHtmlForExtraction(html);

  // Try to find main content region
  const mainMatch = /<(?:article|main|div\s+class="[^"]*(?:markdown-body|content|documentation|post-content)[^"]*")[^>]*>([\s\S]*?)<\/(?:article|main|div)>/i.exec(content);
  if (mainMatch && mainMatch[1].length > 200) {
    content = mainMatch[1];
  }

  // Pre-process code blocks
  content = content.replace(/<pre\b[^>]*><code\b(?:\s+class="[^"]*language-([^"\s]+)[^"]*")?[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, lang, code) => {
    const clean = decodeHtmlEntities(code.replace(/<[^>]+>/g, '')).trim();
    return `\n\n\`\`\`${lang || ''}\n${clean}\n\`\`\`\n\n`;
  });
  content = content.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const clean = decodeHtmlEntities(code.replace(/<[^>]+>/g, '')).trim();
    return `\n\n\`\`\`\n${clean}\n\`\`\`\n\n`;
  });
  content = content.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    const clean = decodeHtmlEntities(code.replace(/<[^>]+>/g, '')).trim();
    return ` \`${clean}\` `;
  });

  // Convert Headings
  content = content.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, text) => `\n\n# ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}\n\n`);
  content = content.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, text) => `\n\n## ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}\n\n`);
  content = content.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_, text) => `\n\n### ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}\n\n`);
  content = content.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_, text) => `\n\n#### ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}\n\n`);
  content = content.replace(/<h[56]\b[^>]*>([\s\S]*?)<\/h[56]>/gi, (_, text) => `\n\n##### ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}\n\n`);

  // Convert Lists
  content = content.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n* ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}`);
  content = content.replace(/<\/(?:ul|ol)>/gi, '\n');

  // Convert Links
  content = content.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const linkText = decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim();
    if (!linkText) return '';
    let resolvedHref = href;
    if (baseUrl && href.startsWith('/')) {
      try {
        resolvedHref = new URL(href, baseUrl).toString();
      } catch {
        // fallback
      }
    }
    return `[${linkText}](${resolvedHref})`;
  });

  // Convert Bold & Italic
  content = content.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  content = content.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // Convert Blockquotes & Paragraphs
  content = content.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) => `\n> ${decodeHtmlEntities(text.replace(/<[^>]+>/g, '')).trim()}\n\n`);
  content = content.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  content = content.replace(/<br\s*\/?>/gi, '\n');
  content = content.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip remaining HTML tags
  content = content.replace(/<[^>]+>/g, ' ');

  // Decode entities & normalize whitespace
  content = decodeHtmlEntities(content);
  content = content
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown: content, title };
}

function detectPromptInjectionSignals(text: string): string[] {
  const flags: string[] = [];
  const lower = text.toLowerCase();

  if (/ignore\s+(all\s+)?(previous|prior)\s+(instructions|directives|rules)/i.test(lower)) {
    flags.push('SUSPICIOUS_PROMPT_INJECTION_OVERRIDE_INSTRUCTION');
  }
  if (/you\s+are\s+now\s+in\s+developer\s+mode/i.test(lower)) {
    flags.push('SUSPICIOUS_DEVELOPER_MODE_JAILBREAK');
  }
  if (/reveal\s+(the\s+)?(system\s+prompt|api[_\s-]?key|secret|password)/i.test(lower)) {
    flags.push('SUSPICIOUS_SECRET_LEAK_ATTEMPT');
  }
  if (/execute\s+(this\s+)?(bash|shell|command|rm\s+-rf|del\s+\/f)/i.test(lower)) {
    flags.push('SUSPICIOUS_COMMAND_EXECUTION_PAYLOAD');
  }

  return flags;
}

/**
 * Creates the web_fetch tool according to the OpenAI Codex agentic harness philosophy.
 * Enables deep document inspection, code extraction, clean markdown rendering, and untrusted-content isolation.
 */
export function createWebFetchTool(options: WebFetchToolOptions = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const githubCredentialProvider = options.githubCredentialProvider ?? getGitHubCredential;

  return {
    name: 'web_fetch',
    description:
      'Fetch public webpages and GitHub URLs. For private GitHub repositories (root/tree/blob), issues, PRs, or REST API endpoints, set github_auth="gcm" after the user has signed in to Git Credential Manager on the host. Credentials remain in the harness; never put tokens in a URL or command. Authenticated tree/blob URLs support a single-segment ref; they do not follow redirects or use shared caches.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: 'The HTTP or HTTPS URL to fetch content from.',
        },
        Url: {
          type: Type.STRING,
          description: 'Alias for url (Google Antigravity CLI standard casing).',
        },
        extract_mode: {
          type: Type.STRING,
          description: 'Extraction mode: "markdown" for full cleaned markdown, "code_blocks" for extracted code blocks only, or "text" for stripped text.',
          enum: ['markdown', 'code_blocks', 'text'],
        },
        selector: {
          type: Type.STRING,
          description: 'Optional focus selector tag or keyword (e.g. "article", "main", "markdown-body", "code").',
        },
        offset: {
          type: Type.NUMBER,
          description: 'Character offset for paginating through long documents (default 0).',
        },
        max_length: {
          type: Type.NUMBER,
          description: `Maximum content length in characters to return (default ${DEFAULT_MAX_LENGTH}, maximum ${MAX_ALLOWED_LENGTH}).`,
        },
        bypass_cache: {
          type: Type.BOOLEAN,
          description: 'Set to true to force a fresh fetch from the network and bypass in-memory cache.',
        },
        github_auth: {
          type: Type.STRING,
          description: '"none" (default) for public URLs, or "gcm" to use the host Git Credential Manager for an authenticated GitHub REST API request. Never supply a token.',
          enum: ['none', 'gcm'],
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const rawUrl = String(args.url || args.Url || '').trim();
      if (!rawUrl) {
        return { error: 'Parameter "url" (or "Url") is required and must not be empty.', errorCode: 'INVALID_URL' };
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return { error: 'Only HTTP and HTTPS URLs are supported.', errorCode: 'INVALID_PROTOCOL' };
        }
        if (parsedUrl.username || parsedUrl.password) {
          return { error: 'Credentials must not be included in a URL.', errorCode: 'CREDENTIAL_IN_URL' };
        }
      } catch {
        return { error: 'Invalid URL format.', errorCode: 'MALFORMED_URL' };
      }

      const githubAuth = args.github_auth === 'gcm';
      if (args.github_auth !== undefined && !['none', 'gcm'].includes(args.github_auth)) {
        return { error: 'Unsupported github_auth option.', errorCode: 'INVALID_GITHUB_AUTH' };
      }
      const apiUrl = githubAuth ? githubApiUrl(parsedUrl) : undefined;
      if (githubAuth && !apiUrl) {
        return { error: 'GCM authentication is only supported for HTTPS GitHub repository/tree/blob/issue/PR URLs or api.github.com/repos endpoints.', errorCode: 'UNSUPPORTED_GITHUB_AUTH_URL' };
      }
      const canonicalUrl = parsedUrl.toString();
      const extractMode = args.extract_mode || 'markdown';
      const offset = Math.max(0, Number(args.offset) || 0);
      const maxLength = Math.min(MAX_ALLOWED_LENGTH, Math.max(10, Number(args.max_length) || DEFAULT_MAX_LENGTH));
      const bypassCache = Boolean(args.bypass_cache);

      const now = Date.now();
      let cached = githubAuth ? undefined : memoryCache.get(canonicalUrl);

      if (!cached || bypassCache || (now - cached.fetchedAt > cacheTtlMs)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const token = githubAuth ? await githubCredentialProvider() : undefined;
          if (githubAuth && !token) {
            return { error: 'No GitHub credential is available in Git Credential Manager. Sign in on the host first.', errorCode: 'GITHUB_CREDENTIAL_UNAVAILABLE' };
          }
          const response = await fetchImpl(githubAuth ? apiUrl!.toString() : canonicalUrl, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CodingAgent-DeepInvestigator/2.0',
              Accept: githubAuth ? 'application/vnd.github.raw+json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
            ...(githubAuth ? { redirect: 'manual' as const } : {}),
          });

          if (githubAuth && response.status >= 300 && response.status < 400) {
            return { error: 'Authenticated GitHub redirects are not followed.', errorCode: 'GITHUB_REDIRECT_BLOCKED' };
          }

          if (!response.ok) {
            return {
              error: githubAuth ? `GitHub API returned HTTP ${response.status}.` : `HTTP request failed with status ${response.status} ${response.statusText}`,
              errorCode: githubAuth && [401, 403, 404].includes(response.status) ? 'GITHUB_ACCESS_DENIED' : 'HTTP_FETCH_ERROR',
              statusCode: response.status,
              url: canonicalUrl,
            };
          }

          const contentType = response.headers.get('content-type') || 'text/html';
          if (githubAuth && Number(response.headers.get('content-length')) > 1_000_000) {
            return { error: 'GitHub response exceeds the 1 MB authenticated fetch limit.', errorCode: 'GITHUB_RESPONSE_TOO_LARGE' };
          }
          const rawBody = githubAuth ? await readBoundedBody(response, 1_000_000) : await response.text();
          if (rawBody === undefined) {
            return { error: 'GitHub response exceeds the 1 MB authenticated fetch limit.', errorCode: 'GITHUB_RESPONSE_TOO_LARGE' };
          }

          let markdownResult: { markdown: string; title: string };
          let codeBlocks: string[] = [];

          if (contentType.includes('application/json')) {
            try {
              const formattedJson = JSON.stringify(JSON.parse(rawBody), null, 2);
              markdownResult = { markdown: `\`\`\`json\n${formattedJson}\n\`\`\``, title: 'JSON Document' };
              codeBlocks = [`\`\`\`json\n${formattedJson}\n\`\`\``];
            } catch {
              markdownResult = { markdown: rawBody, title: 'Plain JSON' };
            }
          } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            markdownResult = { markdown: rawBody, title: 'Plain Document' };
            codeBlocks = extractCodeBlocksFromHtml(rawBody);
          } else {
            markdownResult = htmlToCleanMarkdown(rawBody, canonicalUrl);
            codeBlocks = extractCodeBlocksFromHtml(rawBody);
          }

          cached = {
            url: canonicalUrl,
            markdown: markdownResult.markdown,
            text: markdownResult.markdown.replace(/```[\s\S]*?```/g, '').replace(/[*_#`[\]()]/g, ' '),
            codeBlocks,
            title: markdownResult.title,
            contentType,
            statusCode: response.status,
            fetchedAt: now,
          };
          if (!githubAuth) memoryCache.set(canonicalUrl, cached);
        } catch (fetchErr: any) {
          const timedOut = fetchErr?.name === 'AbortError' || controller.signal.aborted;
          return {
            error: timedOut ? `Fetching ${canonicalUrl} timed out after ${timeoutMs}ms.` : githubAuth ? 'Authenticated GitHub request failed.' : `Failed to fetch ${canonicalUrl}: ${fetchErr?.message || String(fetchErr)}`,
            errorCode: timedOut ? 'FETCH_TIMEOUT' : 'FETCH_FAILED',
            url: canonicalUrl,
          };
        } finally {
          clearTimeout(timeout);
        }
      }

      let selectedContent = '';
      if (extractMode === 'code_blocks') {
        selectedContent = cached.codeBlocks.length > 0
          ? cached.codeBlocks.join('\n\n')
          : '(No code blocks detected in this document)';
      } else if (extractMode === 'text') {
        selectedContent = cached.text;
      } else {
        selectedContent = cached.markdown;
      }

      // Check for security / prompt injection signals
      const securityWarnings = detectPromptInjectionSignals(selectedContent);

      const totalLength = selectedContent.length;
      const windowedContent = selectedContent.slice(offset, offset + maxLength);
      const hasMore = offset + maxLength < totalLength;

      return {
        url: canonicalUrl,
        title: cached.title,
        contentType: cached.contentType,
        statusCode: cached.statusCode,
        extractMode,
        totalLength,
        offset,
        returnedLength: windowedContent.length,
        hasMore,
        nextOffset: hasMore ? offset + maxLength : undefined,
        codeBlocksCount: cached.codeBlocks.length,
        ...(securityWarnings.length > 0 ? { securityWarnings } : {}),
        content: `<!-- BEGIN UNTRUSTED WEB CONTENT FROM ${canonicalUrl} -->\n${windowedContent}\n<!-- END UNTRUSTED WEB CONTENT -->`,
      };
    },
  };
}

export function clearWebFetchCache(): void {
  memoryCache.clear();
}

/**
 * HTML to Clean Markdown conversion helper.
 */
export function htmlToMarkdown(html: string): string {
  return htmlToCleanMarkdown(html).markdown;
}

/**
 * Creates read_url_content tool (Google Antigravity CLI compatibility alias delegating to web_fetch).
 */
export function createReadUrlContentTool(options: WebFetchToolOptions = {}): ToolDefinition {
  const tool = createWebFetchTool(options);
  return {
    ...tool,
    name: 'read_url_content',
    description:
      'Fetch content from a URL via HTTP request. Converts HTML to clean markdown for fast reading without browser overhead. (Unified tool delegating to web_fetch).',
  };
}

/** Pre-instantiated default tools */
export const webFetchTool = createWebFetchTool();
export const readUrlContentTool = createReadUrlContentTool();

