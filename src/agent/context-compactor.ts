import { ContentPart, SessionMessage } from '../session/session.js';
import { SemanticSlicer } from './semantic-slicer.js';
import { assertHistoryToolPairing } from '../session/session-invariants.js';
import { getHistoryTotalChars } from '../session/message-metrics.js';
import { ExactTokenizer } from './exact-tokenizer.js';
import type { ArchivedTurnDocument } from '../context/turn-memory-retriever.js';

export interface CompactionConfig {
  maxCharactersPerToolResult?: number;
  preserveLastNToolResults?: number;
  maxTotalHistoryTokens?: number;
  preservePrefixCache?: boolean;
  enableRollingTurnCompaction?: boolean;
  preserveLastNTurns?: number;
}

export interface CompactionStats {
  originalTokens: number;
  compactedTokens: number;
  tokensSaved: number;
  originalLength: number;
  compactedLength: number;
  charsSaved: number;
  prunedPartsCount: number;
  prunedTurnsCount?: number;
  requestOverheadTokens: number;
  outputReserveTokens: number;
  effectiveHistoryBudgetTokens: number;
  archivedTurns?: ArchivedTurnDocument[];
}

export interface CompactionOptions {
  force?: boolean;
  requestOverheadTokens?: number;
  outputReserveTokens?: number;
  triggerRatio?: number;
  reinjectInvariants?: string;
  enableRollingTurns?: boolean;
  preserveLastNTurns?: number;
  modelName?: string;
}

/**
 * ContextCompactor - Động cơ Nén Ngữ Cảnh & Quản Lý Ngân Sách Token (Phase 3 - Production)
 * 
 * Áp dụng các kỹ thuật:
 * 1. Prefix-Safe KV-Cache Preservation: Bảo toàn tiền tố lịch sử tin nhắn tránh vỡ KV-Cache của OpenAI/Codex.
 * 2. Selective Sliding Window: Giữ nguyên 100% chi tiết của các bước mới nhất (Last N observations).
 * 3. Rolling Turn Compaction: Tóm tắt và đóng gói các turn đối thoại (User - Assistant) quá cũ theo cửa sổ trượt.
 * 4. AST-level Semantic Slicing: Nén các file code lớn cũ thành sơ đồ Outline các Symbols/Functions/Classes.
 * 5. Tail-Preserving Log Truncation: Giữ lại phần đuôi của Stack Trace lỗi thay vì cắt bừa bãi.
 * 6. Exact Tokenizer Integration: Tích hợp ExactTokenizer đa mô hình thay cho heuristic chars / 3.8.
 */
export class ContextCompactor {
  private config: Required<CompactionConfig>;

