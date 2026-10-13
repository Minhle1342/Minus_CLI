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
