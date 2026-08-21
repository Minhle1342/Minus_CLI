import { GoogleGenAI, type FunctionDeclaration, type FunctionCall } from '@google/genai';
import { Session } from '../session/session.js';
import { CODING_AGENT_SYSTEM_PROMPT } from './prompts.js';

export interface StreamCallbacks {
  onThoughtToken?: (token: string) => void;
  onContentToken?: (token: string) => void;
}

export interface LLMRequestOptions {
  systemPrompt?: string;
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
    callbacks?: StreamCallbacks,
    request?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    const contents = this.prepareContents(session);

    const responseStream = await this.client.models.generateContentStream({
      model: this.modelName,
      contents,
      config: {
        systemInstruction: request?.systemPrompt || this.systemPrompt,
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
      },
    });

    const thoughtParts: string[] = [];
    const regularTextParts: string[] = [];
    const toolCalls: FunctionCall[] = [];
    const streamedParts: any[] = [];

    for await (const chunk of responseStream) {
      const candidate = chunk.candidates?.[0];
      if (candidate?.content?.parts) {
        streamedParts.push(...candidate.content.parts.map((part: any) => cloneJson(part)));
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
    };
  }

  /**
   * Gemini thinking signatures are opaque and cannot be reconstructed. Legacy
   * unsigned tool exchanges remain durable in Session, but are omitted from a
   * Gemini request together with their matching results.
   */
  private prepareContents(session: Session): import('@google/genai').Content[] {
    const history = session.getHistory();
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
