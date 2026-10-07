import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepseekLLM } from './deepseek.js';
import { AnthropicLLM } from './anthropic.js';
import { Session } from '../session/session.js';

test('OpenAI-compatible and Anthropic requests force only submit, disable parallel calls and retain full schemas', async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(String(url).endsWith('/messages')
      ? 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
      : 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n', { status: 200 });
  };
  try {
    const tools: any[] = ['read_file', 'submit_solution'].map(name => ({ name, parameters: { type: 'OBJECT', properties: {} } }));
    const request = { functionCallingMode: 'ANY' as const, allowedFunctionNames: ['submit_solution'] };
    const session = new Session(); session.addUserMessage('Explain the code.');
    await new DeepseekLLM({ apiKey: 'test', modelName: 'gpt-test', baseURL: 'https://example.test/v1' }).generate(session, tools, request);
    await new AnthropicLLM({ apiKey: 'test' }).generate(session, tools, request);
    assert.deepEqual(bodies[0].tool_choice, { type: 'function', function: { name: 'submit_solution' } });
    assert.equal(bodies[0].parallel_tool_calls, false);
    assert.deepEqual(bodies[1].tool_choice, { type: 'tool', name: 'submit_solution', disable_parallel_tool_use: true });
    assert.equal(bodies[0].tools.length, 2);
    assert.equal(bodies[1].tools.length, 2);
  } finally { globalThis.fetch = original; }
});
