import path from 'node:path';
import crypto from 'node:crypto';
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
  enableObservationMasking?: boolean;
  maskOldObservationsBeyondN?: number;
}

export interface MaskedObservationRecord {
  id: string;
  toolName: string;
  targetPath?: string;
  command?: string;
  exitCode?: number;
  timestamp: string;
  originalPayload: any;
  summary: string;
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
  maskedObservations?: MaskedObservationRecord[];
  /** True only when the model-visible history fits the calculated history budget. */
  withinBudget: boolean;
  budgetOverflowTokens: number;
  /** Ordered list of compaction layers applied to this projection. */
  strategiesApplied: string[];
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
  mutatedFiles?: string[];
  cognitivePhase?: 'explore' | 'plan' | 'implement' | 'verify';
  enableObservationMasking?: boolean;
  /** Apply deterministic emergency reductions until the hard budget is met. */
  enforceBudget?: boolean;
  /** Per-request context ceiling; overrides the long-lived compactor default. */
  maxInputTokens?: number;
}

const ROLLING_SYNOPSIS_MARKER = '[ROLLING DIALOGUE SYNOPSIS';

function isRollingSynopsisMessage(message: SessionMessage): boolean {
  return message.role === 'user'
    && Boolean(message.parts?.some((part) => typeof part.text === 'string' && part.text.includes(ROLLING_SYNOPSIS_MARKER)));
}

