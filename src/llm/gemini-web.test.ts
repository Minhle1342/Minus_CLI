import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiWebLLM } from './gemini-web.js';
import { GeminiWebBridge, type IWebTransport } from './gemini-web-bridge.js';

class MockTransport implements IWebTransport {
  constructor(private chunks: string[]) {}
  async *send(): AsyncIterable<string> {
    for (const c of this.chunks) yield c;
  }
  async cancel(): Promise<void> {}
}

const fakeSession = () => ({ getHistory: () => [] }) as any;

test('gemini-web generateStream returns toolCalls+usage like GeminiLLM', async () => {
  const llm = new GeminiWebLLM('gemini-web-flash', 'SYS', new GeminiWebBridge(new MockTransport(['```toolcall-json\n{"name":"read_file","args":{"path":"a"}}\n```'])));
  const res = await llm.generateStream(fakeSession(), [{ name: 'read_file' } as any]);
  assert.equal(res.toolCalls[0].name, 'read_file');
  assert.ok(res.usage?.requestDurationMs !== undefined);
});
