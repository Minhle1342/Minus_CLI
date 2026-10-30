import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepseekLLM } from './deepseek.js';
import { Session } from '../session/session.js';

const sse = (events: any[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');

function mockFetch(handler: (url: string, init: any) => any) {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init: any) => handler(String(url), init);
  return () => { globalThis.fetch = original; };
}

test('OpenRouter requests use the unified reasoning param, not DeepSeek/Anthropic shapes', async () => {
  let body: any;
  const restore = mockFetch((_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(sse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]));
  });
  try {
    const session = new Session(); session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'o3-mini', undefined, 'https://openrouter.ai/api/v1');
    await client.generateStream(session, [], undefined, { tokenConfig: { reasoningEffort: 'high' } });
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.thinking, undefined);
  } finally { restore(); }
});

test('non-OpenRouter gateways keep the legacy effort fields', async () => {
  let body: any;
  const restore = mockFetch((_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(sse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]));
  });
  try {
    const session = new Session(); session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'deepseek-reasoner', undefined, 'https://api.deepseek.com');
    await client.generateStream(session, [], undefined, { tokenConfig: { reasoningEffort: 'medium' } });
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.reasoning, undefined);
  } finally { restore(); }
});

test('OpenRouter reasoning deltas accumulate into reasoningContent', async () => {
  const restore = mockFetch(() => new Response(sse([
    { choices: [{ delta: { reasoning: 'Let me think' } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: ' step by step' }] } }] },
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
  ])));
  try {
    const session = new Session(); session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'nvidia/nemotron-3.5-lightning:free', undefined, 'https://openrouter.ai/api/v1');
    let thought = '';
    const result = await client.generateStream(session, [], { onThoughtToken: token => thought += token });
    assert.equal(result.reasoningContent, 'Let me think step by step');
    assert.equal(thought, 'Let me think step by step');
    assert.equal(result.text, 'done');
  } finally { restore(); }
});

test('OpenRouter reasoning chunk with both reasoning and reasoning_details de-duplicated', async () => {
  const restore = mockFetch(() => new Response(sse([
    { choices: [{ delta: { reasoning: 'Let me think step by step', reasoning_details: [{ type: 'reasoning.text', text: 'Let me think step by step' }] } }] },
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ])));
  try {
    const session = new Session(); session.addUserMessage('hi');
    const client = new DeepseekLLM('k', 'nvidia/nemotron-3.5-lightning:free', undefined, 'https://openrouter.ai/api/v1');
    let thought = '';
    const result = await client.generateStream(session, [], { onThoughtToken: token => thought += token });
    assert.equal(result.reasoningContent, 'Let me think step by step');
    assert.equal(thought, 'Let me think step by step');
  } finally { restore(); }
});
