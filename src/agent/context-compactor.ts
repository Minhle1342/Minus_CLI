import { ContentPart, SessionMessage } from '../session/session.js';
import { SemanticSlicer } from './semantic-slicer.js';
import { assertHistoryToolPairing } from '../session/session-invariants.js';

export interface CompactionConfig {
  maxCharactersPerToolResult?: number;
  preserveLastNToolResults?: number;
  maxTotalHistoryTokens?: number;
  preservePrefixCache?: boolean;
}

export interface CompactionStats {
  originalTokens: number;
  compactedTokens: number;
  tokensSaved: number;
  originalLength: number;
  compactedLength: number;
  charsSaved: number;
  prunedPartsCount: number;
  requestOverheadTokens: number;
  outputReserveTokens: number;
  effectiveHistoryBudgetTokens: number;
}

export interface CompactionOptions {
  force?: boolean;
  requestOverheadTokens?: number;
  outputReserveTokens?: number;
  triggerRatio?: number;
}

/**
 * ContextCompactor - Động cơ Nén Ngữ Cảnh & Quản Lý Ngân Sách Token (Phase 3 - Production)
 * 
 * Áp dụng các kỹ thuật:
 * 1. Prefix-Safe KV-Cache Preservation: Bảo toàn tiền tố lịch sử tin nhắn tránh vỡ KV-Cache của OpenAI/Codex.
 * 2. Selective Sliding Window: Giữ nguyên 100% chi tiết của các bước mới nhất (Last N observations).
 * 3. AST-level Semantic Slicing: Nén các file code lớn cũ thành sơ đồ Outline các Symbols/Functions/Classes.
 * 4. Tail-Preserving Log Truncation: Giữ lại phần đuôi của Stack Trace lỗi thay vì cắt bừa bãi.
 */
export class ContextCompactor {
  private config: Required<CompactionConfig>;

  constructor(config?: CompactionConfig) {
    this.config = {
      maxCharactersPerToolResult: config?.maxCharactersPerToolResult ?? 1200,
      preserveLastNToolResults: config?.preserveLastNToolResults ?? 3,
      maxTotalHistoryTokens: config?.maxTotalHistoryTokens ?? 32000,
      preservePrefixCache: config?.preservePrefixCache ?? false,
    };
  }

  getConfig(): Required<CompactionConfig> {
    return { ...this.config };
  }

  setMaxInputTokens(tokens: number): void {
    if (tokens > 0) {
      this.config.maxTotalHistoryTokens = tokens;
    }
  }

  setConfig(config: Partial<CompactionConfig>): void {
    if (config.maxCharactersPerToolResult !== undefined) {
      this.config.maxCharactersPerToolResult = config.maxCharactersPerToolResult;
    }
    if (config.preserveLastNToolResults !== undefined) {
      this.config.preserveLastNToolResults = config.preserveLastNToolResults;
    }
    if (config.maxTotalHistoryTokens !== undefined) {
      this.config.maxTotalHistoryTokens = config.maxTotalHistoryTokens;
    }
    if (config.preservePrefixCache !== undefined) {
      this.config.preservePrefixCache = config.preservePrefixCache;
    }
  }

