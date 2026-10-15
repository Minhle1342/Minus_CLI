import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiWebBridge, GEMINI_WEB_SELECTORS, type IWebTransport } from './gemini-web-bridge.js';

class MockTransport implements IWebTransport {
  constructor(private chunks: string[]) {}
  async *send(_payload: string): AsyncIterable<string> {
    for (const c of this.chunks) yield c;
  }
  async cancel(): Promise<void> {}
}

test('bridge streams tokens and serializes concurrent runs', async () => {
  const bridge = new GeminiWebBridge(new MockTransport(['he', 'llo']));
  const seen: string[] = [];
  const out = await bridge.run('payload', (t) => seen.push(t));
  assert.equal(out, 'hello');
  assert.equal(seen.join(''), 'hello');
});

test('bridge aborts in-flight run', async () => {
  const bridge = new GeminiWebBridge(new MockTransport(['a', 'b']));
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => bridge.run('x', undefined, c.signal), /abort/i);
});

test('bridge cancels stuck transport on mid-run abort and exposes selectors', async () => {
  let cancelled = false;
  const stuck: IWebTransport = {
    async *send() {
      await new Promise((r) => setTimeout(r, 300));
      yield 'late';
    },
    async cancel() { cancelled = true; },
  };
  const bridge = new GeminiWebBridge(stuck, { timeoutMs: 2000 });
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assert.rejects(() => bridge.run('x', undefined, c.signal), /abort/i);
  assert.equal(cancelled, true);
  assert.ok(Array.isArray(GEMINI_WEB_SELECTORS.stopButton));
});
