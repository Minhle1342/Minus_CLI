import type { Content, FunctionCall } from '@google/genai';

/**
 * Session quản lý lịch sử trò chuyện (conversation history) trong bộ nhớ (in-memory).
 * 
 * Lưu trữ tuần tự:
 * 1. User message (câu hỏi của người dùng)
 * 2. Model response (quyết định của AI, có thể chứa tool_call)
 * 3. Tool result (kết quả thực thi trả về từ Tool)
 * 4. Final response (câu trả lời cuối cùng của AI)
 */
export class Session {
  readonly id: string;
  readonly messages: Content[] = [];

  constructor(id: string = `session-${Date.now()}`) {
    this.id = id;
  }

  /**
   * Thêm tin nhắn từ người dùng vào session
   */
  addUserMessage(text: string): void {
    this.messages.push({
      role: 'user',
      parts: [{ text }],
    });
  }

  /**
   * Thêm phản hồi của Model vào session (chứa text, tool calls, hoặc raw Content để bảo toàn thought_signature)
   */
  addModelMessage(params: { text?: string; functionCalls?: FunctionCall[]; rawContent?: Content }): void {
    // Nếu có rawContent từ Gemini SDK, lưu trực tiếp để bảo toàn thought_signature và metadata nội bộ
    if (params.rawContent) {
      this.messages.push(params.rawContent);
      return;
    }

    const parts: any[] = [];
    
    if (params.text) {
      parts.push({ text: params.text });
    }

    if (params.functionCalls && params.functionCalls.length > 0) {
      for (const call of params.functionCalls) {
        parts.push({
          functionCall: {
            name: call.name,
            args: call.args || {},
          },
        });
      }
    }

    this.messages.push({
      role: 'model',
      parts,
    });
  }

  /**
   * Thêm kết quả thực thi của Tool (functionResponse) vào session
   */
  addToolResult(toolName: string, result: Record<string, any>): void {
    this.messages.push({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: toolName,
            response: result,
          },
        },
      ],
    });
  }

  /**
   * Lấy toàn bộ lịch sử tin nhắn để gửi cho LLM
   */
  getHistory(): Content[] {
    return this.messages;
  }
}
