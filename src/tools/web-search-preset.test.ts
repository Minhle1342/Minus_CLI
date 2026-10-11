import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearchTool } from './web-search.js';

function captureTool() {
  const seen: string[] = [];
  const tool = createWebSearchTool({
    fetchImpl: (async (url: any) => {
      seen.push(String(url));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ results: [] }) };
    }) as any,
  });
  return { tool, seen };
}

test('preset code maps to github/stackoverflow shortcuts', async () => {
  const { tool, seen } = captureTool();
  await tool.execute({ query: 'SearXNG json', preset: 'code', format: 'concise' }, undefined as any);
  assert.ok(seen.length > 0, 'should request SearXNG');
  const q = seen[0];
  assert.ok(q.includes('!github') || q.includes('github'), `expected github shortcut in ${q}`);
});

test('preset news maps to news category', async () => {
  const { tool, seen } = captureTool();
  await tool.execute({ query: 'release', preset: 'news', format: 'concise' }, undefined as any);
  assert.ok(seen[0].includes('categories%3Dnews') || seen[0].includes('categories=news'), `expected news category in ${seen[0]}`);
});

test('preset science maps to arxiv engine', async () => {
  const { tool, seen } = captureTool();
  await tool.execute({ query: 'retrieval', preset: 'science', format: 'concise' }, undefined as any);
  assert.ok(seen[0].includes('arxiv'), `expected arxiv shortcut in ${seen[0]}`);
});
