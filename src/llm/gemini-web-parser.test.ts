import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiWebResponse, stripGeminiWebArtifacts } from './gemini-web-parser.js';

test('parser extracts toolCalls and strips UI artifacts', () => {
  const raw = 'done\n```toolcall-json\n{"name":"read_file","args":{"path":"a.ts"}}\n```\nUse code with caution';
  const r = parseGeminiWebResponse(raw);
  assert.equal(r.toolCalls[0].name, 'read_file');
  assert.deepEqual((r.toolCalls[0].args as any).path, 'a.ts');
  assert.doesNotMatch(r.text ?? '', /Use code with caution/);
});

test('parser throws on malformed tool block', () => {
  assert.throws(() => parseGeminiWebResponse('```toolcall-json\n{bad\n```'));
});

test('parser accepts single-line fence and validates tool names', () => {
  const r = parseGeminiWebResponse('```toolcall-json {"name":"read_file","args":{"path":"a"}} ```', { allowedNames: ['read_file'] });
  assert.equal(r.toolCalls[0].name, 'read_file');
  assert.throws(() => parseGeminiWebResponse('```toolcall-json\n{"name":"nope","args":{}}\n```', { allowedNames: ['read_file'] }), /unknown tool/i);
});

test('strip helper removes buttons and extra artifacts', () => {
  assert.doesNotMatch(stripGeminiWebArtifacts('x Copy code y'), /Copy code/);
});
