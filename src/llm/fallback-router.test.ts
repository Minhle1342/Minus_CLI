import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../session/session.js';
import { FallbackRouterLLM } from './fallback-router.js';

test('a provider that already streamed text is not retried on another tier', async () => {
  let secondCalled = false;
  const router = new FallbackRouterLLM('auto-fallback', [
    {
      name: 'first', provider: 'test', tier: 1,
      createClient: () => ({
        generateStream: async (_session: unknown, _tools: unknown, callbacks?: { onContentToken?: (token: string) => void }) => {
          callbacks?.onContentToken?.('partial answer');
          throw new Error('429 rate limit');
        },
      }) as any,
    },
    {
      name: 'second', provider: 'test', tier: 2,
      createClient: () => ({
        generateStream: async () => { secondCalled = true; return { text: 'ok', toolCalls: [], finishReason: 'stop' }; },
      }) as any,
    },
  ]);

  await assert.rejects(
    () => router.generateStream(new Session(), [], { onContentToken: () => {} }),
    /429/,
  );
  assert.equal(secondCalled, false, 'failover would duplicate the streamed text');
});

test('failover still retries when nothing was streamed', async () => {
  let secondCalled = false;
  const router = new FallbackRouterLLM('auto-fallback', [
    {
      name: 'first', provider: 'test', tier: 1,
      createClient: () => ({ generateStream: async () => { throw new Error('429 rate limit'); } }) as any,
    },
    {
      name: 'second', provider: 'test', tier: 2,
      createClient: () => ({
        generateStream: async () => { secondCalled = true; return { text: 'ok', toolCalls: [], finishReason: 'stop' }; },
      }) as any,
    },
  ]);

  const response = await router.generateStream(new Session(), []);
  assert.equal(response.text, 'ok');
  assert.equal(secondCalled, true);
});
