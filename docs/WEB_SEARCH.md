# Self-hosted web search

The `web_search` tool uses [SearXNG](https://docs.searxng.org/) as its backend. SearXNG fits this project because it is free/open-source, self-hostable, exposes a small HTTP API, and does not require another Node.js SDK. The tool uses the built-in `fetch` available in the project's Node.js runtime.

The backend URL is operator-controlled through `SEARXNG_BASE_URL`; it is never accepted as a model argument. This keeps the tool focused on search and prevents the model from using it as an arbitrary HTTP client.

Search queries leave the agent process and are sent to the configured SearXNG instance and its enabled upstream engines. Search titles and snippets are untrusted external content; the system prompt tells the model to use them as evidence leads, not as instructions.

## Start the bundled local instance

Docker Desktop or another Docker Compose-compatible runtime is required.

```bash
docker compose -f deploy/searxng/compose.yaml up -d
```

The bundled service only binds to `127.0.0.1:8080`. For any non-local deployment, set a strong `SEARXNG_SECRET`, place SearXNG behind appropriate access controls, and point the agent at its HTTPS URL.

Configure the agent in `.env`:

```env
SEARXNG_BASE_URL=http://127.0.0.1:8080
WEB_SEARCH_TIMEOUT_MS=15000
```

Then start the CLI normally:

```bash
npm run dev
```

The npm `predev` lifecycle automatically runs `npm run search:up` first. If the Docker daemon is not available, the startup script attempts to launch Docker Desktop and waits for the engine before invoking Compose. Docker Compose uses detached mode (`-d`), so SearXNG keeps running in the background while the CLI starts. Re-running `npm run dev` is safe when the container is already running. `web_search` is registered by `SearchPlugin` and is included in the function declarations sent to the selected LLM.

## How the LLM decides to search

`SearchPlugin` registers a dedicated `web-search-decision-policy` system-prompt section alongside the tool schema. The policy tells the model to search when:

- the user explicitly asks it to browse, search, verify online, or provide sources;
- the answer depends on current or changeable information such as releases, documentation, prices, schedules, policies, security advisories, or recommendations;
- a referenced online page or document is not available locally;
- an uncertain or niche external claim needs primary-source evidence.

It also tells the model not to search for local-code questions, deterministic calculations, facts already proven by available context, stable general knowledge, or when the user forbids browsing. Query guidance favors focused searches, structured keyword filters, useful synonym variants, and official/primary sources, while the result-handling rules treat snippets as untrusted evidence rather than instructions.

This is prompt/tool-use training rather than model-weight fine-tuning: each LLM request receives both the detailed tool description and the plugin policy, allowing supported Gemini and OpenAI-compatible models to decide whether to emit a `web_search` function call.

Stop the local instance with:

```bash
docker compose -f deploy/searxng/compose.yaml down
```

## JSON API requirement

SearXNG only returns JSON when `json` is enabled in `search.formats`. The bundled `settings.yml` already enables it. For an existing instance, use:

```yaml
search:
  formats:
    - html
    - json
```

The upstream API supports the `/search` endpoint with `q`, `format`, `language`, `categories`, `pageno`, `time_range`, and `safesearch`. See the official [Search API reference](https://docs.searxng.org/dev/search_api.html), [search syntax reference](https://docs.searxng.org/user/search-syntax.html), and [container installation guide](https://docs.searxng.org/admin/installation-docker.html).

## Tool parameters

- `query` (required): the primary search text; raw operators remain available when needed.
- `keywords`: additional concepts applied to every query variant.
- `exact_phrases`: phrases quoted for exact matching.
- `exclude_keywords`: words or phrases prefixed with `-` to reduce noise.
- `site_domains`: domains compiled to `site:` filters; multiple domains are combined with `OR`.
- `file_types`: extensions compiled to `filetype:` filters; multiple types are combined with `OR`.
- `engine_shortcuts`: configured SearXNG shortcuts such as `github`, `arxiv`, or `news`, compiled using the official `!shortcut` syntax.
- `additional_queries`: up to four synonym, spelling, terminology, or language variants. The tool applies the same filters, runs the searches concurrently, removes duplicate URLs, and ranks recurring results higher using reciprocal-rank fusion.
- `max_results`: 1-20 merged results returned to the model; default 8.
- `language`: language code such as `vi`, `en-US`, or `all`.
- `categories`: comma-separated SearXNG categories such as `general,news`.
- `time_range`: `day`, `month`, or `year`.
- `safe_search`: `0` off, `1` moderate, or `2` strict; default 1.
- `page`: result page 1-20; default 1.

The structured operators are passed through SearXNG to its upstream engines, so `site:` and `filetype:` behavior can vary between engines. SearXNG `!shortcut` selection is native syntax and requires the shortcut to exist on the configured instance. External `!!` bangs and redirects are intentionally not exposed as structured options because they bypass the configured metasearch flow.

Example advanced call:

```json
{
  "query": "TypeScript agent framework",
  "keywords": ["tool calling", "self-hosted"],
  "exact_phrases": ["function calling"],
  "exclude_keywords": ["course"],
  "site_domains": ["github.com", "npmjs.com"],
  "engine_shortcuts": ["github"],
  "additional_queries": ["Node.js autonomous agent", "LLM tool registry"],
  "time_range": "year",
  "max_results": 10
}
```

The response includes the compiled `queries`, `matchedQueries` for every result, a `reciprocalRankScore`, and per-variant `queryErrors` when only part of a multi-query search fails. The tool has a bounded timeout, trims oversized snippets, and returns stable error codes for unavailable instances, timeouts, rate limits, malformed responses, and disabled JSON output.
