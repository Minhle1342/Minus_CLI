import { type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { createStandardSystemPrompt } from './prompts.js';
import { LLMResponse, LLMRequestOptions, StreamCallbacks, type LLMFinishReason, type LLMUsage } from './gemini.js';
import { TokenConfig, EffortScope, getModelTokenProfile, resolveTokenConfig } from './token-config.js';
import { fetchCodexResponse } from './codex-responses.js';
import { createPromptCacheKey } from './cache-envelope.js';
import { openAIPromptCacheFields } from './provider-capabilities.js';
import { retryWithExponentialBackoff } from './error-handling.js';

/**
 * Stall watchdog for SSE streams: a silent stream (no chunk within the
 * window) is cut and reported as transport_eof so the agent loop's existing
 * stream-continuation retry resumes it, instead of hanging forever.
 */
export const DEFAULT_HEADER_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CHUNK_TIMEOUT_MS = 15 * 60 * 1000;
const STREAM_STALL_TIMEOUT_MS = DEFAULT_CHUNK_TIMEOUT_MS;

export interface DeepseekLLMOptions {
  modelName?: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
  extraHeaders?: Record<string, string>;
  tokenConfig?: Partial<TokenConfig>;
  headerTimeoutMs?: number;
  chunkTimeoutMs?: number;
  maxRetries?: number;
}

/**
 * DeepseekLLM - Hỗ trợ DeepSeek, OpenAI Codex, GPT-5.6 (Sol/Terra/Luna), Groq & OpenAI-compatible APIs
 * 
 * Tích hợp:
 * 1. OpenAI-compatible Function Calling format.
 * 2. Deterministic Tool Ordering để tối đa hóa KV-Cache hit rate (>80%).
 * 3. Real-time Streaming & SSE Chunk Parsing cho cả System 2 Thinking và System 1 Actions.
 * 4. Tự động hỗ trợ headers tùy chỉnh (như chatgpt-account-id cho ChatGPT Plus OAuth).
 * 5. Tự động điều chỉnh Input, Output và Thinking/Reasoning Tokens cho từng nhà cung cấp.
 * 6. Reasoning Stream Watchdog (headerTimeout & chunkTimeout) chống treo kết nối khi mô hình suy luận lâu.
 * 7. Lũy kế retry schedule 84s với trần 10s backoff gap cap, chống ngắt quãng mạng và rate-limit transient.
 */
export class DeepseekLLM {
  readonly modelName: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly systemPrompt: string;
  readonly extraHeaders: Record<string, string>;
  readonly headerTimeoutMs?: number;
  readonly chunkTimeoutMs?: number;
  readonly maxRetries: number;
  private tokenConfig: TokenConfig;
  private effortScope: EffortScope;

  constructor(
    apiKeyOrOptions?: string | DeepseekLLMOptions,
    modelName?: string,
    systemPrompt?: string,
    baseURL?: string,
    extraHeaders?: Record<string, string>,
    tokenConfig?: Partial<TokenConfig>
  ) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.modelName = apiKeyOrOptions.modelName || 'deepseek-chat';
      this.apiKey = apiKeyOrOptions.apiKey || process.env.DEEPSEEK_API_KEY || '';
      this.baseURL = apiKeyOrOptions.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
      this.systemPrompt = apiKeyOrOptions.systemPrompt || createStandardSystemPrompt();
      this.extraHeaders = apiKeyOrOptions.extraHeaders || {};
      this.headerTimeoutMs = apiKeyOrOptions.headerTimeoutMs;
      this.chunkTimeoutMs = apiKeyOrOptions.chunkTimeoutMs;
      this.maxRetries = apiKeyOrOptions.maxRetries !== undefined ? apiKeyOrOptions.maxRetries : 10;
      this.tokenConfig = resolveTokenConfig(this.modelName, apiKeyOrOptions.tokenConfig, this.baseURL);
    } else {
      this.apiKey = apiKeyOrOptions || process.env.DEEPSEEK_API_KEY || '';
      this.modelName = modelName || 'deepseek-chat';
      this.systemPrompt = systemPrompt || createStandardSystemPrompt();
      this.baseURL = baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
      this.extraHeaders = extraHeaders || {};
      this.maxRetries = 10;
      this.tokenConfig = resolveTokenConfig(this.modelName, tokenConfig, this.baseURL);
    }

    if (!this.apiKey) {
      throw new Error('API key must not be empty when initializing DeepseekLLM / OpenAI-compatible provider.');
    }
    this.effortScope = new EffortScope(this.tokenConfig.reasoningEffort);
  }

  cloneWithModel(modelName: string): DeepseekLLM {
    return new DeepseekLLM({
      apiKey: this.apiKey,
      modelName,
      systemPrompt: this.systemPrompt,
      baseURL: this.baseURL,
      extraHeaders: this.extraHeaders,
      headerTimeoutMs: this.headerTimeoutMs,
      chunkTimeoutMs: this.chunkTimeoutMs,
      maxRetries: this.maxRetries,
      tokenConfig: this.tokenConfig,
    });
  }

  getTokenConfig(): TokenConfig {
    return { ...this.tokenConfig };
  }

  setTokenConfig(config: Partial<TokenConfig>): void {
    this.tokenConfig = resolveTokenConfig(this.modelName, {
      ...this.tokenConfig,
      ...config,
    }, this.baseURL);
    // Explicit reconfig re-baselines the freeze (root cause: frozen value must not drift implicitly).
    this.effortScope = new EffortScope(this.tokenConfig.reasoningEffort);
  }

  /**
   * Chuyển đổi đệ quy JSON Schema từ Google GenAI format sang OpenAI/JSON-Schema chuẩn
   * (ví dụ: 'OBJECT' -> 'object', 'STRING' -> 'string', 'ARRAY' -> 'array', 'NUMBER' -> 'number')
   */
  private normalizeSchemaToOpenAI(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.normalizeSchemaToOpenAI(item));
    }

    const normalized: Record<string, any> = {};

    for (const [key, value] of Object.entries(schema)) {
      if (key === 'type' && typeof value === 'string') {
        normalized.type = value.toLowerCase();
      } else if (key === 'properties' && value && typeof value === 'object') {
        const props: Record<string, any> = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          props[propName] = this.normalizeSchemaToOpenAI(propSchema);
        }
        normalized.properties = props;
      } else if (key === 'items' && value) {
        normalized.items = this.normalizeSchemaToOpenAI(value);
      } else if (key === 'required' && Array.isArray(value)) {
        normalized.required = value;
      } else if (typeof value === 'object' && value !== null) {
        normalized[key] = this.normalizeSchemaToOpenAI(value);
      } else {
        normalized[key] = value;
      }
    }

    // Nếu là object mà chưa có properties, gán properties rỗng cho chuẩn JSON Schema
    if (normalized.type === 'object' && !normalized.properties) {
      normalized.properties = {};
    }

    return normalized;
  }

  /**
   * Chuyển đổi định dạng Schema FunctionDeclaration của Google GenAI sang OpenAI Tools Format
   */
  private convertToolsToOpenAI(tools: FunctionDeclaration[]): any[] {
    // Sắp xếp deterministically theo tên tool để tối ưu KV-Cache Prefix
    const sortedTools = [...tools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return sortedTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: this.normalizeSchemaToOpenAI(tool.parameters || { type: 'object', properties: {} }),
      },
    }));
  }

  /**
   * Chuyển đổi Session History sang định dạng messages của OpenAI/DeepSeek
   * Giữ System Prompt 100% STATIC để tối ưu hoá KV-Cache Prefix.
   * Dynamic Execution Context được đặt ở phần đuôi (tail-end user message) để không làm vỡ cache prefix.
   */
  private convertHistoryToOpenAIMessages(
    session: Session,
    systemPrompt: string,
    dynamicContext?: string,
    promptCacheBreakpoint?: boolean,
    stepSuffixes?: Map<number, string> | Record<number, string>,
  ): any[] {
    const history = session.getHistory();
    const rawMessages: any[] = [];

    // 1. Luôn đưa Static System Prompt lên đầu tiên để cố định KV-Cache Prefix
    const systemMessage: any = {
      role: 'system',
      content: systemPrompt,
    };
    rawMessages.push(systemMessage);

    let lastAssistantToolCalls: Array<{ id: string; name: string }> = [];

    // 2. Chuyển đổi các lượt tin nhắn trong Session
    for (let msgIdx = 0; msgIdx < history.length; msgIdx++) {
      const item = history[msgIdx];
      const functionResponses = item.parts
        ?.filter((part: any) => part.functionResponse)
        .map((part: any) => part.functionResponse) || [];

      if (functionResponses.length > 0) {
        for (let respIdx = 0; respIdx < functionResponses.length; respIdx++) {
          const response = functionResponses[respIdx];
          let matchedId = response.id || response.toolCallId;

          // Nếu response không có ID hoặc ID không khớp với assistant trước đó,
          // đối chiếu với tool_calls của assistant liền trước
          if (!matchedId || !lastAssistantToolCalls.some((tc) => tc.id === matchedId)) {
            if (lastAssistantToolCalls[respIdx]) {
              matchedId = lastAssistantToolCalls[respIdx].id;
            } else {
              const byName = lastAssistantToolCalls.find((tc) => tc.name === response.name);
              if (byName) {
                matchedId = byName.id;
              } else {
                matchedId = matchedId || `call_${msgIdx}_${respIdx}`;
              }
            }
          }

          rawMessages.push({
            role: 'tool',
            content: typeof response.response === 'string'
              ? response.response
              : JSON.stringify(response.response?.result ?? response.response ?? {}),
            tool_call_id: matchedId,
          });
        }
      } else if (item.role === 'user') {
        const hasInlineData = (item.parts || []).some((p: any) => p.inlineData);
        if (hasInlineData) {
          const contentParts: any[] = [];
          for (const p of item.parts || []) {
            if (p.text) {
              contentParts.push({ type: 'text', text: p.text });
            } else if (p.inlineData) {
              const mime = p.inlineData.mimeType || 'image/png';
              const base64 = p.inlineData.data;
              contentParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${mime};base64,${base64}`,
                },
              });
            }
          }
          rawMessages.push({
            role: 'user',
            content: contentParts,
          });
        } else {
          const textParts = item.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('\n') || '';
          if (textParts || !item.parts || item.parts.length === 0) {
            rawMessages.push({
              role: 'user',
              content: textParts,
            });
          }
        }
        lastAssistantToolCalls = [];
      } else if (item.role === 'model') {
        const textParts = item.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('\n') || '';
        const functionCalls = item.parts?.filter((p: any) => p.functionCall).map((p: any) => p.functionCall) || [];

        if (functionCalls.length > 0) {
          const formattedToolCalls = functionCalls.map((fc: any, index: number) => ({
            id: fc.id || `call_${msgIdx}_${index}`,
            type: 'function' as const,
            function: {
              name: fc.name,
              arguments: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args || {}),
            },
          }));

          lastAssistantToolCalls = formattedToolCalls.map((tc) => ({ id: tc.id, name: tc.function.name }));

          rawMessages.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: formattedToolCalls,
          });
        } else {
          lastAssistantToolCalls = [];
          rawMessages.push({
            role: 'assistant',
            content: textParts,
          });
        }
      }
    }

    // 3. Dynamic Execution Context: Đính kèm theo cơ chế Append-Only Prefix Extension
    // để giữ trọn vẹn 100% KV-Cache Prefix qua các multi-step turns
    if (dynamicContext && dynamicContext.trim()) {
      if (stepSuffixes && (stepSuffixes instanceof Map ? stepSuffixes.size > 0 : Object.keys(stepSuffixes).length > 0)) {
        const getSuffix = (s: number) =>
          stepSuffixes instanceof Map ? stepSuffixes.get(s) : (stepSuffixes as Record<number, string>)[s];

        // Tìm tin nhắn user của turn hiện tại (quét ngược từ cuối lên)
        let turnStartIdx = -1;
        for (let i = rawMessages.length - 1; i >= 0; i--) {
          if (rawMessages[i].role === 'user') {
            turnStartIdx = i;
            break;
          }
        }

        if (turnStartIdx !== -1) {
          // Gắn Suffix Step 1 cố định vào user message của turn hiện tại
          const s1 = getSuffix(1);
          if (s1 && s1.trim()) {
            const userMsg = rawMessages[turnStartIdx];
            if (typeof userMsg.content === 'string') {
              userMsg.content = `${userMsg.content}\n\n[Execution Context & Plan Status]\n${s1.trim()}`;
            } else if (Array.isArray(userMsg.content)) {
              userMsg.content.push({
                type: 'text',
                text: `\n\n[Execution Context & Plan Status]\n${s1.trim()}`,
              });
            }
          }

          // Đối với các Step tiếp theo (Step 2, 3, ...), gắn suffix vào tool response cuối cùng của mỗi step
          let currentStep = 2;
          for (let i = turnStartIdx + 1; i < rawMessages.length; i++) {
            const isToolMessage = rawMessages[i].role === 'tool';
            const nextIsToolMessage = i + 1 < rawMessages.length && rawMessages[i + 1].role === 'tool';
            const isLastToolOfStep = isToolMessage && !nextIsToolMessage;

            if (isLastToolOfStep) {
              const sK = getSuffix(currentStep);
              if (sK && sK.trim()) {
                if (typeof rawMessages[i].content === 'string') {
                  rawMessages[i].content = `${rawMessages[i].content}\n\n[Execution Context & Plan Status]\n${sK.trim()}`;
                } else if (Array.isArray(rawMessages[i].content)) {
                  rawMessages[i].content.push({
                    type: 'text',
                    text: `\n\n[Execution Context & Plan Status]\n${sK.trim()}`,
                  });
                }
              }
              currentStep++;
            }
          }
        } else {
          rawMessages.push({
            role: 'user',
            content: `[Execution Context & Plan Status]\n${dynamicContext.trim()}`,
          });
        }
      } else {
        const lastUserMsg = [...rawMessages].reverse().find((m) => m.role === 'user');
        if (lastUserMsg) {
          if (typeof lastUserMsg.content === 'string') {
            lastUserMsg.content = `${lastUserMsg.content}\n\n[Execution Context & Plan Status]\n${dynamicContext.trim()}`;
          } else if (Array.isArray(lastUserMsg.content)) {
            lastUserMsg.content.push({
              type: 'text',
              text: `\n\n[Execution Context & Plan Status]\n${dynamicContext.trim()}`,
            });
          }
        } else {
          rawMessages.push({
            role: 'user',
            content: `[Execution Context & Plan Status]\n${dynamicContext.trim()}`,
          });
        }
      }
    }

    return this.sanitizeOpenAIMessages(rawMessages);
  }

  /**
   * Đảm bảo tính toàn vẹn và thứ tự hợp lệ nghiêm ngặt theo chuẩn OpenAI Message Order:
   * 1. Mọi tin nhắn role "tool" PHẢI có tool_call_id tương ứng trong message role "assistant" liền trước.
   * 2. Mọi tool_calls của assistant PHẢI có tool response tương ứng trước khi chuyển sang user/assistant mới.
   * 3. Tool call bị thiếu kết quả chỉ được khép lại bằng lỗi tường minh;
   *    tuyệt đối không bịa kết quả thành công.
   */
  private sanitizeOpenAIMessages(messages: any[]): any[] {
    const validMessages: any[] = [];
    let currentAssistantToolCalls: Map<string, boolean> | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'system') {
        validMessages.push(msg);
        continue;
      }

      if (msg.role === 'assistant') {
        // Nếu assistant message trước đó có tool_calls chưa được phản hồi đầy đủ
        if (currentAssistantToolCalls && currentAssistantToolCalls.size > 0) {
          for (const [missingId, answered] of currentAssistantToolCalls.entries()) {
            if (!answered) {
              validMessages.push(this.createMissingToolResult(missingId));
            }
          }
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          currentAssistantToolCalls = new Map();
          for (const tc of msg.tool_calls) {
            currentAssistantToolCalls.set(tc.id, false);
          }
        } else {
          currentAssistantToolCalls = null;
        }

        validMessages.push(msg);
        continue;
      }

      if (msg.role === 'tool') {
        // Tin nhắn tool chỉ hợp lệ nếu có assistant message trước đó gọi nó
        if (currentAssistantToolCalls && currentAssistantToolCalls.has(msg.tool_call_id)) {
          currentAssistantToolCalls.set(msg.tool_call_id, true);
          validMessages.push(msg);
        } else if (currentAssistantToolCalls && currentAssistantToolCalls.size > 0) {
          // Nếu tool_call_id không khớp trực tiếp, gán vào tool call chưa trả lời đầu tiên
          const unansweredEntry = Array.from(currentAssistantToolCalls.entries()).find(([_, answered]) => !answered);
          if (unansweredEntry) {
            const unansweredId = unansweredEntry[0];
            currentAssistantToolCalls.set(unansweredId, true);
            validMessages.push({
              ...msg,
              tool_call_id: unansweredId,
            });
          }
        }
        // Nếu không có assistant tool_calls nào đang chờ -> Bỏ qua tin nhắn tool mồ côi này để tránh 400
        continue;
      }

      if (msg.role === 'user') {
        // Nếu assistant trước đó có tool_calls chưa được trả lời hết trước khi có user message mới
        if (currentAssistantToolCalls && currentAssistantToolCalls.size > 0) {
          for (const [missingId, answered] of currentAssistantToolCalls.entries()) {
            if (!answered) {
              validMessages.push(this.createMissingToolResult(missingId));
            }
          }
          currentAssistantToolCalls = null;
        }

        validMessages.push(msg);
      }
    }

    // Nếu assistant message cuối cùng có tool_calls chưa được trả lời
    if (currentAssistantToolCalls && currentAssistantToolCalls.size > 0) {
      for (const [missingId, answered] of currentAssistantToolCalls.entries()) {
        if (!answered) {
          validMessages.push(this.createMissingToolResult(missingId));
        }
      }
    }

    return validMessages;
  }

  private createMissingToolResult(toolCallId: string): any {
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify({
        error: 'The tool call was not executed before the conversation advanced.',
        errorCode: 'TOOL_NOT_STARTED',
        retryable: true,
      }),
    };
  }

  /**
   * Sinh phản hồi thời gian thực qua Real-time Streaming với retry schedule chịu lỗi 84s
   */
  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const maxRetries = request?.maxRetries !== undefined
      ? request.maxRetries
      : (this.maxRetries !== undefined ? this.maxRetries : 10);

    return retryWithExponentialBackoff(
      () => this.generateStreamInternal(session, tools, callbacks, request),
      {
        maxRetries,
        baseDelayMs: 2000,
        maxDelayMs: 10000,
        signal: request?.signal,
        onRetry: (attempt, delayMs, classified) => {
          const payload = {
            attempt,
            maxRetries,
            delayMs,
            message: classified?.message,
          };
          callbacks?.onRetry?.(payload);
          request?.onRetry?.(payload);
        },
      },
    );
  }

  private async generateStreamInternal(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const messages = this.convertHistoryToOpenAIMessages(
      session,
      request?.systemPrompt || this.systemPrompt,
      request?.dynamicContext,
      request?.promptCacheBreakpoint,
      request?.stepSuffixes,
    );
    const openAITools = tools.length > 0 ? this.convertToolsToOpenAI(tools) : undefined;
    const endpoint = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;

    let effectiveModel = this.modelName;
    if (this.baseURL.includes('openrouter.ai')) {
      if (effectiveModel === 'deepseek-chat') {
        effectiveModel = 'deepseek/deepseek-chat';
      } else if (effectiveModel === 'deepseek-reasoner' || effectiveModel === 'deepseek-r1') {
        effectiveModel = 'deepseek/deepseek-r1';
      }
    } else if (this.baseURL.includes('deepseek.com')) {
      if (effectiveModel.startsWith('deepseek/')) {
        effectiveModel = effectiveModel.replace('deepseek/', '');
      }
    }

    // Các model suy luận chuyên sâu (reasoning models) như o1/o3/o4/sol
    const isReasoningModel =
      effectiveModel.startsWith('o1') ||
      effectiveModel.startsWith('o3') ||
      effectiveModel.startsWith('o4') ||
      effectiveModel.includes('sol') ||
      effectiveModel.includes('reasoner') ||
      effectiveModel.includes('r1');

    // Gửi session metadata và cache key qua HTTP Headers để hỗ trợ Sticky Affinity Routing trên Gateway/Proxy
    const promptCacheKey = createPromptCacheKey(request?.systemPrompt || this.systemPrompt, {
      provider: this.baseURL,
      model: effectiveModel,
      toolSchemaVersion: createToolSchemaVersion(openAITools),
      policyVersion: 'provider-cache-v2',
    });
    const affinityKey = (request?.sessionId || session.id || 'coding-agent-session')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 64);

    const requestBody: any = {
      model: effectiveModel,
      messages,
      tools: openAITools,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      ...openAIPromptCacheFields(this.baseURL, promptCacheKey, request),
    };
    // Use the portable named-function choice, not provider-specific allowed_tools.
    // The full schema stays stable for cache reuse.
    if (request?.functionCallingMode === 'ANY' && request.allowedFunctionNames?.length === 1) {
      const name = request.allowedFunctionNames[0];
      if (!tools.some(tool => tool.name === name)) throw new Error(`Forced tool is not declared: ${name}`);
      requestBody.tool_choice = { type: 'function', function: { name } };
      requestBody.parallel_tool_calls = false;
    }

    const effectiveTokenConfig = resolveTokenConfig(this.modelName, {
      ...this.tokenConfig,
      ...request?.tokenConfig,
    }, this.baseURL);
    // shortcut: frozen session effort wins on providers without per-message updates (keeps prefix cache).
    // Root cause: this class also serves gpt-*/o-* OpenAI-compatible endpoints, so derive the key from the model.
    effectiveTokenConfig.reasoningEffort = this.effortScope.forRequest(
      effectiveTokenConfig.reasoningEffort,
      getModelTokenProfile(effectiveModel, this.baseURL).provider,
    );

    // Cấu hình Output Tokens theo chuẩn OpenAI / DeepSeek / OpenRouter
    if (effectiveTokenConfig.maxOutputTokens) {
      if (
        effectiveModel.startsWith('o1') ||
        effectiveModel.startsWith('o3') ||
        effectiveModel.startsWith('o4') ||
        effectiveModel.startsWith('gpt-5.6-') ||
        effectiveModel.includes('sol') ||
        effectiveModel.includes('terra') ||
        effectiveModel.includes('luna')
      ) {
        requestBody.max_completion_tokens = effectiveTokenConfig.maxOutputTokens;
      } else {
        requestBody.max_tokens = effectiveTokenConfig.maxOutputTokens;
      }
    }

    // Cấu hình Reasoning Effort cho các reasoning models.
    // Root cause: OpenRouter Chat Completions không hiểu `reasoning_effort` (DeepSeek-style) lẫn
    // `thinking` (Anthropic Messages-style) — cả hai bị bỏ qua silently. Tham số chuẩn là `reasoning`
    // (docs: openrouter.ai/docs/guides/best-practices/reasoning-tokens).
    if (isReasoningModel && effectiveTokenConfig.reasoningEffort) {
      requestBody.reasoning_effort = effectiveTokenConfig.reasoningEffort;
      if (this.baseURL.includes('openrouter.ai')) {
        requestBody.reasoning = { effort: effectiveTokenConfig.reasoningEffort };
      }
    } else if (effectiveTokenConfig.thinkingBudget !== undefined && this.baseURL.includes('openrouter.ai')) {
      // `reasoning` chỉ nhận effort HOẶC max_tokens, không cả hai.
      requestBody.reasoning = { max_tokens: effectiveTokenConfig.thinkingBudget };
    }

    // Chỉ đặt temperature cho model thông thường (reasoning models dùng mặc định)
    if (!isReasoningModel) {
      requestBody.temperature = 0.2;
    }

    if (request?.signal?.aborted) {
      return {
        text: '',
        toolCalls: [],
        finishReason: 'aborted',
        rawFinishReason: 'aborted',
      };
    }

    const isLocalBaseUrl = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(:\d+)?/i.test(this.baseURL);
    const effectiveHeaderTimeoutMs = request?.headerTimeoutMs !== undefined
      ? request.headerTimeoutMs
      : this.headerTimeoutMs !== undefined
        ? this.headerTimeoutMs
        : DEFAULT_HEADER_TIMEOUT_MS;
    const effectiveChunkTimeoutMs = request?.chunkTimeoutMs !== undefined
      ? request.chunkTimeoutMs
      : this.chunkTimeoutMs !== undefined
        ? this.chunkTimeoutMs
        : (isLocalBaseUrl ? 0 : DEFAULT_CHUNK_TIMEOUT_MS);

    const headerAbortController = new AbortController();
    let headerTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let didHeaderTimeout = false;

    if (effectiveHeaderTimeoutMs > 0) {
      headerTimeoutTimer = setTimeout(() => {
        didHeaderTimeout = true;
        headerAbortController.abort();
      }, effectiveHeaderTimeoutMs);
    }

    const onUserAbort = () => {
      headerAbortController.abort();
    };
    if (request?.signal) {
      request.signal.addEventListener('abort', onUserAbort, { once: true });
    }

    let response: Response;
    try {
      // shortcut: OpenRouter gates some :free endpoints by agentic-harness app identity (HTTP-Referer).
      // The default is a placeholder — override with a listed app URL to pass the gate.
      const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': process.env.MINUS_OPENROUTER_REFERER || 'https://github.com/mini-agent-loop',
          'X-Title': process.env.MINUS_OPENROUTER_TITLE || 'Autonomous Coding Agent',
          'session-id': affinityKey,
          'X-Session-ID': affinityKey,
          ...this.extraHeaders,
        };
      response = this.baseURL.includes('/backend-api/codex') || this.extraHeaders.originator === 'codex_cli_rs'
        ? await fetchCodexResponse(this.baseURL, requestBody, headers, headerAbortController.signal)
        : await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: headerAbortController.signal,
      });
    } catch (err: any) {
      if (didHeaderTimeout) {
        const timeoutErr: any = new Error(`LLM API header timeout: Server did not return response headers within ${effectiveHeaderTimeoutMs}ms`);
        timeoutErr.name = 'HeaderTimeoutError';
        timeoutErr.code = 'HEADER_TIMEOUT';
        timeoutErr.statusCode = 408;
        throw timeoutErr;
      }
      if (err.name === 'AbortError' || request?.signal?.aborted) {
        return {
          text: '',
          toolCalls: [],
          finishReason: 'aborted',
          rawFinishReason: 'aborted',
        };
      }
      throw err;
    } finally {
      if (headerTimeoutTimer) clearTimeout(headerTimeoutTimer);
      if (request?.signal) {
        request.signal.removeEventListener('abort', onUserAbort);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      const err: any = new Error(`LLM API error (${response.status}): ${errorText}`);
      err.status = response.status;
      err.statusCode = response.status;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          err.retryAfterMs = seconds * 1000;
        }
      }
      try {
        const parsed = JSON.parse(errorText);
        err.errorResponse = parsed;
        if (parsed?.error) {
          if (parsed.error.code) err.code = parsed.error.code;
          if (parsed.error.type) err.type = parsed.error.type;
          if (parsed.error.message) err.providerMessage = parsed.error.message;
        }
      } catch {}
      throw err;
    }

    const requestStartTime = Date.now();
    let timeToFirstTokenMs: number | undefined;
    let fullText = '';
    let fullReasoning = '';
    const toolCallMap = new Map<number, { id: string; name: string; argsText: string }>();
    let rawFinishReason: string | undefined;
    let sawDoneMarker = false;
    let parsedUsage: LLMUsage | undefined;

    const processSseLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      if (trimmed === 'data: [DONE]') {
        sawDoneMarker = true;
        return;
      }

      let json: any;
      try {
        json = JSON.parse(trimmed.slice(5).trim());
      } catch (error) {
        throw new Error('LLM stream contained a malformed SSE JSON payload.', { cause: error });
      }

      if (json.usage) {
        const promptTokens = json.usage.prompt_tokens ?? 0;
        const completionTokens = json.usage.completion_tokens ?? 0;
        const totalTokens = json.usage.total_tokens ?? (promptTokens + completionTokens);
        const cachedTokens = json.usage.prompt_tokens_details?.cached_tokens
          ?? json.usage.prompt_cache_hit_tokens
          ?? json.usage.cache_read_input_tokens
          ?? 0;
        const cacheCreationInputTokens = json.usage.prompt_tokens_details?.cache_creation_input_tokens
          ?? json.usage.cache_creation_input_tokens
          ?? 0;
        const cacheReadInputTokens = cachedTokens;
        const cacheHitRate = promptTokens > 0 ? Number(((cachedTokens / promptTokens) * 100).toFixed(1)) : 0;

        parsedUsage = {
          promptTokens,
          completionTokens,
          totalTokens,
          cachedTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          cacheHitRate,
        };
      }

      const choice = json.choices?.[0];
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        rawFinishReason = String(choice.finish_reason);
      }
      const delta = choice?.delta;
      if (!delta) return;

      // shortcut: mỗi delta chỉ lấy ĐÚNG MỘT kênh reasoning rồi emit — các provider
      // OpenRouter có thể điền cả `reasoning` lẫn `reasoning_details[]` (hoặc `reasoning_content`)
      // cùng một nội dung trong cùng một delta, khiến mọi token bị append/emit 2 lần.
      // ceiling: nếu một provider gửi summary + text riêng biệt theo từng loại detail, cần merge theo `type`.
      const reasoningDelta = (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
        || (Array.isArray(delta.reasoning_details) ? delta.reasoning_details.map((d: any) => (typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : '')).join('') : '')
        || (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (reasoningDelta) {
        if (timeToFirstTokenMs === undefined) {
          timeToFirstTokenMs = Date.now() - requestStartTime;
        }
        fullReasoning += reasoningDelta;
        callbacks?.onThoughtToken?.(reasoningDelta);
      }

      if (delta.content) {
        if (timeToFirstTokenMs === undefined) {
          timeToFirstTokenMs = Date.now() - requestStartTime;
        }
        fullText += delta.content;
        callbacks?.onContentToken?.(delta.content);
      }

      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, { id: '', name: '', argsText: '' });
          }
          const entry = toolCallMap.get(idx)!;
          if (tc.id) entry.id += tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.argsText += tc.function.arguments;
        }
      }
    };

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let stalled = false;
      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (effectiveChunkTimeoutMs > 0) {
          stallTimer = setTimeout(() => { stalled = true; void reader.cancel().catch(() => {}); }, effectiveChunkTimeoutMs);
        }
      };
      try {
        resetStallTimer();
        while (true) {
          if (request?.signal?.aborted) {
            rawFinishReason = 'aborted';
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          resetStallTimer();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (request?.signal?.aborted) {
              rawFinishReason = 'aborted';
              break;
            }
            processSseLine(line);
          }
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }

      if (!request?.signal?.aborted) {
        buffer += decoder.decode();
        const tail = buffer.split('\n');
        // A stall can cut mid-line: the trailing fragment is unparseable JSON,
        // so drop it instead of throwing (complete lines were already processed).
        if (stalled) tail.pop();
        for (const line of tail) processSseLine(line);
      }
    }

    const toolCalls: (FunctionCall & { id?: string })[] = [];
    for (const [_, entry] of toolCallMap.entries()) {
      let args = {};
      let argumentsValid = true;
      try {
        args = entry.argsText ? JSON.parse(entry.argsText) : {};
      } catch {
        argumentsValid = false;
        args = {
          originalToolName: entry.name,
          rawArguments: entry.argsText,
        };
      }
      if (entry.name) {
        toolCalls.push({
          name: argumentsValid ? entry.name : '__invalid_tool_call__',
          args,
          id: entry.id || undefined,
        });
      }
    }

    const finishReason = request?.signal?.aborted
      ? 'aborted'
      : rawFinishReason
        ? normalizeOpenAIFinishReason(rawFinishReason)
        : sawDoneMarker
          ? 'unknown'
          : 'transport_eof';

    const requestDurationMs = Date.now() - requestStartTime;
    const usage: LLMUsage | undefined = parsedUsage
      ? {
          ...parsedUsage,
          timeToFirstTokenMs: parsedUsage.timeToFirstTokenMs ?? timeToFirstTokenMs,
          requestDurationMs: parsedUsage.requestDurationMs ?? requestDurationMs,
        }
      : (timeToFirstTokenMs !== undefined || requestDurationMs > 0)
        ? { timeToFirstTokenMs, requestDurationMs }
        : undefined;

    return {
      text: fullText || undefined,
      reasoningContent: fullReasoning || undefined,
      toolCalls: request?.signal?.aborted ? [] : toolCalls,
      finishReason,
      rawFinishReason: request?.signal?.aborted ? 'aborted' : rawFinishReason,
      usage,
    };
  }

  /**
   * Phương thức generate đồng bộ (tự động gọi generateStream)
   */
  async generate(session: Session, tools: FunctionDeclaration[], request?: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateStream(session, tools, undefined, request);
  }
}

function createToolSchemaVersion(tools: any[] | undefined): string {
  if (!tools || tools.length === 0) return 'no-tools';
  let hash = 2166136261;
  const value = JSON.stringify([...tools].sort((left, right) =>
    String(left?.function?.name || '').localeCompare(String(right?.function?.name || ''))));
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tools-${(hash >>> 0).toString(16)}`;
}

function normalizeOpenAIFinishReason(raw: string): LLMFinishReason {
  switch (raw.toLowerCase()) {
    case 'aborted':
      return 'aborted';
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    case 'aborted':
    case 'cancelled':
      return 'aborted';
    default:
      return 'unknown';
  }
}
