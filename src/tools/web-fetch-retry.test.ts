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