function serializeHistory(messages: SessionMessage[]): string {
  try {
    return JSON.stringify(messages);
  } catch {
    return messages.map((message) => `${message.role}:${String(message.parts || '')}`).join('\n');
  }
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
      enableObservationMasking: config?.enableObservationMasking ?? true,
      maskOldObservationsBeyondN: config?.maskOldObservationsBeyondN ?? 3,
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
    if (config.enableObservationMasking !== undefined) {
      this.config.enableObservationMasking = config.enableObservationMasking;
    }
    if (config.maskOldObservationsBeyondN !== undefined) {
      this.config.maskOldObservationsBeyondN = config.maskOldObservationsBeyondN;
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

  /** Count the serialized history instead of applying a character ratio to an aggregate length. */
  static countHistoryTokens(messages: SessionMessage[], modelOrFamily?: string): number {
    return ExactTokenizer.countTokens(serializeHistory(messages), modelOrFamily);
  }

  private enforceHardBudget(
    input: SessionMessage[],
    budgetTokens: number,
    modelName?: string,
  ): { messages: SessionMessage[]; strategies: string[]; prunedPartsCount: number } {
    let messages = input.map((message) => ({
      ...message,
      parts: (message.parts || []).map((part) => ({ ...part })),
    }));
    const strategies: string[] = [];
    let prunedPartsCount = 0;
    const count = () => ContextCompactor.countHistoryTokens(messages, modelName);

    if (count() <= budgetTokens) return { messages, strategies, prunedPartsCount };

    // Layer 1: reduce every large tool observation, including a recent one. A hard
    // provider limit takes precedence over the soft recent-observation window.
    messages = messages.map((message) => ({
      ...message,
      parts: (message.parts || []).map((part) => {
        if (!part.functionResponse) return part;
        const response = part.functionResponse.response as Record<string, any> | undefined;
        const serialized = JSON.stringify(response ?? {});
        if (serialized.length <= 320) return part;
        prunedPartsCount++;
        const rawLog = String(response?.stderr || response?.stdout || response?.error || '').trim();
        return {
          ...part,
          functionResponse: {
            name: part.functionResponse.name,
            id: part.functionResponse.id,
            response: {
              status: response?.status || (response?.exitCode === 0 ? 'success' : 'compacted'),
              ...(response?.path || response?.filePath ? { path: response.path || response.filePath } : {}),
              ...(response?.command ? { command: String(response.command).slice(0, 240) } : {}),
              ...(response?.exitCode !== undefined ? { exitCode: response.exitCode } : {}),
              summary: `[HARD-BUDGET OBSERVATION STUB: ${serialized.length} chars archived in the session event log]`,
              ...(rawLog ? { evidenceTail: rawLog.split('\n').slice(-4).join('\n').slice(-600) } : {}),
            },
          },
        };
      }),
    }));
    strategies.push('hard-budget-observation-stubs');

    if (count() <= budgetTokens) return { messages, strategies, prunedPartsCount };

    // Layer 2: trim verbose assistant narration outside the most recent exchange.
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (
        message.role === 'user'
        && !message.parts?.some((part: any) => part.functionResponse)
        && !isRollingSynopsisMessage(message)
      ) {
        lastUserIndex = index;
        break;
      }
    }
    messages = messages.map((message, messageIndex) => ({
      ...message,
      parts: (message.parts || []).map((part) => {
        if (
          message.role !== 'model'
          || messageIndex >= lastUserIndex
          || typeof part.text !== 'string'
          || part.text.length <= 600
        ) return part;
        prunedPartsCount++;
        return {
          ...part,
          text: `${part.text.slice(0, 260)}\n… [${part.text.length - 520} chars archived] …\n${part.text.slice(-260)}`,
        };
      }),
    }));
    strategies.push('hard-budget-assistant-trim');

    if (count() <= budgetTokens) return { messages, strategies, prunedPartsCount };

    // Layer 3: the detailed turn documents remain recoverable from the immutable
    // event log and memory archive, so keep only the newest synopsis references.
    messages = messages.map((message) => {
      if (!isRollingSynopsisMessage(message)) return message;
      const text = String(message.parts?.find((part) => part.text)?.text || '');
      const turnLines = text.split('\n').filter((line) => line.trimStart().startsWith('• Turn #'));
      const retained = turnLines.slice(-12);
      prunedPartsCount++;
      return {
        role: 'user',
        parts: [{
          text: `${ROLLING_SYNOPSIS_MARKER} - ${turnLines.length} ARCHIVED]:\n${retained.join('\n')}\n> Older details remain retrievable from archived turn memory.`,
        }],
      };
    });
    strategies.push('hard-budget-synopsis-window');

    return { messages, strategies, prunedPartsCount };
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
    for (const text of assistantThoughts) {
      for (const line of text.split('\n')) {
        const normalized = line.replace(/^[-*•#\d.)\s]+/, '').trim();
        if (
          normalized.length >= 20
          && /\b(decid(?:e|ed|ing)|decision|chọn|quyết định|thay thế|sử dụng|giữ|bỏ)\b/i.test(normalized)
        ) {
          keyDecisions.push(normalized.slice(0, 240));
        }
      }
    }
    const uniqueDecisions = Array.from(new Set(keyDecisions)).slice(0, 8);
    const summaryText = assistantThoughts.slice(-1)[0]
      || (uniqueTools.length > 0 ? `Đã thực thi công cụ: ${uniqueTools.join(', ')}` : 'Đã hoàn tất bước trao đổi.');

    const stableTurnHash = crypto.createHash('sha256')
      .update(serializeHistory(turnMessages))
      .digest('hex')
      .slice(0, 16);

    const doc: ArchivedTurnDocument = {
      id: `archived-turn-${turnNum}-${stableTurnHash}`,
      turnNumber: turnNum,
      userPrompt: userPrompt.trim() || `Yêu cầu turn #${turnNum}`,
      assistantSummary: summaryText.trim(),
      toolsUsed: uniqueTools,
      filesTouched: uniqueFiles,
      keyDecisions: uniqueDecisions,
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
    const priorSynopsisLines = messages
      .filter(isRollingSynopsisMessage)
      .flatMap((message) => message.parts || [])
      .flatMap((part) => typeof part.text === 'string' ? part.text.split('\n') : [])
      .filter((line) => line.trimStart().startsWith('• Turn #'));
    const sourceMessages = messages.filter((message) => !isRollingSynopsisMessage(message));

    const userTurnIndices: number[] = [];
    sourceMessages.forEach((msg, idx) => {
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
    const turn0Messages = sourceMessages.slice(0, turn0EndIndex);

    // Điểm bắt đầu của cửa sổ trượt (các turn được bảo toàn ở đuôi)
    const cutoffTurnIdx = userTurnIndices[userTurnIndices.length - preserveLastNTurns];
    const preservedTailMessages = sourceMessages.slice(cutoffTurnIdx);

    // Các turn cũ cần được thu gọn thành tóm tắt
    const archivedTurns: ArchivedTurnDocument[] = [];
    const synopsisLines: string[] = [];

    const oldUserTurnIndices = userTurnIndices.slice(1, userTurnIndices.length - preserveLastNTurns);
    for (let i = 0; i < oldUserTurnIndices.length; i++) {
      const startIdx = oldUserTurnIndices[i];
      const endIdx = (i + 1 < oldUserTurnIndices.length)
        ? oldUserTurnIndices[i + 1]
        : cutoffTurnIdx;
      const singleTurnMessages = sourceMessages.slice(startIdx, endIdx);
      const turnNum = priorSynopsisLines.length + i + 1;
      const { synopsis, doc } = this.extractTurnSynopsis(singleTurnMessages, turnNum);
      archivedTurns.push(doc);
      synopsisLines.push(synopsis);
    }

    const rollingSynopsisMessage: SessionMessage = {
      role: 'user',
      parts: [{
        text: `[ROLLING DIALOGUE SYNOPSIS - TURNS 1 to ${oldUserTurnIndices.length} ARCHIVED]:\n` +
          `> Ngữ cảnh các lượt trao đổi cũ đã được nén vào kho lưu trữ tập (Archived Turns Memory):\n` +
          [...priorSynopsisLines, ...synopsisLines].join('\n') +
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
    const maskedObservations: MaskedObservationRecord[] = [];

    // 1. Tính tổng dung lượng ban đầu qua O(1) WeakMap cache
    const originalLength = getHistoryTotalChars(messages);
    const originalTokens = ContextCompactor.countHistoryTokens(messages, options?.modelName);
    const requestOverheadTokens = Math.max(0, options?.requestOverheadTokens || 0);
    const outputReserveTokens = Math.max(0, options?.outputReserveTokens || 0);
    const triggerRatio = Math.min(1, Math.max(0.5, options?.triggerRatio ?? 1));
    const requestTokenCeiling = Math.max(1, options?.maxInputTokens || this.config.maxTotalHistoryTokens);
    const effectiveHistoryBudgetTokens = Math.max(
      0,
      Math.floor(requestTokenCeiling * triggerRatio) - requestOverheadTokens - outputReserveTokens,
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
          withinBudget: true,
          budgetOverflowTokens: 0,
          strategiesApplied: [],
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

    // 2. Chuẩn bị danh sách file bị sửa đổi và cấu hình Phase-Aware
    const mutatedFilesNormalized = new Set(
      (options?.mutatedFiles || []).map((f) => path.normalize(f).toLowerCase())
    );

    let effectivePreserveLastN = options?.cognitivePhase === 'explore'
      ? Math.min(this.config.preserveLastNToolResults, 2)
      : this.config.preserveLastNToolResults;

    const isObservationMaskingActive = options?.enableObservationMasking ?? this.config.enableObservationMasking;
    if (isObservationMaskingActive) {
      effectivePreserveLastN = Math.min(effectivePreserveLastN, this.config.maskOldObservationsBeyondN);
    }

    // Tìm các index của tool responses gần nhất
    const toolResultIndices: number[] = [];
    workingMessages.forEach((msg, idx) => {
      if (msg.parts?.some((p) => p.functionResponse)) {
        toolResultIndices.push(idx);
      }
    });

    const cutoffIndex = toolResultIndices.length > effectivePreserveLastN
      ? toolResultIndices[toolResultIndices.length - effectivePreserveLastN]
      : -1;

    // 3. Tiến hành Adaptive Context Pruning (Observation Masking & Superseded Deduplication)
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

        if (typeof resp.response === 'object' && resp.response !== null) {
          const r = resp.response as Record<string, any>;
          const rawFilePath = r.path || r.filePath || r.targetFile;
          const normalizedPath = rawFilePath ? path.normalize(String(rawFilePath)).toLowerCase() : '';

          // Cơ chế 1: Superseded State Deduplication (Khử trạng thái cũ của file đã bị sửa)
          if (normalizedPath && mutatedFilesNormalized.has(normalizedPath)) {
            prunedPartsCount++;
            const supersededMask = `[SUPERSEDED BY RECENT MUTATION: File "${rawFilePath}" đã được sửa đổi ở bước sau. Vui lòng đọc lại file nếu cần nội dung mới nhất]`;
            maskedObservations.push({
              id: resp.id || `obs-${msgIdx}`,
              toolName: resp.name || 'unknown',
              targetPath: rawFilePath,
              timestamp: new Date().toISOString(),
              originalPayload: resp.response,
              summary: supersededMask,
            });
            return {
              functionResponse: {
                name: resp.name,
                id: resp.id,
                response: {
                  path: rawFilePath,
                  status: 'superseded',
                  observationMask: supersededMask,
                },
              },
            };
          }

          // Cơ chế 2: Dynamic Observation Masking cho các tool cũ ngoài cửa sổ N
          if (isObservationMaskingActive) {
            prunedPartsCount++;
            let compressedPayload: any;

            // 2a: Đọc file cũ -> Nén thành Observation Stub ngắn gọn
            if (r.content !== undefined && typeof r.content === 'string') {
              const outline = SemanticSlicer.extractOutline(r.path || 'file', r.content);
              const topSymbols = outline.symbols.slice(0, 3).map((s) => `${s.kind} ${s.name}`);
              compressedPayload = {
                path: r.path,
                totalLines: outline.totalLines,
                status: 'masked',
                observationMask: `[OBSERVATION MASKED: File "${r.path}" (${outline.totalLines || 0} lines). Symbols: ${topSymbols.join(', ') || 'none'}. Đọc lại bằng view_file nếu cần]`,
              };
            }
            // 2b: Command log cũ -> Giữ status gọn
            else if (r.stdout !== undefined || r.stderr !== undefined) {
              const rawLog = String(r.stderr || r.stdout || '').trim();
              if (r.exitCode === 0) {
                compressedPayload = {
                  exitCode: 0,
                  status: 'masked',
                  observationMask: `[OBSERVATION MASKED: Lệnh thực thi thành công (exit 0). Log dài (${rawLog.length} chars) đã được ẩn]`,
                };
              } else {
                const logLines = rawLog.split('\n');
                compressedPayload = {
                  exitCode: r.exitCode,
                  status: 'masked',
                  observationMask: `[OBSERVATION MASKED: Lệnh thất bại (exit ${r.exitCode})]`,
                  errorTail: logLines.slice(-3).join('\n'),
                };
              }
            }
            // 2c: Search result cũ
            else if (Array.isArray(r.matches)) {
              compressedPayload = {
                status: 'masked',
                observationMask: `[OBSERVATION MASKED: Kết quả tìm kiếm (${r.totalMatches || r.matches.length} matches) đã được ẩn]`,
              };
            }
            // 2d: Khác
            else {
              compressedPayload = {
                status: 'masked',
                observationMask: `[OBSERVATION MASKED: Dữ liệu cũ (${respStr.length} chars) đã được nén]`,
              };
            }

            maskedObservations.push({
              id: resp.id || `obs-${msgIdx}`,
              toolName: resp.name || 'unknown',
              targetPath: r.path || r.filePath || r.targetFile,
              command: r.command,
              exitCode: r.exitCode,
              timestamp: new Date().toISOString(),
              originalPayload: resp.response,
              summary: compressedPayload.observationMask || `Masked observation of ${resp.name}`,
            });

            return {
              functionResponse: {
                name: resp.name,
                id: resp.id,
                response: compressedPayload,
              },
            };
          }

          // Cơ chế 3: Fallback Semantic Slicing & Log Tail Truncation nếu observation masking không bật
          if (respStr.length <= this.config.maxCharactersPerToolResult) {
            return part;
          }

          prunedPartsCount++;
          let compressedPayload: any;

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
          // Case B: Log chạy lệnh dài -> Giữ Header + Tail của Stack Trace (Phase 2 Hierarchical Pruning)
          else if (r.stdout !== undefined || r.stderr !== undefined) {
            const rawLog = String(r.stderr || r.stdout || '').trim();
            const logLines = rawLog.split('\n');
            let logTail = rawLog;
            if (r.exitCode === 0 && logLines.length > 6) {
              logTail = logLines.slice(0, 2).join('\n') + '\n... [Command/Test thành công: đã ẩn ' + (logLines.length - 4) + ' dòng log] ...\n' + logLines.slice(-2).join('\n');
            } else if (logLines.length > 12) {
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

          return {
            functionResponse: {
              name: resp.name,
              id: resp.id,
              response: compressedPayload,
            },
          };
        } else {
          if (respStr.length <= this.config.maxCharactersPerToolResult) {
            return part;
          }
          prunedPartsCount++;
          return {
            functionResponse: {
              name: resp.name,
              id: resp.id,
              response: {
                summary: `[Dữ liệu nén: ${String(resp.response).slice(0, 200)}...]`,
              },
            },
          };
        }
      });

      return {
        role: msg.role,
        parts: newParts,
      };
    });

    // 4. Tính toán kết quả sau khi nén qua WeakMap cache
    compactedLength = getHistoryTotalChars(compactedMessages);

    let charsSaved = Math.max(0, originalLength - compactedLength);

    if (options?.reinjectInvariants && charsSaved > 0) {
      compactedMessages.push({
        role: 'user',
        parts: [{
          text: `[CRITICAL STATE INVARIANTS - RESTORED AFTER COMPACTION]:\n${options.reinjectInvariants.trim()}`,
        }],
      });
      compactedLength += options.reinjectInvariants.length + 65;
    }

    const hardBudgetResult = options?.enforceBudget
      ? this.enforceHardBudget(compactedMessages, effectiveHistoryBudgetTokens, options.modelName)
      : { messages: compactedMessages, strategies: [] as string[], prunedPartsCount: 0 };
    compactedMessages.splice(0, compactedMessages.length, ...hardBudgetResult.messages);
    prunedPartsCount += hardBudgetResult.prunedPartsCount;
    compactedLength = getHistoryTotalChars(compactedMessages);
    charsSaved = Math.max(0, originalLength - compactedLength);
    const finalTokens = ContextCompactor.countHistoryTokens(compactedMessages, options?.modelName);
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
      maskedObservations,
      withinBudget: finalTokens <= effectiveHistoryBudgetTokens,
      budgetOverflowTokens: Math.max(0, finalTokens - effectiveHistoryBudgetTokens),
      strategiesApplied: [
        ...(prunedTurnsCount > 0 ? ['rolling-turn-compaction'] : []),
        ...(prunedPartsCount > 0 ? ['observation-masking-or-slicing'] : []),
        ...hardBudgetResult.strategies,
      ],
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

  static computeElasticThresholdRatio(params: ElasticThresholdParams): number {
    return computeElasticThresholdRatio(params);
  }
}

export interface ElasticThresholdParams {
  tokenVelocity?: number;
  cognitivePhase?: 'explore' | 'plan' | 'implement' | 'verify' | string;
  baseRatio?: number;
}

/**
 * Tính toán tỉ lệ kích hoạt nén co giãn thích ứng (Adaptive Threshold Elasticity)
 * Dựa trên vận tốc tiêu thụ token (Token Velocity) và Pha nhận thức (Cognitive Phase).
 * 
 * - Vận tốc cao (> 3000 tokens/step): Giảm ngưỡng xuống 50% - 60% để tạo đệm an toàn, tránh tràn context đột ngột.
 * - Vận tốc thấp (< 800 tokens/step): Nới lỏng lên tới 75% - 80% để tránh nén thừa và bảo toàn KV-Cache.
 * - Phase explore: Giảm thêm 0.05 để tăng khả năng đọc nhiều file cấu trúc.
 * - Phase verify: Tăng thêm 0.05 để bảo tồn tối đa chi tiết bằng chứng kiểm thử.
 * - Giới hạn an toàn: Luôn nằm trong đoạn [0.50, 0.85].
 */
export function computeElasticThresholdRatio(params: ElasticThresholdParams): number {
  const baseRatio = typeof params.baseRatio === 'number' ? params.baseRatio : 0.70;
  let ratio = baseRatio;
  const velocity = Math.max(0, params.tokenVelocity || 0);

  // 1. Điều chỉnh theo Vận tốc tiêu thụ token (Velocity Adjustment)
  if (velocity >= 4000) {
    ratio -= 0.15;
  } else if (velocity >= 2500) {
    ratio -= 0.10;
  } else if (velocity >= 1500) {
    ratio -= 0.05;
  } else if (velocity <= 600 && velocity > 0) {
    ratio += 0.05;
  }

  // 2. Điều chỉnh theo Pha nhận thức (Phase Tuning)
  if (params.cognitivePhase === 'explore') {
    ratio -= 0.05;
  } else if (params.cognitivePhase === 'verify') {
    ratio += 0.05;
  }

  // 3. Giới hạn trong khoảng an toàn [0.50, 0.85]
  return Math.min(0.85, Math.max(0.50, Number(ratio.toFixed(2))));
}

