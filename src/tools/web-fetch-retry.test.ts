import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebFetchTool } from './web-fetch.js';

test('429 fetch is marked retryable with hint', async () => {
  const tool = createWebFetchTool({
    fetchImpl: (async () => ({
      ok: false, status: 429, statusText: 'Too Many Requests',
      headers: { get: () => 'text/html' },
    })) as any,
  });
  const res = await tool.execute({ url: 'https://example.com/x', bypass_cache: true }, undefined as any);
  assert.equal(res.errorCode, 'HTTP_FETCH_ERROR');
  assert.equal(res.retryable, true);
  assert.ok(String(res.hint || res.error).toLowerCase().includes('retr'), `expected retry hint in ${JSON.stringify(res)}`);
});

test('oversized response stream is bounded at 5MB', async () => {
  const tool = createWebFetchTool({
    fetchImpl: (async () => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '6000000' : 'text/html' },
    })) as any,
  });
  const res = await tool.execute({ url: 'https://example.com/oversized', bypass_cache: true }, undefined as any);
  assert.equal(res.errorCode, 'RESPONSE_TOO_LARGE');
});

test('HTTP 304 reuses cached document without re-downloading', async () => {
  let callCount = 0;
  const requests: Array<{ headers: Record<string, string> }> = [];
  const tool = createWebFetchTool({
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      callCount++;
      requests.push({ headers: (init?.headers as Record<string, string>) || {} });
      if (callCount === 1) {
        return new Response('<h1>Original Title</h1><p>Cached content</p>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'etag': '"abc-123"',
            'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
          },
        });
      }
      return new Response(null, { status: 304, statusText: 'Not Modified' });
    }) as typeof fetch,
    cacheTtlMs: 0, // force TTL expired so conditional request fires
  });

  const res1 = await tool.execute({ url: 'https://example.com/cached-page' }, undefined as any);
  assert.match(res1.content, /Cached content/);

  const res2 = await tool.execute({ url: 'https://example.com/cached-page' }, undefined as any);
  assert.match(res2.content, /Cached content/);
  assert.equal(callCount, 2);
  assert.equal(requests[1].headers['If-None-Match'], '"abc-123"');
  assert.equal(requests[1].headers['Accept-Encoding'], 'gzip, deflate, br');
});