  constructor(config?: CompactionConfig) {
    this.config = {
      maxCharactersPerToolResult: config?.maxCharactersPerToolResult ?? 1200,
      preserveLastNToolResults: config?.preserveLastNToolResults ?? 3,
      maxTotalHistoryTokens: config?.maxTotalHistoryTokens ?? 32000,
      preservePrefixCache: config?.preservePrefixCache ?? false,
      enableRollingTurnCompaction: config?.enableRollingTurnCompaction ?? true,
      preserveLastNTurns: config?.preserveLastNTurns ?? 8,
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
    if (config.enableRollingTurnCompaction !== undefined) {
      this.config.enableRollingTurnCompaction = config.enableRollingTurnCompaction;
    }
    if (config.preserveLastNTurns !== undefined) {
      this.config.preserveLastNTurns = config.preserveLastNTurns;
    }
  }

  /**
   * Ước lượng số lượng tokens theo ExactTokenizer hoặc Heuristic fallback
   */
  static estimateTokens(textOrLength: string | number, modelOrFamily?: string): number {
    if (typeof textOrLength === 'string') {
      return ExactTokenizer.countTokens(textOrLength, modelOrFamily);
    }
    return Math.ceil(Math.max(0, typeof textOrLength === 'number' ? textOrLength : 0) / 3.8);
  }

  /**
   * Trích xuất thông tin tóm tắt một turn đối thoại cũ
   */
  private extractTurnSynopsis(
    turnMessages: SessionMessage[],
    turnNum: number,
  ): { synopsis: string; doc: ArchivedTurnDocument } {
    let userPrompt = '';
    const assistantThoughts: string[] = [];
    const toolsUsed: string[] = [];
    const filesTouched: string[] = [];
    const keyDecisions: string[] = [];

    for (const msg of turnMessages) {
      if (msg.role === 'user') {
        for (const p of msg.parts || []) {
          if (p.text && !p.functionResponse) {
            userPrompt += (userPrompt ? ' ' : '') + p.text;
          }
        }
      } else if (msg.role === 'model') {
        for (const p of msg.parts || []) {
          if (p.text) {
            assistantThoughts.push(p.text);
          }
          if (p.functionCall) {
            if (p.functionCall.name) {
              toolsUsed.push(p.functionCall.name);
            }
            const args = p.functionCall.args as Record<string, any> | undefined;
            const pathArg = args?.path || args?.filePath || args?.targetFile;
            if (pathArg && typeof pathArg === 'string') {
              filesTouched.push(pathArg);
            }
          }
        }
      }
    }

    const uniqueFiles = Array.from(new Set(filesTouched));
    const uniqueTools = Array.from(new Set(toolsUsed));
    const summaryText = assistantThoughts.slice(-1)[0]
      || (uniqueTools.length > 0 ? `Đã thực thi công cụ: ${uniqueTools.join(', ')}` : 'Đã hoàn tất bước trao đổi.');

    const doc: ArchivedTurnDocument = {
      id: `archived-turn-${turnNum}-${Date.now().toString(36)}`,
      turnNumber: turnNum,
      userPrompt: userPrompt.trim() || `Yêu cầu turn #${turnNum}`,
      assistantSummary: summaryText.trim(),
      toolsUsed: uniqueTools,
      filesTouched: uniqueFiles,
      keyDecisions,
      timestamp: new Date().toISOString(),
    };

    const synopsis = `• Turn #${turnNum}: Yêu cầu: "${userPrompt.slice(0, 100)}${userPrompt.length > 100 ? '...' : ''}" ➔ Kết quả: ${summaryText.slice(0, 120)}${summaryText.length > 120 ? '...' : ''}${uniqueFiles.length > 0 ? ` [Files: ${uniqueFiles.slice(0, 3).join(', ')}]` : ''}`;

    return { synopsis, doc };
  }

  /**
   * Áp dụng Rolling Turn Compaction:
   * Giữ lại Turn 0 (Goal ban đầu) + N turns đối thoại gần nhất (Preserved Tail Window).
   * Các turn cũ nằm ở giữa được tóm tắt thành Synopsis và chuyển vào kho lưu trữ (Archived Turns).
   */
  private applyRollingTurnCompaction(
    messages: SessionMessage[],
    preserveLastNTurns: number
  ): { messages: SessionMessage[]; archivedTurns: ArchivedTurnDocument[]; prunedTurnsCount: number } {
    const userTurnIndices: number[] = [];
    messages.forEach((msg, idx) => {
      if (msg.role === 'user' && !msg.parts?.some((p) => p.functionResponse)) {
        userTurnIndices.push(idx);
      }
    });

    // Cần ít nhất preserveLastNTurns + 2 turns (Turn 0 + các turns cũ + các turns được giữ lại)
    if (userTurnIndices.length <= preserveLastNTurns + 1) {
      return { messages, archivedTurns: [], prunedTurnsCount: 0 };
    }

    // Turn 0 luôn được giữ nguyên (từ đầu đến trước turn 1 của user)
    const turn0EndIndex = userTurnIndices[1];
    const turn0Messages = messages.slice(0, turn0EndIndex);

    // Điểm bắt đầu của cửa sổ trượt (các turn được bảo toàn ở đuôi)
    const cutoffTurnIdx = userTurnIndices[userTurnIndices.length - preserveLastNTurns];
    const preservedTailMessages = messages.slice(cutoffTurnIdx);

    // Các turn cũ cần được thu gọn thành tóm tắt
    const archivedTurns: ArchivedTurnDocument[] = [];
    const synopsisLines: string[] = [];

    const oldUserTurnIndices = userTurnIndices.slice(1, userTurnIndices.length - preserveLastNTurns);
    for (let i = 0; i < oldUserTurnIndices.length; i++) {
      const startIdx = oldUserTurnIndices[i];
      const endIdx = (i + 1 < oldUserTurnIndices.length)
        ? oldUserTurnIndices[i + 1]
        : cutoffTurnIdx;
      const singleTurnMessages = messages.slice(startIdx, endIdx);
      const turnNum = i + 1;
      const { synopsis, doc } = this.extractTurnSynopsis(singleTurnMessages, turnNum);
      archivedTurns.push(doc);
      synopsisLines.push(synopsis);
    }

    const rollingSynopsisMessage: SessionMessage = {
      role: 'user',
      parts: [{
        text: `[ROLLING DIALOGUE SYNOPSIS - TURNS 1 to ${oldUserTurnIndices.length} ARCHIVED]:\n` +
          `> Ngữ cảnh các lượt trao đổi cũ đã được nén vào kho lưu trữ tập (Archived Turns Memory):\n` +
          synopsisLines.join('\n') +
          `\n> (Hệ thống sẽ tự động re-inject thông tin chi tiết nếu người dùng đề cập đến các bước trên)`
      }]
    };

    const newMessages: SessionMessage[] = [
      ...turn0Messages,
      rollingSynopsisMessage,
      ...preservedTailMessages,
    ];

    // Xác nhận tính toàn vẹn cặp gọi tool sau khi loại bỏ turn cũ
    assertHistoryToolPairing(newMessages);

    return {
      messages: newMessages,
      archivedTurns,
      prunedTurnsCount: oldUserTurnIndices.length,
    };
  }

  /**
   * Thực hiện nén và tối ưu hoá danh sách tin nhắn trong Session.
   * Nếu preservePrefixCache bật và token chưa chạm ngân sách maxTotalHistoryTokens,
   * giữ nguyên vẹn 100% tin nhắn để tránh vỡ KV-Cache của OpenAI Codex.
   */
  compact(messages: SessionMessage[], options?: CompactionOptions): { messages: SessionMessage[]; stats: CompactionStats } {
    assertHistoryToolPairing(messages);
    let compactedLength = 0;
    let prunedPartsCount = 0;
    let prunedTurnsCount = 0;
    let archivedTurns: ArchivedTurnDocument[] = [];

    // 1. Tính tổng dung lượng ban đầu qua O(1) WeakMap cache
    const originalLength = getHistoryTotalChars(messages);
    const originalTokens = ContextCompactor.estimateTokens(originalLength, options?.modelName);
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
          prunedTurnsCount: 0,
          requestOverheadTokens,
          outputReserveTokens,
          effectiveHistoryBudgetTokens,
          archivedTurns: [],
        },
      };
    }

    // 1.5. Kỹ thuật Rolling Turn Compaction: Thu gọn các cặp Turn (User - Assistant) quá cũ theo cửa sổ trượt
    let workingMessages = messages;
    const shouldRunRollingTurns = options?.enableRollingTurns ?? this.config.enableRollingTurnCompaction;
    const preserveTurns = options?.preserveLastNTurns ?? this.config.preserveLastNTurns;

    if (shouldRunRollingTurns && (options?.force || originalTokens > effectiveHistoryBudgetTokens)) {
      const rollingResult = this.applyRollingTurnCompaction(messages, preserveTurns);
      workingMessages = rollingResult.messages;
      archivedTurns = rollingResult.archivedTurns;
      prunedTurnsCount = rollingResult.prunedTurnsCount;
    }

    // 2. Tìm các index của tool responses gần nhất
    const toolResultIndices: number[] = [];
    workingMessages.forEach((msg, idx) => {
      if (msg.parts?.some((p) => p.functionResponse)) {
        toolResultIndices.push(idx);
      }
    });

    const cutoffIndex = toolResultIndices.length > this.config.preserveLastNToolResults
      ? toolResultIndices[toolResultIndices.length - this.config.preserveLastNToolResults]
      : -1;

    // 3. Tiến hành Selective Sliding Window Pruning
    const compactedMessages: SessionMessage[] = workingMessages.map((msg, msgIdx) => {
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

    // 4. Tính toán kết quả sau khi nén qua WeakMap cache
    compactedLength = getHistoryTotalChars(compactedMessages);

    const charsSaved = Math.max(0, originalLength - compactedLength);

    if (options?.reinjectInvariants && charsSaved > 0) {
      compactedMessages.push({
        role: 'user',
        parts: [{
          text: `[CRITICAL STATE INVARIANTS - RESTORED AFTER COMPACTION]:\n${options.reinjectInvariants.trim()}`,
        }],
      });
      compactedLength += options.reinjectInvariants.length + 65;
    }

    const finalTokens = ContextCompactor.estimateTokens(compactedLength);
    const finalTokensSaved = Math.max(0, originalTokens - finalTokens);

    const stats: CompactionStats = {
      originalTokens,
      compactedTokens: finalTokens,
      tokensSaved: finalTokensSaved,
      originalLength,
      compactedLength,
      charsSaved,
      prunedPartsCount,
      prunedTurnsCount,
      requestOverheadTokens,
      outputReserveTokens,
      effectiveHistoryBudgetTokens,
      archivedTurns,
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
