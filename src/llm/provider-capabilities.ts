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

/** Only official OpenAI accepts these body fields; unknown compatible gateways are left untouched. */
export function openAIPromptCacheFields(
  baseURL: string,
  cacheKey: string,
  options?: LLMRequestOptions,
): Record<string, string> {
  if (options?.enablePromptCaching === false || !baseURL.toLowerCase().includes('api.openai.com')) return {};
  if (promptCacheV2Mode() !== 'on') return {};
  return {
    prompt_cache_key: cacheKey,
    ...(options?.promptCacheRetention === '24h' ? { prompt_cache_retention: '24h' } : {}),
  };
}
