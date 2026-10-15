import type { FunctionDeclaration } from '@google/genai';
import type { Session } from '../session/session.js';
import { createStandardSystemPrompt } from './prompts.js';
import { resolveTokenConfig, type TokenConfig } from './token-config.js';
import { retryWithExponentialBackoff } from './error-handling.js';
import { serializeGeminiWebPayload } from './gemini-web-serializer.js';
import { parseGeminiWebResponse } from './gemini-web-parser.js';
import { GeminiWebBridge } from './gemini-web-bridge.js';
import type { LLMRequestOptions, LLMResponse, StreamCallbacks } from './gemini.js';

/** Web-tab models share one browser tab — extra calls (e.g. session naming) would double-submit and race the main turn. */
export function isGeminiWebModel(modelName: string): boolean {
  return (modelName || '').startsWith('gemini-web');
}

/** Adapter drop-in cho tab gemini.google.com, cùng chữ ký GeminiLLM. */
export class GeminiWebLLM {
  readonly modelName: string;
  readonly systemPrompt: string;
  private tokenConfig: TokenConfig;
  private bridge: GeminiWebBridge | null;

  constructor(modelName = 'gemini-web-flash', systemPrompt = createStandardSystemPrompt(), bridge: GeminiWebBridge | null = null, tokenConfig?: Partial<TokenConfig>) {
    this.modelName = modelName;
    this.systemPrompt = systemPrompt;
    this.bridge = bridge;
    this.tokenConfig = resolveTokenConfig(modelName, tokenConfig);
  }

  cloneWithModel(modelName: string): GeminiWebLLM {
    return new GeminiWebLLM(modelName, this.systemPrompt, this.bridge, this.tokenConfig);
  }

  getTokenConfig(): TokenConfig {
    return { ...this.tokenConfig };
  }

  setTokenConfig(config: Partial<TokenConfig>): void {
    this.tokenConfig = resolveTokenConfig(this.modelName, { ...this.tokenConfig, ...config });
  }

  async generateStream(session: Session, tools: FunctionDeclaration[], callbacks?: StreamCallbacks, request?: LLMRequestOptions): Promise<LLMResponse> {
    if (!this.bridge) throw new Error('GeminiWeb bridge not connected (no transport). Mở Chrome với --remote-debugging-port=9222 rồi thử lại.');
    if (request?.signal?.aborted) return { text: '', toolCalls: [], finishReason: 'aborted', rawFinishReason: 'aborted' };
    if (request?.tokenConfig) this.setTokenConfig(request.tokenConfig);
    const noneMode = request?.functionCallingMode === 'NONE'
      || (request?.allowedFunctionNames !== undefined && request.allowedFunctionNames.length === 0);
    const allowed = noneMode ? [] : (request?.functionCallingMode === 'ANY' && request.allowedFunctionNames
      ? tools.filter((t) => request.allowedFunctionNames!.includes(t.name || ''))
      : tools);
    const payload = serializeGeminiWebPayload({
      systemPrompt: (request?.systemPrompt || this.systemPrompt) + (noneMode ? '\nDo not emit any toolcall-json blocks. Answer in plain text only.' : ''),
      history: session.getHistory() as any,
      tools: allowed,
      dynamicContext: request?.dynamicContext,
      stepSuffixes: request?.stepSuffixes,
    });
    const start = Date.now();
    let ttfb: number | undefined;
    const raw = await retryWithExponentialBackoff(
      () => this.bridge!.run(payload, (t) => {
        if (ttfb === undefined) ttfb = Date.now() - start;
        callbacks?.onContentToken?.(t);
      }, request?.signal),
      { maxRetries: request?.maxRetries ?? 2, baseDelayMs: 1000, maxDelayMs: 5000, signal: request?.signal },
    );
    const parsed = parseGeminiWebResponse(raw, { allowedNames: allowed.map((t) => t.name || '') });
    const duration = Date.now() - start;
    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls as any,
      finishReason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      rawFinishReason: 'web',
      usage: { requestDurationMs: duration, timeToFirstTokenMs: ttfb },
    };
  }

  async generate(session: Session, tools: FunctionDeclaration[], request?: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateStream(session, tools, undefined, request);
  }
}
