import { type FunctionCall, type FunctionDeclaration } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';
import {
  LLMResponse,
  LLMRequestOptions,
  StreamCallbacks,
  type LLMFinishReason,
  type LLMUsage,
} from './gemini.js';
import { TokenConfig, resolveTokenConfig } from './token-config.js';

export interface AnthropicLLMOptions {
  modelName?: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
  extraHeaders?: Record<string, string>;
  tokenConfig?: Partial<TokenConfig>;
}

/**
 * Native Anthropic Messages API adapter.
 *
 * The rest of the agent stores messages in the Google GenAI-compatible
 * Session format, so this adapter translates history and tools at the edge
 * and returns the same LLMResponse contract as the other providers.
 */
export class AnthropicLLM {
  readonly modelName: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly systemPrompt: string;
  readonly extraHeaders: Record<string, string>;
  private tokenConfig: TokenConfig;

  constructor(
    apiKeyOrOptions?: string | AnthropicLLMOptions,
    modelName?: string,
    systemPrompt?: string,
    baseURL?: string,
    extraHeaders?: Record<string, string>,
    tokenConfig?: Partial<TokenConfig>,
  ) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.modelName = apiKeyOrOptions.modelName || 'claude-sonnet-5';
      this.apiKey = apiKeyOrOptions.apiKey || process.env.ANTHROPIC_API_KEY || '';
      this.baseURL = apiKeyOrOptions.baseURL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
      this.systemPrompt = apiKeyOrOptions.systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
      this.extraHeaders = apiKeyOrOptions.extraHeaders || {};
      this.tokenConfig = resolveTokenConfig(this.modelName, apiKeyOrOptions.tokenConfig, this.baseURL);
    } else {
      this.apiKey = apiKeyOrOptions || process.env.ANTHROPIC_API_KEY || '';
      this.modelName = modelName || 'claude-sonnet-5';
      this.systemPrompt = systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
      this.baseURL = baseURL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
      this.extraHeaders = extraHeaders || {};
      this.tokenConfig = resolveTokenConfig(this.modelName, tokenConfig, this.baseURL);
    }

    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY không được để trống khi khởi tạo AnthropicLLM.');
    }
  }

  getTokenConfig(): TokenConfig {
    return { ...this.tokenConfig };
  }

  setTokenConfig(config: Partial<TokenConfig>): void {
    this.tokenConfig = resolveTokenConfig(this.modelName, { ...this.tokenConfig, ...config }, this.baseURL);
  }

  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const effectiveTokenConfig = resolveTokenConfig(this.modelName, {
      ...this.tokenConfig,
      ...request?.tokenConfig,
    }, this.baseURL);
    const body: Record<string, any> = {
      model: this.modelName,
      system: request?.systemPrompt || this.systemPrompt,
      messages: this.convertHistoryToAnthropicMessages(session, request?.dynamicContext),
      max_tokens: effectiveTokenConfig.maxOutputTokens || 8192,
      stream: true,
      tools: tools.length > 0 ? this.convertTools(tools) : undefined,
      temperature: 0.2,
    };
    if (request?.enablePromptCaching !== false) {
      // Anthropic automatic caching advances the breakpoint with the growing
      // conversation while keeping tools -> system -> messages prefix order.
      body.cache_control = { type: 'ephemeral' };
    }

    const response = await fetch(`${this.baseURL.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }
    if (!response.body) {
      throw new Error('Anthropic API returned an empty streaming body.');
    }

    let fullText = '';
    let fullReasoning = '';
    let stopReason: string | undefined;
    let usage: LLMUsage | undefined;
    const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
    const decoder = new TextDecoder();
    let buffer = '';

    const processEvent = (eventData: string): void => {
      if (!eventData.trim()) return;
      let event: any;
      try {
        event = JSON.parse(eventData);
      } catch (error) {
        throw new Error('Anthropic stream contained a malformed SSE JSON payload.', { cause: error });
      }

      if (event.type === 'error') {
        const errorType = event.error?.type || 'stream_error';
        const errorMessage = event.error?.message || 'Anthropic streaming request failed.';
        throw new Error(`Anthropic stream error (${errorType}): ${errorMessage}`);
      } else if (event.type === 'message_start') {
        const eventUsage = event.message?.usage || {};
        const uncachedInputTokens = eventUsage.input_tokens ?? 0;
        const cacheCreationInputTokens = eventUsage.cache_creation_input_tokens ?? 0;
        const cacheReadInputTokens = eventUsage.cache_read_input_tokens ?? 0;
        const promptTokens = uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
        usage = {
          promptTokens,
          completionTokens: eventUsage.output_tokens ?? 0,
          totalTokens: promptTokens + (eventUsage.output_tokens ?? 0),
          cachedTokens: cacheReadInputTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          cacheHitRate: promptTokens > 0 ? Number(((cacheReadInputTokens / promptTokens) * 100).toFixed(1)) : 0,
        };
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          toolBlocks.set(event.index, {
            id: block.id || `toolu_${event.index}`,
            name: block.name || '__invalid_tool_call__',
            inputJson: '',
          });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          fullText += delta.text;
          callbacks?.onContentToken?.(delta.text);
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          fullReasoning += delta.thinking;
          callbacks?.onThoughtToken?.(delta.thinking);
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const block = toolBlocks.get(event.index);
          if (block) block.inputJson += delta.partial_json;
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta?.stop_reason || stopReason;
        const inputTokens = usage?.promptTokens ?? 0;
        const outputTokens = event.usage?.output_tokens ?? 0;
        usage = {
          ...usage,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    };

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      let dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line.trim() === '' && dataLines.length > 0) {
          processEvent(dataLines.join('\n'));
          dataLines = [];
        }
      }
      if (dataLines.length > 0) {
        processEvent(dataLines.join('\n'));
      }
    }
    const trailing = decoder.decode();
    if (trailing) buffer += trailing;
    if (buffer.startsWith('data:')) processEvent(buffer.slice(5).trim());

    const toolCalls: FunctionCall[] = Array.from(toolBlocks.values()).map((block) => {
      let args: Record<string, any> = {};
      if (block.inputJson.trim()) {
        try {
          args = JSON.parse(block.inputJson);
        } catch {
          args = { __raw_input_json: block.inputJson };
        }
      }
      return { id: block.id, name: block.name, args } as FunctionCall;
    });
    const rawParts: any[] = [];
    if (fullText) rawParts.push({ text: fullText });
    for (const call of toolCalls) {
      rawParts.push({ functionCall: { id: (call as any).id, name: call.name, args: call.args || {} } });
    }

    return {
      text: fullText || undefined,
      reasoningContent: fullReasoning || undefined,
      toolCalls,
      rawContent: rawParts.length > 0 ? { role: 'model', parts: rawParts } : undefined,
      finishReason: normalizeAnthropicFinishReason(stopReason, toolCalls.length > 0),
      rawFinishReason: stopReason,
      usage,
    };
  }

  async generate(session: Session, tools: FunctionDeclaration[], request?: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateStream(session, tools, undefined, request);
  }

  private convertTools(tools: FunctionDeclaration[]): any[] {
    return [...tools]
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: normalizeSchema(tool.parameters || { type: 'object', properties: {} }),
      }));
  }

  private convertHistoryToAnthropicMessages(session: Session, dynamicContext?: string): any[] {
    const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];
    const history = session.getHistory();

    for (const item of history) {
      const functionResponses = item.parts?.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse) || [];
      if (functionResponses.length > 0) {
        messages.push({
          role: 'user',
          content: functionResponses.map((response: any, index: number) => ({
            type: 'tool_result',
            tool_use_id: response.id || response.toolCallId || `call_tool_${index}`,
            content: typeof response.response === 'string'
              ? response.response
              : JSON.stringify(response.response?.result ?? response.response ?? {}),
          })),
        });
        continue;
      }

      if (item.role === 'user') {
        const content: any[] = [];
        for (const part of item.parts || []) {
          if (typeof part.text === 'string' && !part.thought) content.push({ type: 'text', text: part.text });
          if (part.inlineData?.data) {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.inlineData.mimeType || 'image/png',
                data: part.inlineData.data,
              },
            });
          }
        }
        messages.push({ role: 'user', content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
      } else if (item.role === 'model') {
        const content: any[] = [];
        for (const part of item.parts || []) {
          if (typeof part.text === 'string' && !part.thought) content.push({ type: 'text', text: part.text });
          if (part.functionCall) {
            content.push({
              type: 'tool_use',
              id: part.functionCall.id || `call_${messages.length}_${content.length}`,
              name: part.functionCall.name,
              input: part.functionCall.args || {},
            });
          }
        }
        messages.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
      }
    }

    if (dynamicContext?.trim()) {
      const contextBlock = { type: 'text', text: `[Execution Context & Plan Status]\n${dynamicContext.trim()}` };
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      if (lastUser) {
        lastUser.content = Array.isArray(lastUser.content) ? [...lastUser.content, contextBlock] : [lastUser.content, contextBlock];
      } else {
        messages.push({ role: 'user', content: [contextBlock] });
      }
    }

    if (messages.length === 0) messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });

    // Anthropic requires alternating user/assistant roles. Tool results are
    // user blocks, so merge adjacent messages without changing block order.
    const normalized: typeof messages = [];
    for (const message of messages) {
      const previous = normalized[normalized.length - 1];
      if (previous?.role === message.role) {
        previous.content = [
          ...(Array.isArray(previous.content) ? previous.content : [previous.content]),
          ...(Array.isArray(message.content) ? message.content : [message.content]),
        ];
      } else {
        normalized.push({ ...message, content: Array.isArray(message.content) ? [...message.content] : message.content });
      }
    }
    return normalized;
  }
}

function normalizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  const normalized: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') normalized.type = value.toLowerCase();
    else if (key === 'properties' && value && typeof value === 'object') {
      normalized.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeSchema(child)]));
    } else if (key === 'items') normalized.items = normalizeSchema(value);
    else normalized[key] = normalizeSchema(value);
  }
  if (normalized.type === 'object' && !normalized.properties) normalized.properties = {};
  return normalized;
}

function normalizeAnthropicFinishReason(raw: string | undefined, hasToolCalls: boolean): LLMFinishReason {
  if (hasToolCalls || raw === 'tool_use') return 'tool_calls';
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}
