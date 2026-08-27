import { GoogleGenAI, type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { TokenConfig, resolveTokenConfig } from './token-config.js';
import { retryWithExponentialBackoff } from './error-handling.js';

export interface StreamCallbacks {
  onThoughtToken?: (token: string) => void;
  onContentToken?: (token: string) => void;
  onToolCallEarly?: (toolCall: { id?: string; name: string; args: Record<string, any> }) => void;
}

export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheHitRate?: number;
  /** Provider-neutral wall time measured around the complete request. */
  requestDurationMs?: number;
  /** Time until the first streamed content or reasoning token, when available. */
  timeToFirstTokenMs?: number;
}

export interface LLMRequestOptions {
  systemPrompt?: string;
  dynamicContext?: string;
  tokenConfig?: Partial<TokenConfig>;
  sessionId?: string;
  promptCacheKey?: string;
  enablePromptCaching?: boolean;
  promptCacheRetention?: 'in_memory' | '24h';
  promptCacheBreakpoint?: boolean;
  signal?: AbortSignal;
}

export type LLMFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'max_tokens'
  | 'content_filter'
  | 'error'
  | 'aborted'
  | 'transport_eof'
  | 'unknown';

export interface LLMResponse {
  text?: string;
  reasoningContent?: string;
  toolCalls: FunctionCall[];
  rawContent?: import('@google/genai').Content;
  /** Normalized provider termination state. Optional for legacy/custom adapters. */
  finishReason?: LLMFinishReason;
  /** Original provider value retained for diagnostics. */
  rawFinishReason?: string;
  /** Token usage statistics and prompt cache metrics */
  usage?: LLMUsage;
}

/**
 * GeminiLLM - Tích hợp Real-time Streaming & CoT Separation
 */
