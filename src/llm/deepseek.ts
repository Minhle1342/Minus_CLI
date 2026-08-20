import { type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { LLMResponse, StreamCallbacks } from './gemini.js';

export interface DeepseekLLMOptions {
  modelName?: string;
  apiKey?: string;
  baseURL?: string;
  systemPrompt?: string;
}

/**
 * DeepseekLLM - Hỗ trợ DeepSeek Chat, DeepSeek Coder, DeepSeek R1 & Groq Gemma
 * 
 * Tích hợp:
 * 1. OpenAI-compatible Function Calling format.
 * 2. Deterministic Tool Ordering để tối đa hóa KV-Cache hit rate (>80%).
 * 3. Real-time Streaming & SSE Chunk Parsing cho cả System 2 Thinking và System 1 Actions.
 */
export class DeepseekLLM {
  readonly modelName: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly systemPrompt: string;

  constructor(
    apiKeyOrOptions?: string | DeepseekLLMOptions,
    modelName?: string,
    systemPrompt?: string,
    baseURL?: string
  ) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.modelName = apiKeyOrOptions.modelName || 'deepseek-chat';
      this.apiKey = apiKeyOrOptions.apiKey || process.env.DEEPSEEK_API_KEY || '';
      this.baseURL = apiKeyOrOptions.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
      this.systemPrompt = apiKeyOrOptions.systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
    } else {
      this.apiKey = apiKeyOrOptions || process.env.DEEPSEEK_API_KEY || '';
      this.modelName = modelName || 'deepseek-chat';
      this.systemPrompt = systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
      this.baseURL = baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    }

    if (!this.apiKey) {
      throw new Error('API key không được để trống khi khởi tạo DeepseekLLM / OpenAI-compatible provider.');
    }
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
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * Chuyển đổi Session History sang định dạng messages của OpenAI/DeepSeek
   */
  private convertHistoryToOpenAIMessages(session: Session): any[] {
    const history = session.getHistory();
    const messages: any[] = [];

    // 1. Luôn đưa System Prompt lên đầu tiên để cố định KV-Cache Prefix
    messages.push({
      role: 'system',
      content: this.systemPrompt,
    });

    // 2. Chuyển đổi các lượt tin nhắn trong Session
    for (const item of history) {
      if (item.role === 'user') {
        const textParts = item.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('\n') || '';
        messages.push({
          role: 'user',
          content: textParts,
        });
      } else if (item.role === 'model') {
        const textParts = item.parts?.filter((p: any) => p.text).map((p: any) => p.text).join('\n') || '';
        const functionCalls = item.parts?.filter((p: any) => p.functionCall).map((p: any) => p.functionCall) || [];

        if (functionCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: functionCalls.map((fc: any, index: number) => ({
              id: `call_${Date.now()}_${index}`,
              type: 'function',
              function: {
                name: fc.name,
                arguments: JSON.stringify(fc.args || {}),
              },
            })),
          });
        } else {
          messages.push({
            role: 'assistant',
            content: textParts,
          });
        }
      } else if (item.role === 'function' || item.role === 'tool') {
        const functionResponses = item.parts?.filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse) || [];
        for (const fr of functionResponses) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(fr.response?.result || fr.response || {}),
            tool_call_id: `call_${fr.name}`,
          });
        }
      }
    }

    return messages;
  }

  /**
   * Sinh phản hồi thời gian thực qua Real-time Streaming
   */
  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks
  ): Promise<LLMResponse> {
    const messages = this.convertHistoryToOpenAIMessages(session);
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

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/mini-agent-loop',
        'X-Title': 'Autonomous Coding Agent',
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages,
        tools: openAITools,
        stream: true,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${errorText}`);
    }

    let fullText = '';
    let fullReasoning = '';
    const toolCallMap = new Map<number, { name: string; argsText: string }>();

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

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          if (trimmed === 'data: [DONE]') continue;

          try {
            const json = JSON.parse(trimmed.slice(5).trim());
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;

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
                  toolCallMap.set(idx, { name: '', argsText: '' });
                }
                const entry = toolCallMap.get(idx)!;
                if (tc.function?.name) entry.name += tc.function.name;
                if (tc.function?.arguments) entry.argsText += tc.function.arguments;
              }
            }
          } catch {
            // Bỏ qua dòng json không hợp lệ
          }
        }
      }
    }

    const toolCalls: FunctionCall[] = [];
    for (const [_, entry] of toolCallMap.entries()) {
      let args = {};
      try {
        args = entry.argsText ? JSON.parse(entry.argsText) : {};
      } catch {
        args = {};
      }
      if (entry.name) {
        toolCalls.push({
          name: entry.name,
          args,
        });
      }
    }

    return {
      text: fullText || undefined,
      reasoningContent: fullReasoning || undefined,
      toolCalls,
    };
  }

  /**
   * Phương thức generate đồng bộ (tự động gọi generateStream)
   */
  async generate(session: Session, tools: FunctionDeclaration[]): Promise<LLMResponse> {
    return this.generateStream(session, tools);
  }
}
