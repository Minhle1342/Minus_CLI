import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchTool } from './web-search.js';

test('fetch_top_content extracts top 2 results, not just top 1', async () => {
  const tool = createWebSearchTool({
    fetchImpl: (async (url: any) => {
      const s = String(url);
      if (s.includes('127.0.0.1')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            results: [
              { title: 'a', url: 'https://example.com/a', content: 'sa' },
              { title: 'b', url: 'https://example.com/b', content: 'sb' },
            ],
          }),
        };
      }
      return {
        ok: true, status: 200,
        text: async () => `<html><head><title>T</title></head><body><p>content of ${s}</p></body></html>`,
      };
    }) as any,
  });
  const res = await tool.execute({ query: 'q', format: 'concise', fetch_top_content: true }, undefined as any);
  assert.equal(res.extractedTopContent?.length, 2);
});
