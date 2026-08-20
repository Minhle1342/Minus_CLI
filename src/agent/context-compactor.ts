import { ContentPart, SessionMessage } from '../session/session.js';

export interface CompactionConfig {
  maxCharactersPerToolResult?: number;
  preserveLastNToolResults?: number;
  maxTotalHistoryLength?: number;
}

export interface CompactionStats {
  originalLength: number;
  compactedLength: number;
  charsSaved: number;
  prunedPartsCount: number;
}

/**
 * ContextCompactor - Động cơ nén và quản lý ngân sách Token (Context Engineering)
 * 
 * Giúp ngăn chặn tình trạng "Context Pollution" (tràn bộ nhớ ngữ cảnh):
 * 1. Giữ nguyên 100% chi tiết của các bước mới nhất (Last N observations).
 * 2. Tự động thu gọn (prune) các output log dài hoặc nội dung file khổng lồ của các bước cũ.
 * 3. Bảo toàn nguyên vẹn System Prompt, User Prompt và chuỗi lập luận cốt lõi.
 */
export class ContextCompactor {
  private config: Required<CompactionConfig>;

  constructor(config?: CompactionConfig) {
    this.config = {
      maxCharactersPerToolResult: config?.maxCharactersPerToolResult ?? 1500,
      preserveLastNToolResults: config?.preserveLastNToolResults ?? 4,
      maxTotalHistoryLength: config?.maxTotalHistoryLength ?? 40000,
    };
  }

  /**
   * Thực hiện nén và tối ưu hoá danh sách tin nhắn trong Session
   */
  compact(messages: SessionMessage[]): { messages: SessionMessage[]; stats: CompactionStats } {
    let originalLength = 0;
    let compactedLength = 0;
    let prunedPartsCount = 0;

    // Tính tổng ký tự ban đầu
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.text) originalLength += part.text.length;
        if (part.functionResponse) originalLength += JSON.stringify(part.functionResponse).length;
        if (part.functionCall) originalLength += JSON.stringify(part.functionCall).length;
      }
    }

    // Đếm số lượng tool results để biết tin nào là gần đây
    let toolResultIndices: number[] = [];
    messages.forEach((msg, idx) => {
      if (msg.parts?.some((p) => p.functionResponse)) {
        toolResultIndices.push(idx);
      }
    });

    const cutoffIndex = toolResultIndices.length > this.config.preserveLastNToolResults
      ? toolResultIndices[toolResultIndices.length - this.config.preserveLastNToolResults]
      : -1;

    const compactedMessages: SessionMessage[] = messages.map((msg, msgIdx) => {
      const isOldToolResult = cutoffIndex >= 0 && msgIdx < cutoffIndex && msg.parts?.some((p) => p.functionResponse);

      if (!isOldToolResult) {
        return msg;
      }

      // Nén các tool response cũ
      const newParts: ContentPart[] = (msg.parts || []).map((part) => {
        if (!part.functionResponse) {
          return part;
        }

        const resp = part.functionResponse;
        const respStr = JSON.stringify(resp.response || {});

        if (respStr.length <= this.config.maxCharactersPerToolResult) {
          return part;
        }

        prunedPartsCount++;
        let compressedPayload: any;

        if (typeof resp.response === 'object' && resp.response !== null) {
          const r = resp.response as Record<string, any>;
          if (r.content !== undefined) {
            const rawContent = String(r.content);
            const lineCount = rawContent.split('\n').length;
            compressedPayload = {
              path: r.path,
              summary: `[Nội dung file ${lineCount} dòng đã được nén tối ưu. Dùng read_file nếu cần đọc lại chi tiết]`,
              preview: rawContent.slice(0, 300) + '...',
            };
          } else if (r.stdout !== undefined || r.stderr !== undefined) {
            compressedPayload = {
              exitCode: r.exitCode,
              summary: `[Log thực thi dài đã được nén tối ưu]`,
              preview: String(r.stdout || r.stderr || '').slice(0, 200) + '...',
            };
          } else if (Array.isArray(r.matches)) {
            compressedPayload = {
              totalMatches: r.totalMatches || r.matches.length,
              summary: `[Tìm thấy ${r.totalMatches || r.matches.length} kết quả]`,
            };
          } else {
            compressedPayload = {
              summary: `[Output dài (${respStr.length} ký tự) đã được cắt ngắn]`,
              preview: respStr.slice(0, 200) + '...',
            };
          }
        } else {
          compressedPayload = {
            summary: `[Dữ liệu đã được nén: ${String(resp.response).slice(0, 200)}...]`,
          };
        }

        return {
          functionResponse: {
            name: resp.name,
            response: compressedPayload,
          },
        };
      });

      return {
        role: msg.role,
        parts: newParts,
      };
    });

    // Tính tổng ký tự sau khi nén
    for (const msg of compactedMessages) {
      for (const part of msg.parts || []) {
        if (part.text) compactedLength += part.text.length;
        if (part.functionResponse) compactedLength += JSON.stringify(part.functionResponse).length;
        if (part.functionCall) compactedLength += JSON.stringify(part.functionCall).length;
      }
    }

    const stats: CompactionStats = {
      originalLength,
      compactedLength,
      charsSaved: Math.max(0, originalLength - compactedLength),
      prunedPartsCount,
    };

    return { messages: compactedMessages, stats };
  }
}
