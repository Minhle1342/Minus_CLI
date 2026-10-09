import { DeepseekLLM } from './deepseek.js';
import { ensureCodexAuthenticated, getCodexCredentials, type CodexLoginOptions } from './codex-auth.js';
import type { TokenConfig } from './token-config.js';

/** Explicit gateways keep their own routing and authentication. */
export function isOpenAIModel(model: string): boolean {
  return /^(?:openai\/|codex\/|gpt-|o\d+(?:-|$))/i.test(model);
}

export async function createOpenAIClient(
  model: string,
  tokenConfig?: Partial<TokenConfig>,
  options: CodexLoginOptions & { interactive?: boolean; apiKey?: string } = {},
): Promise<DeepseekLLM> {
  const rawModel = model.replace(/^(?:openai|codex)\//i, '');
  const credentials = options.interactive
    ? await ensureCodexAuthenticated(options)
    : options.apiKey ? null : getCodexCredentials();
  if (credentials) {
    return new DeepseekLLM(credentials.accessToken, rawModel, undefined,
      process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex', {
        ...(credentials.accountId ? { 'chatgpt-account-id': credentials.accountId } : {}),
        originator: 'codex_cli_rs',
        'OpenAI-Beta': 'responses=experimental',
      }, tokenConfig);
  }
  // Non-interactive/API-only startup never launches a browser.
  if (options.apiKey) {
    return new DeepseekLLM(options.apiKey, rawModel, undefined,
      (model.startsWith('codex/') || model.startsWith('gpt-5.6-')
        ? process.env.CODEX_BASE_URL : process.env.OPENAI_BASE_URL) || 'https://api.openai.com/v1', undefined, tokenConfig);
  }
  throw new Error('No ChatGPT login found. Select this model with /model to sign in, or run codex login.');
}
