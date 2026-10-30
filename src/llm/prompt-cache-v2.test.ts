import assert from 'node:assert/strict';
import test from 'node:test';
import { anthropicCacheControl, openAIPromptCacheFields } from './provider-capabilities.js';
import { applyAnthropicHistoryCacheControl } from './anthropic.js';
import {
  GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT,
  estimateGeminiPrefixTokens,
  shouldUseGeminiExplicitCache,
} from './gemini.js';

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('observe mode sends prompt_cache_key but not retention', () => {
  withEnv({ MINUS_CACHE_ENVELOPE_V2: undefined }, () => {
    assert.deepEqual(
      openAIPromptCacheFields('https://api.openai.com/v1', 'pc2_key', { promptCacheRetention: '24h' }),
      { prompt_cache_key: 'pc2_key' },
    );
  });
});

test('off mode sends nothing and on mode adds retention', () => {
  withEnv({ MINUS_CACHE_ENVELOPE_V2: 'off' }, () => {
    assert.deepEqual(openAIPromptCacheFields('https://api.openai.com/v1', 'pc2_key', {}), {});
  });
  withEnv({ MINUS_CACHE_ENVELOPE_V2: 'on' }, () => {
    assert.deepEqual(
      openAIPromptCacheFields('https://api.openai.com/v1', 'pc2_key', { promptCacheRetention: '24h' }),
      { prompt_cache_key: 'pc2_key', prompt_cache_retention: '24h' },
    );
    assert.deepEqual(
      openAIPromptCacheFields('https://api.openai.com/v1', 'pc2_key', {}),
      { prompt_cache_key: 'pc2_key' },
    );
  });
});

test('vendor endpoints and disabled caching never receive OpenAI cache fields', () => {
  withEnv({ MINUS_CACHE_ENVELOPE_V2: 'on' }, () => {
    assert.deepEqual(openAIPromptCacheFields('https://api.deepseek.com', 'pc2_key', {}), {});
    assert.deepEqual(
      openAIPromptCacheFields('https://api.openai.com/v1', 'pc2_key', { enablePromptCaching: false }),
      {},
    );
  });
});

test('anthropic history breakpoint marks only the trailing content block', () => {
  const cacheControl = { type: 'ephemeral' as const };
  const messages: Array<{ role: string; content: any[] }> = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'large' }] },
  ];
  assert.equal(applyAnthropicHistoryCacheControl(messages, cacheControl), true);
  assert.deepEqual(messages[2].content[0].cache_control, cacheControl);
  assert.equal(messages[0].content[0].cache_control, undefined, 'earlier blocks must stay unmarked');

  // Idempotent: a second pass must not duplicate or move the marker.
  assert.equal(applyAnthropicHistoryCacheControl(messages, cacheControl), false);
  assert.deepEqual(messages[2].content[0].cache_control, cacheControl);
});

test('anthropic history breakpoint tolerates empty/odd histories', () => {
  const cacheControl = { type: 'ephemeral' as const };
  assert.equal(applyAnthropicHistoryCacheControl([], cacheControl), false);
  assert.equal(applyAnthropicHistoryCacheControl([{ role: 'user', content: [] }], cacheControl), false);
  assert.equal(applyAnthropicHistoryCacheControl([{ role: 'user', content: 'plain' } as any], cacheControl), false);
});

test('anthropic one-hour TTL follows the 24h retention request', () => {
  withEnv({ MINUS_CACHE_ENVELOPE_V2: 'on' }, () => {
    assert.deepEqual(anthropicCacheControl({ promptCacheRetention: '24h' }), { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(anthropicCacheControl({ promptCacheRetention: 'in_memory' }), { type: 'ephemeral' });
    assert.equal(anthropicCacheControl({ enablePromptCaching: false }), undefined);
  });
});

test('gemini explicit cache gate: auto by threshold, explicit override wins', () => {
  const base = { mode: '', rollout: 'observe' as const, prefixTokens: 0 };

  assert.equal(shouldUseGeminiExplicitCache({ ...base, prefixTokens: GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT - 1 }), false);
  assert.equal(shouldUseGeminiExplicitCache({ ...base, prefixTokens: GEMINI_EXPLICIT_CACHE_MIN_TOKENS_DEFAULT }), true);

  // Explicit opt-in ignores size, explicit opt-out wins over a huge prefix.
  assert.equal(shouldUseGeminiExplicitCache({ ...base, mode: 'on', prefixTokens: 10 }), true);
  assert.equal(shouldUseGeminiExplicitCache({ ...base, mode: 'off', prefixTokens: 1_000_000 }), false);

  // Global rollout off is a kill switch; disabled request wins over everything.
  assert.equal(shouldUseGeminiExplicitCache({ ...base, rollout: 'off', prefixTokens: 1_000_000 }), false);
  assert.equal(shouldUseGeminiExplicitCache({ ...base, mode: 'on', rollout: 'off', prefixTokens: 1_000_000 }), false);
  assert.equal(shouldUseGeminiExplicitCache({ ...base, enabled: false, mode: 'on', prefixTokens: 1_000_000 }), false);

  // Custom threshold is honored.
  assert.equal(shouldUseGeminiExplicitCache({ ...base, prefixTokens: 5_000, minTokens: 4_096 }), true);
  assert.equal(shouldUseGeminiExplicitCache({ ...base, prefixTokens: 3_000, minTokens: 4_096 }), false);
});

test('gemini prefix estimate grows with prompt and tool schema', () => {
  const empty = estimateGeminiPrefixTokens('', []);
  assert.equal(empty, 0);
  const withPrompt = estimateGeminiPrefixTokens('x'.repeat(3600), []);
  assert.equal(withPrompt, 1000);
  const withTools = estimateGeminiPrefixTokens('x'.repeat(3600), [{ name: 'read_file', parameters: { type: 'object' } }] as any);
  assert.ok(withTools > withPrompt);
});
