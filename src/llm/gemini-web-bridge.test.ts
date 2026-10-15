import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiWebBridge, type IWebTransport } from './gemini-web-bridge.js';

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
  assert.deepEqual(seen, ['he', 'llo']);
});

test('bridge aborts in-flight run', async () => {
  const bridge = new GeminiWebBridge(new MockTransport(['a', 'b']));
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => bridge.run('x', undefined, c.signal), /abort/i);
});