export class GeminiLLM {
  private client: GoogleGenAI;
  readonly modelName: string;
  readonly systemPrompt: string;
  private tokenConfig: TokenConfig;

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3.5-flash',
    systemPrompt: string = CODING_AGENT_SYSTEM_PROMPT,
    tokenConfig?: Partial<TokenConfig>,
  ) {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY không được để trống.');
    }
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
    this.systemPrompt = systemPrompt;
    this.tokenConfig = resolveTokenConfig(modelName, tokenConfig);
  }

  getTokenConfig(): TokenConfig {
    return { ...this.tokenConfig };
  }

  setTokenConfig(config: Partial<TokenConfig>): void {
    this.tokenConfig = resolveTokenConfig(this.modelName, {
      ...this.tokenConfig,
      ...config,
    });
  }

  /**
   * Tạo phản hồi qua luồng Real-time Stream
   */
  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const contents = this.prepareContents(session, request?.dynamicContext);
    const effectiveTokenConfig = resolveTokenConfig(this.modelName, {
      ...this.tokenConfig,
      ...request?.tokenConfig,
    });

    const generateConfig: any = {
      systemInstruction: request?.systemPrompt || this.systemPrompt,
      tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
    };

    if (effectiveTokenConfig.maxOutputTokens) {
      generateConfig.maxOutputTokens = effectiveTokenConfig.maxOutputTokens;
    }

    if (effectiveTokenConfig.thinkingBudget !== undefined) {
      generateConfig.thinkingConfig = {
        thinkingBudget: effectiveTokenConfig.thinkingBudget,
        includeThoughts: effectiveTokenConfig.includeThoughts ?? true,
      };
    }

    if (request?.signal?.aborted) {
      return {
        text: '',
        toolCalls: [],
        finishReason: 'aborted',
        rawFinishReason: 'aborted',
      };
    }

    const responseStream = await retryWithExponentialBackoff(
      () => this.client.models.generateContentStream({
        model: this.modelName,
        contents,
        config: generateConfig,
      }),
      {
        maxRetries: 3,
        baseDelayMs: 1500,
        maxDelayMs: 12000,
        jitterMs: 500,
      },
    );

    const thoughtParts: string[] = [];
    const regularTextParts: string[] = [];
    const toolCalls: FunctionCall[] = [];
    const streamedParts: any[] = [];
    let rawFinishReason: string | undefined;

    let lastUsage: LLMUsage | undefined;

    for await (const chunk of responseStream) {
      if (request?.signal?.aborted) {
        rawFinishReason = 'aborted';
        break;
      }
      if ((chunk as any).usageMetadata) {
        const meta = (chunk as any).usageMetadata;
        const promptTokens = meta.promptTokenCount ?? 0;
        const completionTokens = meta.candidatesTokenCount ?? 0;
        const totalTokens = meta.totalTokenCount ?? (promptTokens + completionTokens);
        const cachedTokens = meta.cachedContentTokenCount ?? 0;
        const cacheHitRate = promptTokens > 0 ? Number(((cachedTokens / promptTokens) * 100).toFixed(1)) : 0;
        lastUsage = {
          promptTokens,
          completionTokens,
          totalTokens,
          cachedTokens,
          cacheReadInputTokens: cachedTokens,
          cacheHitRate,
        };
      }

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason !== undefined && candidate.finishReason !== null) {
        rawFinishReason = String(candidate.finishReason);
      }
      if (candidate?.content?.parts) {
        streamedParts.push(...candidate.content.parts.map((part: any) => cloneJson(part)));
      }

      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        toolCalls.push(...chunk.functionCalls);
        if (callbacks?.onToolCallEarly) {
          for (const fc of chunk.functionCalls) {
            callbacks.onToolCallEarly({
              id: (fc as any).id,
              name: fc.name || '',
              args: (fc.args as Record<string, any>) || {},
            });
          }
        }
      }

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if ('text' in part && typeof (part as any).text === 'string') {
            const token = (part as any).text;
            if ((part as any).thought) {
              thoughtParts.push(token);
              callbacks?.onThoughtToken?.(token);
            } else {
              regularTextParts.push(token);
              callbacks?.onContentToken?.(token);
            }
          }
        }
      }
    }

    const functionCallParts = streamedParts.filter((part) => part.functionCall);
    const nonFunctionCallParts = streamedParts.filter((part) => !part.functionCall);
    const normalizedFunctionCallParts = toolCalls.map((call, index) => {
      const matchingIndex = functionCallParts.findIndex(
        (part) => part.functionCall?.name === call.name,
      );
      const sourceIndex = matchingIndex >= 0 ? matchingIndex : 0;
      const sourcePart = functionCallParts[sourceIndex];
      if (!sourcePart) return undefined;
      functionCallParts.splice(sourceIndex, 1);
      return {
        ...sourcePart,
        functionCall: {
          ...sourcePart.functionCall,
          name: call.name,
          args: call.args || sourcePart.functionCall?.args || {},
        },
      };
    }).filter(Boolean);

    if (toolCalls.length > 0 && normalizedFunctionCallParts.length !== toolCalls.length) {
      throw new Error('Gemini streaming response contained tool calls without their original functionCall parts. Refusing to persist a call without thought signatures.');
    }

    const rawContent = streamedParts.length > 0
      ? { role: 'model' as const, parts: [...nonFunctionCallParts, ...normalizedFunctionCallParts] }
      : undefined;

    return {
      text: regularTextParts.length > 0 ? regularTextParts.join('') : undefined,
      reasoningContent: thoughtParts.length > 0 ? thoughtParts.join('') : undefined,
      toolCalls,
      rawContent,
      finishReason: normalizeGeminiFinishReason(rawFinishReason, toolCalls.length > 0),
      rawFinishReason,
      usage: lastUsage,
    };
  }

  /**
   * Gemini thinking signatures are opaque and cannot be reconstructed. Legacy
   * unsigned tool exchanges remain durable in Session, but are omitted from a
   * Gemini request together with their matching results.
   */
  private prepareContents(session: Session, dynamicContext?: string): import('@google/genai').Content[] {
    const rawHistory = session.getHistory();
    let history = rawHistory;

    if (dynamicContext && dynamicContext.trim()) {
      const cloned = rawHistory.map((item) => cloneJson(item));
      const lastUserItem = [...cloned].reverse().find((item) => item.role === 'user');
      if (lastUserItem) {
        lastUserItem.parts = lastUserItem.parts || [];
        lastUserItem.parts.push({
          text: `\n\n[Execution Context & Plan Status]\n${dynamicContext.trim()}`,
        });
        history = cloned;
      } else {
        cloned.push({
          role: 'user',
          parts: [{ text: `[Execution Context & Plan Status]\n${dynamicContext.trim()}` }],
        });
        history = cloned;
      }
    }

    if (!requiresThoughtSignatures(this.modelName)) return history;

    const unsignedCallIds = new Set<string>();
    const sanitized: import('@google/genai').Content[] = [];

    for (const content of history) {
      const parts = (content.parts || []).filter((part: any) => {
        if (part.functionCall && !part.thoughtSignature) {
          if (part.functionCall.id) unsignedCallIds.add(part.functionCall.id);
          return false;
        }
        if (part.functionResponse && part.functionResponse.id
          && unsignedCallIds.has(part.functionResponse.id)) {
          return false;
        }
        return true;
      });

      const hasMeaningfulPart = parts.some((part: any) => (
        part.functionCall
        || part.functionResponse
        || part.inlineData
        || part.fileData
        || (typeof part.text === 'string' && part.text.length > 0)
      ));
      if (hasMeaningfulPart) {
        sanitized.push({ ...cloneJson(content), parts: cloneJson(parts) });
      }
    }

    return sanitized;
  }

  /**
   * Phương thức generate đồng bộ (tự động gọi generateStream)
   */
  async generate(session: Session, tools: FunctionDeclaration[], request?: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateStream(session, tools, undefined, request);
  }
}

function requiresThoughtSignatures(modelName: string): boolean {
  return /^gemini-(?:3|2\.5)(?:\.|-|$)/i.test(modelName);
}

function normalizeGeminiFinishReason(raw: string | undefined, hasToolCalls: boolean): LLMFinishReason {
  if (!raw) return 'unknown';
  switch (raw.toUpperCase()) {
    case 'STOP':
      return hasToolCalls ? 'tool_calls' : 'stop';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'RECITATION':
    case 'SPII':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      return 'error';
    case 'ABORTED':
      return 'aborted';
    default:
      return 'unknown';
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
