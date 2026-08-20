import type { FunctionDeclaration, FunctionCall } from '@google/genai';
import { LLMResponse } from './gemini.js';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';

/**
 * Chuyển đổi Gemini FunctionDeclaration Schema (Type.STRING,...) sang chuẩn JSON Schema của OpenAI/DeepSeek (chữ thường)
 */
function convertToOpenAISchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const converted: any = Array.isArray(schema) ? [] : {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      converted[key] = value.toLowerCase();
    } else if (typeof value === 'object') {
      converted[key] = convertToOpenAISchema(value);
    } else {
      converted[key] = value;
    }
  }
  return converted;
}

/**
 * DeepseekLLM - Adapter kết nối với DeepSeek API (hoặc OpenRouter / Groq / Ollama / OpenAI-compatible endpoint).
 * 
 * Hỗ trợ các model chuyên coding của DeepSeek:
 * - deepseek-chat (V3 - mô hình tối ưu hàng đầu cho coding, hỗ trợ Function Calling)
 * - deepseek-reasoner (R1 - mô hình lý luận sâu Chain of Thought)
 * - deepseek/deepseek-chat:free (nếu dùng qua OpenRouter endpoint)
 */
export class DeepseekLLM {
  readonly modelName: string;
  readonly systemPrompt: string;
  readonly baseURL: string;
  private apiKey: string;

  constructor(
    apiKey: string,
    modelName: string = 'deepseek-chat',
    systemPrompt: string = CODING_AGENT_SYSTEM_PROMPT,
    baseURL?: string
  ) {
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.systemPrompt = systemPrompt || CODING_AGENT_SYSTEM_PROMPT;
    
    // Tự động nhận diện baseURL từ biến môi trường hoặc dựa vào apiKey/modelName
    let defaultURL = 'https://api.deepseek.com';
    if (this.apiKey?.startsWith('sk-or-') || this.modelName.startsWith('openrouter/') || this.modelName.includes('/')) {
      defaultURL = 'https://openrouter.ai/api/v1';
    }
    const rawURL = baseURL || process.env.DEEPSEEK_BASE_URL || defaultURL;
    this.baseURL = rawURL.endsWith('/') ? rawURL.slice(0, -1) : rawURL;
  }

  async generate(session: Session, tools: FunctionDeclaration[]): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY chưa được cấu hình. Vui lòng thêm DEEPSEEK_API_KEY vào file .env.'
      );
    }

    const messages: any[] = [];

    // 1. Thêm System Prompt
    if (this.systemPrompt) {
      messages.push({
        role: 'system',
        content: this.systemPrompt,
      });
    }

    // 2. Chuyển đổi lịch sử Session của Gemini sang format OpenAI Messages
    let callCounter = 0;
    const history = session.getHistory();

    for (const msg of history) {
      if (msg.role === 'user') {
        const funcRespPart = msg.parts?.find((p: any) => p.functionResponse);
        if (funcRespPart && (funcRespPart as any).functionResponse) {
          const resp = (funcRespPart as any).functionResponse;
          messages.push({
            role: 'tool',
            tool_call_id: `call_${resp.name}_${callCounter > 0 ? callCounter - 1 : 0}`,
            name: resp.name,
            content: JSON.stringify(resp.response ?? {}),
          });
        } else {
          const text = msg.parts?.map((p: any) => p.text).filter(Boolean).join('\n') || '';
          messages.push({
            role: 'user',
            content: text,
          });
        }
      } else if (msg.role === 'model') {
        const funcCallParts = msg.parts?.filter((p: any) => p.functionCall);
        const textParts = msg.parts?.map((p: any) => p.text).filter(Boolean).join('\n');

        if (funcCallParts && funcCallParts.length > 0) {
          const openAIToolCalls = funcCallParts.map((p: any) => {
            const fc = p.functionCall;
            const callId = `call_${fc.name}_${callCounter++}`;
            return {
              id: callId,
              type: 'function',
              function: {
                name: fc.name,
                arguments: JSON.stringify(fc.args || {}),
              },
            };
          });

          messages.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: openAIToolCalls,
          });
        } else {
          messages.push({
            role: 'assistant',
            content: textParts || '',
          });
        }
      }
    }

    // 3. Chuyển đổi Tools sang chuẩn OpenAI Function Calling (Sắp xếp cố định để tối ưu KV-Cache Prefix Hit)
    const sortedTools = [...tools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const openAITools = sortedTools.length > 0
      ? sortedTools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: convertToOpenAISchema(tool.parameters),
          },
        }))
      : undefined;

    const endpoint = this.baseURL.endsWith('/v1')
      ? `${this.baseURL}/chat/completions`
      : `${this.baseURL}/chat/completions`.includes('openrouter') || `${this.baseURL}`.endsWith('/api/v1')
        ? `${this.baseURL}/chat/completions`
        : `${this.baseURL}/v1/chat/completions`;

    // Chuẩn hoá modelName tự động: OpenRouter yêu cầu "deepseek/deepseek-chat", DeepSeek Direct yêu cầu "deepseek-chat"
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

    // 4. Gửi HTTP Request trực tiếp bằng fetch()
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
        temperature: 0.2, // Tối ưu cho code chính xác
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];
    const message = choice?.message;

    const toolCalls: FunctionCall[] = [];
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        let args = {};
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          args = {};
        }
        toolCalls.push({
          name: tc.function.name,
          args,
        });
      }
    }

    const text = message?.content || undefined;
    // Bóc tách luồng suy luận sâu (System 2 Deep Reasoning) từ DeepSeek R1 / Reasoning models
    const reasoningContent = message?.reasoning_content || undefined;

    return {
      text,
      reasoningContent,
      toolCalls,
    };
  }
}
