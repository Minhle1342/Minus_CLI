import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMojeekHtml, createWebSearchTool, fetchMojeekSearch } from './web-search.js';

test('parseMojeekHtml extracts title, url and snippet from Mojeek HTML results', () => {
  const html = `
    <html><body>
      <article class="result webp result-standard webp-result">
        <h2><a href="https://example.com/page" class="title">Example Page</a></h2>
        <p class="snippet">This is a snippet about example page content.</p>
      </article>
      <article class="result webp result-standard webp-result">
        <h2><a href="https://example2.com/page" class="title">Second Page</a></h2>
        <p class="snippet">Second snippet text here.</p>
      </article>
    </body></html>`;
  const results = parseMojeekHtml(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Example Page');
  assert.equal(results[0].url, 'https://example.com/page');
  assert.equal(results[0].snippet, 'This is a snippet about example page content.');
  assert.equal(results[1].title, 'Second Page');
  assert.equal(results[1].url, 'https://example2.com/page');
});

test('parseMojeekHtml returns empty array when no results', () => {
  const results = parseMojeekHtml('<html><body>No results found.</body></html>');
  assert.deepEqual(results, []);
});

test('parseMojeekHtml skips results missing title or url', () => {
  const html = `
    <html><body>
      <article class="result webp result-standard webp-result">
        <h2><a class="title">No URL</a></h2>
        <p class="snippet">Snippet without URL</p>
      </article>
      <article class="result webp result-standard webp-result">
        <p class="snippet">Snippet without title/link</p>
      </article>
    </body></html>`;
  const results = parseMojeekHtml(html);
  assert.deepEqual(results, []);
});

test('fetchMojeekSearch detects captcha HTML and returns clear error', async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><body>Captcha<br>JavaScript is required to complete this challenge. Please enable it and reload.</body></html>',
  } as any)) as any;
  const res = await fetchMojeekSearch('test', { fetchImpl, timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /captcha/i);
  assert.equal(res.results.length, 0);
});

test('provider mojeek returns mojeek results without searxng', async () => {
  const html = `
    <html><body>
      <article class="result webp result-standard webp-result">
        <h2><a href="https://mojeek.example.com/page" class="title">Mojeek Page</a></h2>
        <p class="snippet">Mojeek snippet.</p>
        </article>
      </body></html>`;
  const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => html } as any)) as any;
  const tool = createWebSearchTool({ fetchImpl });
  const res = await tool.execute({ query: 'test', provider: 'mojeek' }, undefined as any);
  assert.equal(res.provider, 'mojeek');
  assert.equal(res.results[0].title, 'Mojeek Page');
  assert.equal(res.results[0].url, 'https://mojeek.example.com/page');
});

test('provider duckduckgo returns duckduckgo results without searxng', async () => {
  const html = `
    <html><body>
      <div class="result results_links">
        <a class="result__a" href="https://duck.example.com/page?uddg=https%3A%2F%2Fexample.com%2Fpage">Duck Page</a>
        <a class="result__snippet">Duck snippet.</a>
      </div>
    </body></html>`;
  const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => html } as any)) as any;
  const tool = createWebSearchTool({ fetchImpl });
  const res = await tool.execute({ query: 'test', provider: 'duckduckgo' }, undefined as any);
  assert.equal(res.provider, 'duckduckgo');
  assert.equal(res.results[0].title, 'Duck Page');
});

test('invalid provider returns INVALID_PROVIDER error', async () => {
  const tool = createWebSearchTool();
  const res = await tool.execute({ query: 'test', provider: 'bing' }, undefined as any);
  assert.equal(res.errorCode, 'INVALID_PROVIDER');
});

test('provider mojeek with no results returns MOJEEK_NO_RESULTS and is retryable', async () => {
  const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => '<html><body>No results.</body></html>' } as any)) as any;
  const tool = createWebSearchTool({ fetchImpl });
  const res = await tool.execute({ query: 'test', provider: 'mojeek' }, undefined as any);
  assert.equal(res.errorCode, 'MOJEEK_NO_RESULTS');
  assert.equal(res.retryable, true);
  assert.match(res.hint ?? '', /provider khác/);
});