  /**
   * Ước lượng số lượng tokens theo quy tắc Heuristic (1 token ~ 3.8 - 4 ký tự)
   */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.8);
  }

  /**
   * Thực hiện nén và tối ưu hoá danh sách tin nhắn trong Session.
   * Nếu preservePrefixCache bật và token chưa chạm ngân sách maxTotalHistoryTokens,
   * giữ nguyên vẹn 100% tin nhắn để tránh vỡ KV-Cache của OpenAI Codex.
   */
  compact(messages: SessionMessage[], options?: CompactionOptions): { messages: SessionMessage[]; stats: CompactionStats } {
    assertHistoryToolPairing(messages);
    let originalLength = 0;
    let compactedLength = 0;
    let prunedPartsCount = 0;

    // 1. Tính tổng dung lượng ban đầu
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.text) originalLength += part.text.length;
        if (part.functionResponse) originalLength += JSON.stringify(part.functionResponse).length;
        if (part.functionCall) originalLength += JSON.stringify(part.functionCall).length;
      }
    }

    const originalTokens = ContextCompactor.estimateTokens(' '.repeat(originalLength));
    const requestOverheadTokens = Math.max(0, options?.requestOverheadTokens || 0);
    const outputReserveTokens = Math.max(0, options?.outputReserveTokens || 0);
    const triggerRatio = Math.min(1, Math.max(0.5, options?.triggerRatio ?? 1));
    const effectiveHistoryBudgetTokens = Math.max(
      0,
      Math.floor(this.config.maxTotalHistoryTokens * triggerRatio) - requestOverheadTokens - outputReserveTokens,
    );

    // Nếu cấu hình bảo vệ Prefix Cache và dung lượng token chưa vượt ngưỡng ngân sách (maxTotalHistoryTokens)
    if (this.config.preservePrefixCache && !options?.force && originalTokens <= effectiveHistoryBudgetTokens) {
      return {
        messages,
        stats: {
          originalTokens,
          compactedTokens: originalTokens,
          tokensSaved: 0,
          originalLength,
          compactedLength: originalLength,
          charsSaved: 0,
          prunedPartsCount: 0,
          requestOverheadTokens,
          outputReserveTokens,
          effectiveHistoryBudgetTokens,
        },
      };
    }

    // 2. Tìm các index của tool responses gần nhất
    const toolResultIndices: number[] = [];
    messages.forEach((msg, idx) => {
      if (msg.parts?.some((p) => p.functionResponse)) {
        toolResultIndices.push(idx);
      }
    });

    const cutoffIndex = toolResultIndices.length > this.config.preserveLastNToolResults
      ? toolResultIndices[toolResultIndices.length - this.config.preserveLastNToolResults]
      : -1;

    // 3. Tiến hành Selective Sliding Window Pruning
    const compactedMessages: SessionMessage[] = messages.map((msg, msgIdx) => {
      const isOldToolResult = cutoffIndex >= 0 && msgIdx < cutoffIndex && msg.parts?.some((p) => p.functionResponse);

      if (!isOldToolResult) {
        return msg;
      }

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

          // Case A: File content dài -> Áp dụng AST-level Semantic Slicing
          if (r.content !== undefined && typeof r.content === 'string') {
            const outline = SemanticSlicer.extractOutline(r.path || 'file', r.content);
            const topSymbols = outline.symbols.slice(0, 10).map((s) => `${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`);
            if (outline.symbols.length > 10) {
              topSymbols.push(`... (+${outline.symbols.length - 10} symbols khác)`);
            }

            compressedPayload = {
              path: r.path,
              totalLines: outline.totalLines,
              semanticOutline: outline.summary,
              symbols: topSymbols,
              hint: '[Nội dung đã được nén thành Outline ngữ nghĩa. Dùng read_file với startLine/endLine nếu cần xem chi tiết]',
            };
          }
          // Case B: Log chạy lệnh dài -> Giữ Header + Tail của Stack Trace
          else if (r.stdout !== undefined || r.stderr !== undefined) {
            const rawLog = String(r.stderr || r.stdout || '').trim();
            const logLines = rawLog.split('\n');
            let logTail = rawLog;
            if (logLines.length > 12) {
              logTail = logLines.slice(0, 3).join('\n') + '\n... [Cắt ' + (logLines.length - 8) + ' dòng log] ...\n' + logLines.slice(-5).join('\n');
            } else if (rawLog.length > this.config.maxCharactersPerToolResult) {
              logTail = rawLog.slice(0, 150) + '\n... [Cắt ' + (rawLog.length - 300) + ' ký tự] ...\n' + rawLog.slice(-150);
            }

            compressedPayload = {
              exitCode: r.exitCode,
              summary: `[Log thực thi dài (${rawLog.length} chars) đã được nén]`,
              logTail,
            };
          }
          // Case C: Kết quả search text nhiều dòng
          else if (Array.isArray(r.matches)) {
            const topMatches = r.matches.slice(0, 3);
            compressedPayload = {
              totalMatches: r.totalMatches || r.matches.length,
              topMatches,
              summary: `[Tìm thấy ${r.totalMatches || r.matches.length} kết quả. Đã hiển thị 3 kết quả đầu]`,
            };
          }
          // Case D: Payload đối tượng khác
          else {
            compressedPayload = {
              summary: `[Dữ liệu dài (${respStr.length} chars) đã được nén]`,
              preview: respStr.slice(0, 250) + '...',
            };
          }
        } else {
          compressedPayload = {
            summary: `[Dữ liệu nén: ${String(resp.response).slice(0, 200)}...]`,
          };
        }

        return {
          functionResponse: {
            name: resp.name,
            id: resp.id,
            response: compressedPayload,
          },
        };
      });

      return {
        role: msg.role,
        parts: newParts,
      };
    });

    // 4. Tính toán kết quả sau khi nén
    for (const msg of compactedMessages) {
      for (const part of msg.parts || []) {
        if (part.text) compactedLength += part.text.length;
        if (part.functionResponse) compactedLength += JSON.stringify(part.functionResponse).length;
        if (part.functionCall) compactedLength += JSON.stringify(part.functionCall).length;
      }
    }

    const charsSaved = Math.max(0, originalLength - compactedLength);
    const compactedTokens = ContextCompactor.estimateTokens(' '.repeat(compactedLength));
    const tokensSaved = Math.max(0, originalTokens - compactedTokens);

    const stats: CompactionStats = {
      originalTokens,
      compactedTokens,
      tokensSaved,
      originalLength,
      compactedLength,
      charsSaved,
      prunedPartsCount,
      requestOverheadTokens,
      outputReserveTokens,
      effectiveHistoryBudgetTokens,
    };

    assertHistoryToolPairing(compactedMessages);
    return { messages: compactedMessages, stats };
  }

  /**
   * Tự động nén và đúc kết các chuỗi thử - sai thất bại thành Distilled Learnings (Codex CLI Standard)
   * 
   * Thay thế các stack traces và error logs khổng lồ của các giả thuyết bị bác bỏ bằng các bài học súc tích,
   * giữ cho context window luôn sạch sẽ và tránh hiện tượng Agent bị lú lẫn do đọc lại lỗi cũ.
   */
  distillFailedHypotheses(
    messages: SessionMessage[],
    falsifiedHypotheses: Array<{ id: string; statement: string; rejectionReason?: string; learning?: string }>,
  ): { messages: SessionMessage[]; distilledSummary: string } {
    if (falsifiedHypotheses.length === 0) {
      return { messages, distilledSummary: '' };
    }

    const summaryLines = falsifiedHypotheses.map(
      (h) => `• [${h.id} Falsified]: "${h.statement}" ➔ ${h.rejectionReason || 'Failed verification'} (Bài học: ${h.learning || 'Cần đổi chiến lược'})`,
    );
    const distilledSummary = [
      `\n🧠 [DISTILLED LEARNED INVARIANTS - CODEX ARCHITECTURE]:`,
      ...summaryLines,
    ].join('\n');

    // Chèn hoặc cập nhật tin nhắn hệ thống tóm tắt ngắn gọn
    const updatedMessages: SessionMessage[] = messages.map((msg) => {
      if (msg.role === 'user' && msg.parts?.some((p) => p.text?.includes('[DISTILLED LEARNED INVARIANTS]'))) {
        return {
          role: 'user',
          parts: [{ text: distilledSummary }],
        };
      }
      return msg;
    });

    return { messages: updatedMessages, distilledSummary };
  }
}
