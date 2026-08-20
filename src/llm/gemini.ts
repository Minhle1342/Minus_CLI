import { GoogleGenAI, type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';

export interface LLMResponse {
  text?: string;
  toolCalls: FunctionCall[];
  rawContent?: import('@google/genai').Content;
}

/**
 * GeminiLLM chịu trách nhiệm giao tiếp với Google Gemini API.
 * 
 * Luồng dữ liệu:
 * System Prompt + Session messages + Tool definitions ──> Gemini API ──> LLMResponse (text hoặc toolCalls)
 */
export class GeminiLLM {
  private client: GoogleGenAI;
  readonly modelName: string;
  readonly systemPrompt: string;

  constructor(
    apiKey: string,
    modelName: string = 'gemini-3.5-flash',
    systemPrompt: string = CODING_AGENT_SYSTEM_PROMPT
  ) {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY không được để trống.');
    }
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Gửi toàn bộ lịch sử trò chuyện và danh sách schema của tools cho Gemini
   */
  async generate(session: Session, tools: FunctionDeclaration[]): Promise<LLMResponse> {
    const contents = session.getHistory();

    const response = await this.client.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        systemInstruction: this.systemPrompt,
        // Chỉ truyền tools nếu có ít nhất 1 tool
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
      },
    });

    const candidate = response.candidates?.[0];
    const rawContent = candidate?.content;
    const toolCalls: FunctionCall[] = response.functionCalls || [];

    // Lấy text trực tiếp từ parts thay vì gọi getter response.text để tránh SDK in warning khi có functionCall
    let text: string | undefined;
    if (candidate?.content?.parts) {
      const textParts = candidate.content.parts
        .filter((part): part is { text: string } => 'text' in part && typeof (part as any).text === 'string')
        .map((part) => (part as any).text);
      if (textParts.length > 0) {
        text = textParts.join('\n');
      }
    }

    return {
      text,
      toolCalls,
      rawContent,
    };
  }
}
