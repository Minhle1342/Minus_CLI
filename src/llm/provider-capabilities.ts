import type { LLMRequestOptions } from './gemini.js';

export type PromptCacheProvider = 'anthropic' | 'gemini' | 'openai' | 'deepseek' | 'openai-compatible';

export interface ProviderPromptCacheCapabilities {
  provider: PromptCacheProvider;
  automaticPrefixCaching: boolean;
  explicitCaching: boolean;
  maxExplicitBreakpoints: number;
  supportedRetention: Array<'in_memory' | '1h' | '24h'>;
}

export type RolloutMode = 'off' | 'observe' | 'on';

export function promptCacheV2Mode(): RolloutMode {
  const value = process.env.MINUS_CACHE_ENVELOPE_V2?.trim().toLowerCase();
  return value === 'on' || value === 'off' ? value : 'observe';
}

let lastLoggedOpenAICacheDecision: string | undefined;

/**
 * P1.1: `observe` phải thực sự quan sát.
 *
 * Trước đây cả `prompt_cache_key` lẫn retention chỉ được gửi khi mode = 'on', nên
 * mode mặc định ('observe') không gửi gì và cũng không log — không thể đối chiếu
 * churn (P0.1) với cache hit thật. Nay:
 *   - off      → không gửi field nào;
 *   - observe  → gửi `prompt_cache_key` (routing/affinity), KHÔNG gửi retention;
 *   - on       → gửi key + `prompt_cache_retention: 24h` khi được yêu cầu.
 *
 * Bật log quyết định bằng MINUS_PROMPT_CACHE_LOG=1 (một dòng/process, không spam UI).
 */
export function openAIPromptCacheFields(
  baseURL: string,
  cacheKey: string,
  options?: LLMRequestOptions,
): Record<string, string> {
  const mode = promptCacheV2Mode();
  const officialOpenAI = baseURL.toLowerCase().includes('api.openai.com');
  const fields: Record<string, string> = {};

  if (options?.enablePromptCaching !== false && officialOpenAI && mode !== 'off') {
    fields.prompt_cache_key = cacheKey;
    if (mode === 'on' && options?.promptCacheRetention === '24h') {
      fields.prompt_cache_retention = '24h';
    }
  }

  logOpenAICacheDecisionOnce(baseURL, mode, fields);
  return fields;
}

function logOpenAICacheDecisionOnce(baseURL: string, mode: RolloutMode, fields: Record<string, string>): void {
  if (process.env.MINUS_PROMPT_CACHE_LOG !== '1') return;
  const signature = `${baseURL}|${mode}|${Object.keys(fields).sort().join(',')}`;
  if (lastLoggedOpenAICacheDecision === signature) return;
  lastLoggedOpenAICacheDecision = signature;
  const suffix = baseURL.toLowerCase().includes('api.openai.com') ? '' : ' (vendor endpoint: fields suppressed)';
  console.warn(
    `[prompt-cache] mode=${mode} fields=${Object.keys(fields).sort().join(',') || 'none'}${suffix}`,
  );
}

export function resolvePromptCacheCapabilities(baseURL: string, providerHint?: string): ProviderPromptCacheCapabilities {
  const value = `${providerHint || ''} ${baseURL}`.toLowerCase();
  if (value.includes('anthropic') || value.includes('claude')) {
    return { provider: 'anthropic', automaticPrefixCaching: true, explicitCaching: true, maxExplicitBreakpoints: 4, supportedRetention: ['in_memory', '1h'] };
  }
  if (value.includes('google') || value.includes('gemini')) {
    return { provider: 'gemini', automaticPrefixCaching: true, explicitCaching: true, maxExplicitBreakpoints: 1, supportedRetention: ['in_memory'] };
  }
  if (value.includes('deepseek')) {
    return { provider: 'deepseek', automaticPrefixCaching: true, explicitCaching: false, maxExplicitBreakpoints: 0, supportedRetention: ['in_memory'] };
  }
  if (value.includes('api.openai.com') || providerHint?.toLowerCase() === 'openai') {
    return { provider: 'openai', automaticPrefixCaching: true, explicitCaching: false, maxExplicitBreakpoints: 0, supportedRetention: ['in_memory', '24h'] };
  }
  return { provider: 'openai-compatible', automaticPrefixCaching: false, explicitCaching: false, maxExplicitBreakpoints: 0, supportedRetention: [] };
}

export function anthropicCacheControl(options?: LLMRequestOptions): { type: 'ephemeral'; ttl?: '1h' } | undefined {
  if (options?.enablePromptCaching === false) return undefined;
  return promptCacheV2Mode() === 'on' && options?.promptCacheRetention === '24h'
    ? { type: 'ephemeral', ttl: '1h' }
    : { type: 'ephemeral' };
}
