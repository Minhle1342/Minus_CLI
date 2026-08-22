import { type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { LLMResponse, LLMRequestOptions, StreamCallbacks, type LLMFinishReason } from './gemini.js';

export interface DeepseekLLMOptions {
  modelName?: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * DeepseekLLM - Hỗ trợ DeepSeek, OpenAI Codex, GPT-5.6 (Sol/Terra/Luna), Groq & OpenAI-compatible APIs
 * 
 * Tích hợp:
 * 1. OpenAI-compatible Function Calling format.
 * 2. Deterministic Tool Ordering để tối đa hóa KV-Cache hit rate (>80%).
 * 3. Real-time Streaming & SSE Chunk Parsing cho cả System 2 Thinking và System 1 Actions.
 * 4. Tự động hỗ trợ headers tùy chỉnh (như chatgpt-account-id cho ChatGPT Plus OAuth).
 */
export class DeepseekLLM {
  readonly modelName: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly systemPrompt: string;
  readonly extraHeaders: Record<string, string>;

  constructor(
    apiKeyOrOptions?: string | DeepseekLLMOptions,
    modelName?: string,
    systemPrompt?: string,
    baseURL?: string,
    extraHeaders?: Record<string, string>
  ) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.modelName = apiKeyOrOptions.modelName || 'deepseek-chat';
      this.apiKey = apiKeyOrOptions.apiKey || process.env.DEEPSEEK_API_KEY || '';
      this.baseURL = apiKeyOrOptions.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
      this.systemPrompt = apiKeyOrOptions.systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
      this.extraHeaders = apiKeyOrOptions.extraHeaders || {};
    } else {
      this.apiKey = apiKeyOrOptions || process.env.DEEPSEEK_API_KEY || '';
      this.modelName = modelName || 'deepseek-chat';
      this.systemPrompt = systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
      this.baseURL = baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
      this.extraHeaders = extraHeaders || {};
    }

    if (!this.apiKey) {
      throw new Error('API key không được để trống khi khởi tạo DeepseekLLM / OpenAI-compatible provider.');
    }
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
   */
  private convertHistoryToOpenAIMessages(session: Session, systemPrompt: string): any[] {
    const history = session.getHistory();
    const rawMessages: any[] = [];

    // 1. Luôn đưa System Prompt lên đầu tiên để cố định KV-Cache Prefix
    rawMessages.push({
      role: 'system',
      content: systemPrompt,
    });

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
        const textParts = item.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('\n') || '';
        if (textParts || !item.parts || item.parts.length === 0) {
          rawMessages.push({
            role: 'user',
            content: textParts,
          });
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
   * Sinh phản hồi thời gian thực qua Real-time Streaming
   */
  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const messages = this.convertHistoryToOpenAIMessages(session, request?.systemPrompt || this.systemPrompt);
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

    const requestBody: any = {
      model: effectiveModel,
      messages,
      tools: openAITools,
      stream: true,
    };

    // Chỉ đặt temperature cho model thông thường (reasoning models dùng mặc định)
    if (!isReasoningModel) {
      requestBody.temperature = 0.2;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/mini-agent-loop',
        'X-Title': 'Autonomous Coding Agent',
        ...this.extraHeaders,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (${response.status}): ${errorText}`);
    }

    let fullText = '';
    let fullReasoning = '';
    const toolCallMap = new Map<number, { id: string; name: string; argsText: string }>();
    let rawFinishReason: string | undefined;
    let sawDoneMarker = false;

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

      const choice = json.choices?.[0];
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        rawFinishReason = String(choice.finish_reason);
      }
      const delta = choice?.delta;
      if (!delta) return;

      if (delta.reasoning_content) {
        fullReasoning += delta.reasoning_content;
        callbacks?.onThoughtToken?.(delta.reasoning_content);
      }

      if (delta.content) {
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) processSseLine(line);
      }

      buffer += decoder.decode();
      for (const line of buffer.split('\n')) processSseLine(line);
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

    const finishReason = rawFinishReason
      ? normalizeOpenAIFinishReason(rawFinishReason)
      : sawDoneMarker
        ? 'unknown'
        : 'transport_eof';

    return {
      text: fullText || undefined,
      reasoningContent: fullReasoning || undefined,
      toolCalls,
      finishReason,
      rawFinishReason,
    };
  }

  /**
   * Phương thức generate đồng bộ (tự động gọi generateStream)
   */
  async generate(session: Session, tools: FunctionDeclaration[], request?: LLMRequestOptions): Promise<LLMResponse> {
    return this.generateStream(session, tools, undefined, request);
  }
}

function normalizeOpenAIFinishReason(raw: string): LLMFinishReason {
  switch (raw.toLowerCase()) {
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
