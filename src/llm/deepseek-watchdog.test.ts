import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepseekLLM } from './deepseek.js';
import { Session } from '../session/session.js';

test('a stalled SSE stream is cut as transport_eof with partial text preserved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Partial "}}]}\n\n'));
      // Never enqueue [DONE] and never close: simulates a stalled stream.
    },
  }));
  try {
    const session = new Session(); session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'm', undefined, 'https://example.test/v1');
    let settled = false;
    const pending = client.generate(session, []).then(
      (r) => { settled = true; return r; },
      (e) => { settled = true; throw e; },
    );
    // Let the request run until it parks on the stalled read.
    for (let i = 0; i < 50 && !settled; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'client must still wait on the stalled stream');
    t.mock.timers.tick(15 * 60 * 1000 + 1000);
    const result = await pending;
    assert.equal(result.finishReason, 'transport_eof');
    assert.equal(result.text, 'Partial ');
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

test('a mid-chunk stall drops the unparseable tail instead of throwing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      // Truncated JSON with no newline: stays in the decoder buffer, then silence.
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hel'));
    },
  }));
  try {
    const session = new Session(); session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'm', undefined, 'https://example.test/v1');
    let settled = false;
    const pending = client.generate(session, []).then(
      (r) => { settled = true; return r; },
      (e) => { settled = true; throw e; },
    );
    for (let i = 0; i < 50 && !settled; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'client must still wait on the stalled stream');
    t.mock.timers.tick(15 * 60 * 1000 + 1000);
    const result = await pending;
    assert.equal(result.finishReason, 'transport_eof');
    assert.equal(result.text, undefined);
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

test('headerTimeoutMs triggers HeaderTimeoutError when initial headers stall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_, reject) => {
    // Simulates an endpoint that never sends HTTP headers until aborted
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  try {
    const session = new Session();
    session.addUserMessage('hi');
    const client = new DeepseekLLM({
      apiKey: 'k',
      baseURL: 'https://example.test/v1',
      headerTimeoutMs: 3000,
      maxRetries: 0,
    });

    let caughtError: any;
    const pending = client.generate(session, []).catch((e) => {
      caughtError = e;
      return null;
    });

    for (let i = 0; i < 50 && !caughtError; i++) await new Promise((r) => setImmediate(r));
    assert.equal(caughtError, undefined, 'must still be waiting before header timeout');

    t.mock.timers.tick(3001);
    await pending;

    assert.ok(caughtError, 'header timeout must throw an error');
    const err: any = caughtError;
    assert.equal(err.name, 'HeaderTimeoutError');
    assert.equal(err.statusCode, 408);
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

test('custom chunkTimeoutMs cuts stalled stream according to configured threshold', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Fast "}}]}\n\n'));
    },
  }));
  try {
    const session = new Session();
    session.addUserMessage('hi');
    const client = new DeepseekLLM({
      apiKey: 'k',
      baseURL: 'https://example.test/v1',
      chunkTimeoutMs: 5000,
    });

    let settled = false;
    const pending = client.generate(session, []).then(
      (r) => { settled = true; return r; },
      (e) => { settled = true; throw e; },
    );

    for (let i = 0; i < 50 && !settled; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false);

    // 5 seconds tick should trigger the custom chunkTimeout watchdog
    t.mock.timers.tick(5001);
    const result = await pending;
    assert.equal(result.finishReason, 'transport_eof');
    assert.equal(result.text, 'Fast ');
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

test('local baseURL defaults chunkTimeout to 0 (disabled for local inference)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Local "}}]}\n\n'));
    },
  }));
  try {
    const session = new Session();
    session.addUserMessage('hi');
    // Local Ollama/vLLM URL
    const client = new DeepseekLLM('k', 'm', undefined, 'http://127.0.0.1:11434/v1');

    let settled = false;
    const pending = client.generate(session, []).then(
      (r) => { settled = true; return r; },
      (e) => { settled = true; throw e; },
    );

    for (let i = 0; i < 50 && !settled; i++) await new Promise((r) => setImmediate(r));
    assert.equal(settled, false);

    // Even ticking past 15 minutes should NOT cut the stream because chunkTimeout is disabled for local
    t.mock.timers.tick(16 * 60 * 1000);
    assert.equal(settled, false, 'stream must not be cut on local URL');
  } finally {
    globalThis.fetch = original;
    t.mock.timers.reset();
  }
});

test('tracks timeToFirstTokenMs and requestDurationMs in usage statistics', async (t) => {
  const original = globalThis.fetch;
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n'));
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }));
  try {
    const session = new Session();
    session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'm', undefined, 'https://example.test/v1');

    const result = await client.generate(session, []);
    assert.equal(result.finishReason, 'unknown');
    assert.equal(result.reasoningContent, 'Thinking...');
    assert.equal(result.text, 'Answer');
    assert.ok(result.usage);
    assert.ok(typeof result.usage.timeToFirstTokenMs === 'number');
    assert.ok(typeof result.usage.requestDurationMs === 'number');
    assert.ok(result.usage.requestDurationMs >= result.usage.timeToFirstTokenMs);
  } finally {
    globalThis.fetch = original;
  }
});

