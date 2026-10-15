import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeGeminiWebPayload, GEMINI_WEB_OUTPUT_CONTRACT } from './gemini-web-serializer.js';

test('serializer keeps order, roles, tools and suffix anchors', () => {
  const out = serializeGeminiWebPayload({
    systemPrompt: 'SYS',
    history: [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { ok: true } } }] },
    ] as any,
    tools: [{ name: 'read_file' } as any],
    dynamicContext: 'CTX',
    stepSuffixes: { 1: 'S1' },
  });
  assert.match(out, /SYSTEM/);
  assert.match(out, /\[user\]/);
  assert.match(out, /\[model\]/);
  assert.match(out, /read_file/);
  assert.match(out, /CTX/);
  assert.match(out, /S1/);
  assert.ok(GEMINI_WEB_OUTPUT_CONTRACT.includes('toolcall-json'));
});
