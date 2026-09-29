import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebFetchTool, clearWebFetchCache } from './web-fetch.js';

test('private GitHub blob URL uses GCM credential only on the REST API and never caches it', async () => {
  clearWebFetchCache();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const tool = createWebFetchTool({
    githubCredentialProvider: async () => 'private-secret-test-token',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response('private data', { headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch,
  });
  const args = { url: 'https://github.com/acme/secret/blob/main/README.md', github_auth: 'gcm' };
  const first = await tool.execute(args, {} as any);
  const second = await tool.execute(args, {} as any);
  assert.match(first.content, /private data/);
  assert.match(second.content, /private data/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.github.com/repos/acme/secret/contents/README.md?ref=main');
  assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, 'Bearer private-secret-test-token');
  assert.equal(requests[0].init?.redirect, 'manual');
  assert.doesNotMatch(JSON.stringify(first), /private-secret-test-token/);
});

test('GCM auth rejects non-GitHub destinations, redirects, and embedded credentials', async () => {
  let calls = 0;
  const tool = createWebFetchTool({
    githubCredentialProvider: async () => 'secret-test-token',
    fetchImpl: (async () => { calls++; return Response.redirect('https://evil.example/collect', 302); }) as typeof fetch,
  });
  assert.equal((await tool.execute({ url: 'https://evil.example/', github_auth: 'gcm' }, {} as any)).errorCode, 'UNSUPPORTED_GITHUB_AUTH_URL');
  assert.equal((await tool.execute({ url: 'https://user:pass@api.github.com/repos/a/b/contents/file', github_auth: 'gcm' }, {} as any)).errorCode, 'CREDENTIAL_IN_URL');
  const redirected = await tool.execute({ url: 'https://api.github.com/repos/a/b/contents/file', github_auth: 'gcm' }, {} as any);
  assert.equal(redirected.errorCode, 'GITHUB_REDIRECT_BLOCKED');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(redirected), /secret-test-token/);
});

test('missing GCM credential and GitHub access denial return safe errors', async () => {
  let calls = 0;
  const noCredential = createWebFetchTool({
    githubCredentialProvider: async () => undefined,
    fetchImpl: (async () => { calls++; return new Response('unexpected'); }) as typeof fetch,
  });
  assert.equal((await noCredential.execute({ url: 'https://api.github.com/repos/a/b/issues/1', github_auth: 'gcm' }, {} as any)).errorCode, 'GITHUB_CREDENTIAL_UNAVAILABLE');
  assert.equal(calls, 0);
  const denied = createWebFetchTool({
    githubCredentialProvider: async () => 'secret-test-token',
    fetchImpl: (async () => new Response('secret-test-token', { status: 403 })) as typeof fetch,
  });
  const result = await denied.execute({ url: 'https://github.com/a/b/issues/1', github_auth: 'gcm' }, {} as any);
  assert.equal(result.errorCode, 'GITHUB_ACCESS_DENIED');
  assert.doesNotMatch(JSON.stringify(result), /secret-test-token/);
});

test('repository URL reads root contents and bounds authenticated response size', async () => {
  const urls: string[] = [];
  const tool = createWebFetchTool({
    githubCredentialProvider: async () => 'secret-test-token',
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return new Response('x'.repeat(1_000_001), { headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch,
  });
  const result = await tool.execute({ url: 'https://github.com/acme/private', github_auth: 'gcm' }, {} as any);
  assert.equal(result.errorCode, 'GITHUB_RESPONSE_TOO_LARGE');
  assert.deepEqual(urls, ['https://api.github.com/repos/acme/private/contents']);
});

test('authenticated requests do not reuse public cache entries for the same URL', async () => {
  clearWebFetchCache();
  let fetches = 0;
  const tool = createWebFetchTool({
    githubCredentialProvider: async () => 'secret-test-token',
    fetchImpl: (async () => new Response(++fetches === 1 ? 'public entry' : 'private entry', {
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch,
  });
  const url = 'https://api.github.com/repos/acme/private/issues/1';
  const publicResult = await tool.execute({ url }, {} as any);
  const privateResult = await tool.execute({ url, github_auth: 'gcm' }, {} as any);
  assert.match(publicResult.content, /public entry/);
  assert.match(privateResult.content, /private entry/);
  assert.equal(fetches, 2);
});
