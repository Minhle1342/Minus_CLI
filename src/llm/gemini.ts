import { GoogleGenAI, type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';

export interface StreamCallbacks {
  onThoughtToken?: (token: string) => void;
  onContentToken?: (token: string) => void;
}

export interface LLMResponse {
  text?: string;
  reasoningContent?: string;
  toolCalls: FunctionCall[];
  rawContent?: import('@google/genai').Content;
}

/**
 * GeminiLLM - Tích hợp Real-time Streaming & CoT Separation
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
   * Tạo phản hồi qua luồng Real-time Stream
   */
  async generateStream(
    session: Session,
    tools: FunctionDeclaration[],
    callbacks?: StreamCallbacks
  ): Promise<LLMResponse> {
    const contents = session.getHistory();

    const responseStream = await this.client.models.generateContentStream({
      model: this.modelName,
      contents,
      config: {
        systemInstruction: this.systemPrompt,
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
      },
    });

    const thoughtParts: string[] = [];
    const regularTextParts: string[] = [];
    const toolCalls: FunctionCall[] = [];
    let lastRawContent: any = undefined;

    for await (const chunk of responseStream) {
      const candidate = chunk.candidates?.[0];
      if (candidate?.content) {
        lastRawContent = candidate.content;
      }

      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        toolCalls.push(...chunk.functionCalls);
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

    return {
      text: regularTextParts.length > 0 ? regularTextParts.join('') : undefined,
      reasoningContent: thoughtParts.length > 0 ? thoughtParts.join('') : undefined,
      toolCalls,
      rawContent: lastRawContent,
    };
  }

  /**
   * Phương thức generate đồng bộ (tự động gọi generateStream)
   */
  async generate(session: Session, tools: FunctionDeclaration[]): Promise<LLMResponse> {
    return this.generateStream(session, tools);
  }
}
