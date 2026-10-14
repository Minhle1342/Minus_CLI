import test from 'node:test';
import assert from 'node:assert/strict';
import { retryWithExponentialBackoff } from './error-handling.js';
import { DeepseekLLM } from './deepseek.js';
import { Session } from '../session/session.js';

test('retryWithExponentialBackoff: backs off up to 10 retries with 10s gap cap and recovers', async () => {
  let attempts = 0;
  const recordedDelays: number[] = [];

  const result = await retryWithExponentialBackoff(
    async () => {
      attempts++;
      if (attempts < 4) {
        const err: any = new Error('Service Unavailable (503)');
        err.statusCode = 503;
        throw err;
      }
      return 'recovered-data';
    },
    {
      maxRetries: 10,
      baseDelayMs: 2000,
      maxDelayMs: 10000,
      // Dùng custom delayFn để test chạy tức thì mà vẫn xác minh được tính toán backoff
      sleepFn: async (ms: number) => {
        recordedDelays.push(ms);
      },
      jitterMs: 0, // Không jitter trong test để kiểm tra chính xác giá trị tính toán
    }
  );

  assert.equal(result, 'recovered-data');
  assert.equal(attempts, 4);
  assert.equal(recordedDelays.length, 3);
  // Attempt 1: 2000ms (2^0 * 2000)
  assert.equal(recordedDelays[0], 2000);
  // Attempt 2: 4000ms (2^1 * 2000)
  assert.equal(recordedDelays[1], 4000);
  // Attempt 3: 8000ms (2^2 * 2000)
  assert.equal(recordedDelays[2], 8000);
});

test('retryWithExponentialBackoff: respects 10s maxDelayMs gap cap for higher attempts', async () => {
  let attempts = 0;
  const recordedDelays: number[] = [];

  await retryWithExponentialBackoff(
    async () => {
      attempts++;
      if (attempts < 6) {
        const err: any = new Error('Rate limit exceeded (429)');
        err.statusCode = 429;
        throw err;
      }
      return 'ok';
    },
    {
      maxRetries: 10,
      baseDelayMs: 2000,
      maxDelayMs: 10000,
      sleepFn: async (ms: number) => {
        recordedDelays.push(ms);
      },
      jitterMs: 0,
    }
  );

  assert.equal(attempts, 6);
  assert.equal(recordedDelays.length, 5);
  // Attempt 1: 2000
  assert.equal(recordedDelays[0], 2000);
  // Attempt 2: 4000
  assert.equal(recordedDelays[1], 4000);
  // Attempt 3: 8000
  assert.equal(recordedDelays[2], 8000);
  // Attempt 4: capped at 10000 (thay vì 16000)
  assert.equal(recordedDelays[3], 10000);
  // Attempt 5: capped at 10000 (thay vì 32000)
  assert.equal(recordedDelays[4], 10000);
});

test('retryWithExponentialBackoff: respects retry-after header if provided', async () => {
  let attempts = 0;
  const recordedDelays: number[] = [];

  await retryWithExponentialBackoff(
    async () => {
      attempts++;
      if (attempts < 2) {
        const err: any = new Error('Too Many Requests');
        err.statusCode = 429;
        err.retryAfterMs = 4500;
        throw err;
      }
      return 'ok';
    },
    {
      maxRetries: 3,
      baseDelayMs: 2000,
      sleepFn: async (ms: number) => {
        recordedDelays.push(ms);
      },
    }
  );

  assert.equal(attempts, 2);
  assert.equal(recordedDelays[0], 4500);
});

test('DeepseekLLM: automatically retries transient 503 and network disruptions, invoking onRetry callback', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  const retryEvents: any[] = [];
  const enc = new TextEncoder();

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      // Lần 1: HTTP 503 Service Unavailable
      return new Response('Service Unavailable (Overloaded)', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'retry-after': '1' },
      });
    }
    if (callCount === 2) {
      // Lần 2: Network drop (Fetch failed)
      throw new TypeError('fetch failed: socket hang up');
    }
    // Lần 3: Phục hồi thành công với SSE stream
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Phục hồi thành công!"}}]}\n\n'));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200 }
    );
  };

  try {
    const session = new Session();
    session.addUserMessage('Xin chào');

    const client = new DeepseekLLM({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com',
      maxRetries: 5,
    });

    const response = await client.generateStream(
      session,
      [],
      {
        onRetry: (payload) => {
          retryEvents.push(payload);
        },
      }
    );

    assert.equal(response.text, 'Phục hồi thành công!');
    assert.equal(callCount, 3);
    assert.equal(retryEvents.length, 2);
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[1].attempt, 2);
    assert.equal(retryEvents[0].maxRetries, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
