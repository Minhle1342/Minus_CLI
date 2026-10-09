import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepseekLLM } from './deepseek.js';
import { Session } from '../session/session.js';
import { fetchCodexResponse } from './codex-responses.js';

const stream = (events: any[]) => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');

test('Codex OAuth sends Responses input and streams text, tool calls and usage back to the agent', async () => {
  const original = globalThis.fetch;
  let sentUrl = ''; let body: any; let headers: any;
  globalThis.fetch = async (url, init) => {
    sentUrl = String(url); body = JSON.parse(String(init?.body)); headers = init?.headers;
    return new Response(stream([
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a.ts"}' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 8 } } } },
    ]));
  };
  try {
    const session = new Session(); session.addUserMessage('Read a.ts');
    const client = new DeepseekLLM('oauth-test', 'gpt-test-codex', 'System rules', 'https://chatgpt.com/backend-api/codex', { 'chatgpt-account-id': 'account-test' });
    let text = ''; let thought = '';
    const result = await client.generateStream(session, [{ name: 'read_file', parameters: { type: 'OBJECT' as any, properties: { path: { type: 'STRING' as any } } } }], {
      onContentToken: token => text += token, onThoughtToken: token => thought += token,
    }, { functionCallingMode: 'ANY', allowedFunctionNames: ['read_file'] });
    assert.equal(sentUrl, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(headers.Authorization, 'Bearer oauth-test');
    assert.equal(headers['chatgpt-account-id'], 'account-test');
    assert.equal(body.instructions, 'System rules');
    assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.equal(body.messages, undefined); assert.equal(body.max_tokens, undefined);
    assert.equal(body.input[0].role, 'user'); assert.equal(body.input[0].content, 'Read a.ts');
    assert.equal(body.tools[0].name, 'read_file');
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'read_file' });
    assert.equal(text, 'Hello'); assert.equal(thought, 'Thinking');
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }]);
    assert.equal(result.usage?.promptTokens, 12); assert.equal(result.usage?.cachedTokens, 8);
  } finally { globalThis.fetch = original; }
});

test('streamed and final-only Codex refusals are returned as visible text', async () => {
  const original = globalThis.fetch;
  const session = new Session(); session.addUserMessage('request');
  const client = new DeepseekLLM('oauth-test', 'gpt-test', undefined, 'https://chatgpt.com/backend-api/codex');
  try {
    const final = { type: 'response.completed', response: { output: [
      { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help with that.' }] },
    ] } };
    globalThis.fetch = async () => new Response(stream([{ type: 'response.refusal.delta', delta: 'Cannot help with that.' }, final]));
    assert.equal((await client.generate(session, [])).text, 'Cannot help with that.');
    globalThis.fetch = async () => new Response(stream([final]));
    assert.equal((await client.generate(session, [])).text, 'Cannot help with that.');
  } finally { globalThis.fetch = original; }
});

test('Responses preserves tool history and handles fragmented UTF-8, final items and token limits', async () => {
  const original = globalThis.fetch; let body: any;
  const data = new TextEncoder().encode(stream([
    { type: 'response.output_text.delta', delta: 'Tiếng Việt' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-new', name: 'read_file', arguments: '' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call-new', name: 'read_file', arguments: '{"path":"b.ts"}' } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Tiếng Việt' }] },
      { type: 'function_call', call_id: 'call-new', name: 'read_file', arguments: '{"path":"b.ts"}' },
    ] } },
  ]));
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < data.length; index += 7) controller.enqueue(data.slice(index, index + 7));
      controller.close();
    } }));
  };
  try {
    const response = await fetchCodexResponse('https://proxy.test/codex/', { model: 'gpt-test', messages: [
      { role: 'system', content: 'Rules' }, { role: 'user', content: 'Read a.ts' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-old', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'call-old', content: 'file content' },
    ] }, {});
    assert.deepEqual(body.input.slice(1), [
      { type: 'function_call', call_id: 'call-old', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call-old', output: 'file content' },
    ]);
    const wire = await response.text();
    assert.equal((wire.match(/Tiếng Việt/g) || []).length, 1, 'final items must not duplicate streamed text');
    assert.equal((wire.match(/call-new/g) || []).length, 1, 'done and completed events must not duplicate tool IDs');
    assert.match(wire, /finish_reason":"length/);
    assert.match(wire, /b.ts/);
  } finally { globalThis.fetch = original; }
});

test('Codex response failures are surfaced and incomplete streams are never reported as successful', async () => {
  const original = globalThis.fetch;
  const client = new DeepseekLLM('oauth-test', 'gpt-test', undefined, 'https://chatgpt.com/backend-api/codex');
  const session = new Session(); session.addUserMessage('hello');
  try {
    globalThis.fetch = async () => new Response(stream([{ type: 'response.failed', response: { error: { message: 'Model unavailable' } } }]));
    await assert.rejects(client.generate(session, []), /Model unavailable/);
    globalThis.fetch = async () => new Response(stream([{ type: 'response.output_text.delta', delta: 'unfinished' }]));
    const result = await client.generate(session, []);
    assert.equal(result.finishReason, 'transport_eof');
  } finally { globalThis.fetch = original; }
});
