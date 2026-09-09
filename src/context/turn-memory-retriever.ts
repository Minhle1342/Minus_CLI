import fs from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { getNativeCore } from '../native/index.js';
import type { MaskedObservationRecord } from '../agent/context-compactor.js';

export interface ArchivedTurnDocument {
  id: string;
  turnNumber: number;
  userPrompt: string;
  assistantSummary: string;
  toolsUsed: string[];
  filesTouched: string[];
  keyDecisions: string[];
  timestamp: string;
  vector?: number[];
}

export interface RetrievalResult {
  turn: ArchivedTurnDocument;
  score: number;
  matchType: 'bm25' | 'vector' | 'hybrid';
}

export interface TurnMemoryOptions {
  topK?: number;
  minScore?: number;
  maxTokens?: number;
}

/**
 * TurnMemoryRetriever - Hệ thống Lưu trữ & Truy hồi Chọn lọc Ngữ cảnh các Turn cũ (Selective Re-injection)
 * 
 * Hiện thực hóa:
 * 1. Lưu trữ dài hạn: Khi các turn đối thoại cũ bị Rolling Turn Compaction đẩy khỏi cửa sổ context,
 *    chúng được chuyển vào kho bộ nhớ dạng vector/FTS5 thay vì bị hủy bỏ hoàn toàn.
 * 2. Tìm kiếm lai (Hybrid Retrieval): Kết hợp BM25 (MiniSearch) và SIMD Vector Cosine Similarity (Rust Native)
 *    để tìm lại các turn trong quá khứ liên quan trực tiếp đến câu hỏi / thao tác hiện tại của người dùng.
 * 3. Tái nạp có chọn lọc (Selective Re-injection): Chỉ chèn vào Dynamic Execution Context khi độ tương đồng
 *    vượt ngưỡng an toàn (>= 0.55), giữ cho context window luôn tinh gọn và tránh lãng phí token.
 * 4. Memory-Augmented On-Demand Retrieval: Tự động lưu trữ và phục hồi các observation đã bị mask
 *    khi agent hoặc user nhắc lại đến đối tượng cũ.
 */
export class TurnMemoryRetriever {
  readonly workspaceDir: string;
  readonly storageDir: string;
  readonly storageFilePath: string;
  readonly maskedStorageFilePath: string;

  private miniSearch: MiniSearch<ArchivedTurnDocument>;
  private turnsMap: Map<string, ArchivedTurnDocument> = new Map();
  private maskedObservationsMap: Map<string, MaskedObservationRecord> = new Map();
  private initialized = false;

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
    this.storageDir = path.join(this.workspaceDir, '.codingagent', 'memory');
    this.storageFilePath = path.join(this.storageDir, 'archived_turns.json');
    this.maskedStorageFilePath = path.join(this.storageDir, 'masked_observations.json');

    this.miniSearch = this.createMiniSearch();
  }

  private createMiniSearch(): MiniSearch<ArchivedTurnDocument> {
    return new MiniSearch<ArchivedTurnDocument>({
      fields: ['userPrompt', 'assistantSummary', 'filesTouched', 'toolsUsed', 'keyDecisions'],
      storeFields: ['id', 'turnNumber', 'userPrompt', 'assistantSummary', 'filesTouched', 'toolsUsed', 'keyDecisions', 'timestamp'],
      searchOptions: {
        boost: {
          userPrompt: 2.5,
          filesTouched: 2.0,
          keyDecisions: 2.0,
          assistantSummary: 1.5,
          toolsUsed: 1.0,
        },
        fuzzy: 0.2,
        prefix: true,
      },
      extractField: (document, fieldName) => {
        const val = (document as any)[fieldName];
        if (Array.isArray(val)) {
          return val.join(' ');
        }
        return String(val || '');
      },
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const raw = await fs.readFile(this.storageFilePath, 'utf8');
      const docs: ArchivedTurnDocument[] = JSON.parse(raw);
      if (Array.isArray(docs) && docs.length > 0) {
        for (const doc of docs) {
          this.turnsMap.set(doc.id, doc);
        }
        this.miniSearch.removeAll();
        this.miniSearch.addAll(docs);
      }
    } catch {
      // File chưa tồn tại hoặc rỗng, bỏ qua
    }

    try {
      const maskedRaw = await fs.readFile(this.maskedStorageFilePath, 'utf8');
      const maskedDocs: MaskedObservationRecord[] = JSON.parse(maskedRaw);
      if (Array.isArray(maskedDocs) && maskedDocs.length > 0) {
        for (const doc of maskedDocs) {
          this.maskedObservationsMap.set(doc.id, doc);
        }
      }
    } catch {
      // File chưa tồn tại hoặc rỗng, bỏ qua
    }
  }

  /**
   * Lưu trữ một hoặc nhiều turn cũ vào cơ sở dữ liệu trí nhớ
   */
  async archiveTurns(turns: ArchivedTurnDocument[]): Promise<void> {
    await this.init();
    if (turns.length === 0) return;

    const native = getNativeCore();
    const newDocs: ArchivedTurnDocument[] = [];

    for (const turn of turns) {
      if (this.turnsMap.has(turn.id)) continue;

      // Tính vector embedding qua Rust Native nếu khả dụng
      let vector = turn.vector;
      if (!vector && native && typeof native.rsGenerateSubwordEmbedding === 'function') {
        try {
          const textForEmbedding = `${turn.userPrompt} ${turn.assistantSummary} ${turn.filesTouched.join(' ')}`;
          vector = native.rsGenerateSubwordEmbedding(textForEmbedding);
        } catch {
          // Bỏ qua nếu lỗi embedding
        }
      }

      const enrichedTurn: ArchivedTurnDocument = {
        ...turn,
        vector,
      };

      this.turnsMap.set(enrichedTurn.id, enrichedTurn);
      newDocs.push(enrichedTurn);
    }

    if (newDocs.length > 0) {
      this.miniSearch.addAll(newDocs);
      await this.persist();
    }
  }

  /**
   * Lưu trữ các observations đã bị mask vào bộ nhớ on-demand
   */
  async archiveMaskedObservations(records: MaskedObservationRecord[]): Promise<void> {
    await this.init();
    if (!records || records.length === 0) return;

    let hasNew = false;
    for (const rec of records) {
      if (!this.maskedObservationsMap.has(rec.id)) {
        this.maskedObservationsMap.set(rec.id, rec);
        hasNew = true;
      }
    }

    // Giữ tối đa 100 observations gần nhất để tối ưu bộ nhớ
    if (this.maskedObservationsMap.size > 100) {
      const keys = Array.from(this.maskedObservationsMap.keys());
      const toRemove = keys.slice(0, keys.length - 100);
      for (const k of toRemove) {
        this.maskedObservationsMap.delete(k);
      }
    }

    if (hasNew) {
      await this.persistMaskedObservations();
    }
  }

  private async persistMaskedObservations(): Promise<void> {
    try {
      const allDocs = Array.from(this.maskedObservationsMap.values());
      await fs.writeFile(this.maskedStorageFilePath, JSON.stringify(allDocs, null, 2), 'utf8');
    } catch {
      // Không làm sập tiến trình nếu ghi file lỗi
    }
  }

  /**
   * Truy hồi chính xác 1 observation theo ID hoặc targetPath
   */
  retrieveMaskedObservation(idOrTarget: string): MaskedObservationRecord | undefined {
    if (!idOrTarget) return undefined;
    if (this.maskedObservationsMap.has(idOrTarget)) {
      return this.maskedObservationsMap.get(idOrTarget);
    }
    const normalizedTarget = path.normalize(idOrTarget).toLowerCase();
    for (const record of this.maskedObservationsMap.values()) {
      if (record.targetPath && path.normalize(record.targetPath).toLowerCase() === normalizedTarget) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * Tìm kiếm các observations đã bị mask liên quan đến query
   */
  searchMaskedObservations(query: string, limit: number = 2): MaskedObservationRecord[] {
    if (!query || this.maskedObservationsMap.size === 0) return [];

    const lowerQuery = query.toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter((t) => t.length >= 3);
    const scored: Array<{ record: MaskedObservationRecord; score: number }> = [];

    for (const record of this.maskedObservationsMap.values()) {
      let score = 0;
      const target = (record.targetPath || '').toLowerCase();
      const command = (record.command || '').toLowerCase();
      const summary = (record.summary || '').toLowerCase();
      const toolName = (record.toolName || '').toLowerCase();

      // Khớp chính xác target file hoặc command
      if (target && lowerQuery.includes(target)) score += 10;
      if (command && lowerQuery.includes(command)) score += 8;

      // Khớp từng token trong query
      for (const token of queryTokens) {
        if (target.includes(token)) score += 3;
        if (command.includes(token)) score += 2;
        if (summary.includes(token)) score += 1;
        if (toolName === token) score += 1;
      }

      if (score > 0) {
        scored.push({ record, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.record);
  }

  /**
   * Ghi toàn bộ dữ liệu ra đĩa an toàn
   */
  private async persist(): Promise<void> {
    try {
      const allDocs = Array.from(this.turnsMap.values());
      await fs.writeFile(this.storageFilePath, JSON.stringify(allDocs, null, 2), 'utf8');
    } catch {
      // Không làm sập tiến trình chính nếu ghi file lỗi
    }
  }

  /**
   * Tìm kiếm các turn cũ có liên quan ngữ nghĩa tới câu lệnh hiện tại
   */
  async retrieveRelevantTurns(
    query: string,
    options?: TurnMemoryOptions
  ): Promise<RetrievalResult[]> {
    await this.init();
    if (!query || query.trim().length === 0 || this.turnsMap.size === 0) {
      return [];
    }

    const topK = options?.topK ?? 2;
    const minScore = options?.minScore ?? 0.55;

    // 1. Tìm kiếm BM25 qua MiniSearch
    const bm25Hits = this.miniSearch.search(query);
    const scoreMap = new Map<string, { bm25Score: number; vectorScore: number }>();

    let maxBm25 = 1;
    for (const hit of bm25Hits) {
      if (hit.score > maxBm25) maxBm25 = hit.score;
    }

    for (const hit of bm25Hits) {
      const normalizedScore = hit.score / maxBm25;
      scoreMap.set(hit.id, { bm25Score: normalizedScore, vectorScore: 0 });
    }

    // 2. Tìm kiếm Dense Vector Cosine Similarity (nếu Rust Native khả dụng)
    const native = getNativeCore();
    if (native && typeof native.rsGenerateSubwordEmbedding === 'function' && typeof native.rsCosineSimilarity === 'function') {
      try {
        const queryVector = native.rsGenerateSubwordEmbedding(query);
        for (const [id, doc] of this.turnsMap.entries()) {
          if (doc.vector && doc.vector.length > 0) {
            const cosSim = native.rsCosineSimilarity(queryVector, doc.vector);
            const existing = scoreMap.get(id) || { bm25Score: 0, vectorScore: 0 };
            existing.vectorScore = Math.max(0, cosSim);
            scoreMap.set(id, existing);
          }
        }
      } catch {
        // Fallback sang thuần BM25
      }
    }

    // 3. Kết hợp điểm số Hybrid
    const scoredResults: RetrievalResult[] = [];
    for (const [id, scores] of scoreMap.entries()) {
      const doc = this.turnsMap.get(id);
      if (!doc) continue;

      let finalScore = 0;
      let matchType: 'bm25' | 'vector' | 'hybrid' = 'bm25';

      if (scores.bm25Score > 0 && scores.vectorScore > 0) {
        finalScore = (scores.bm25Score * 0.5) + (scores.vectorScore * 0.5);
        matchType = 'hybrid';
      } else if (scores.vectorScore > 0) {
        finalScore = scores.vectorScore;
        matchType = 'vector';
      } else {
        finalScore = scores.bm25Score;
        matchType = 'bm25';
      }

      if (finalScore >= minScore) {
        scoredResults.push({
          turn: doc,
          score: Number(finalScore.toFixed(3)),
          matchType,
        });
      }
    }

    // Sắp xếp giảm dần theo điểm số
    scoredResults.sort((a, b) => b.score - a.score);
    return scoredResults.slice(0, topK);
  }

  /**
   * Định dạng dữ liệu truy hồi thành khối văn bản tinh gọn để chèn vào Dynamic Execution Context
   */
  formatForContextInjection(results: RetrievalResult[]): string {
    if (results.length === 0) return '';

    const lines: string[] = [
      `🧠 [SELECTIVELY RECALLED EPISODIC MEMORY - PAST TURNS]:`,
      `> Context retrieved selectively from previously compacted turns based on high semantic affinity:`,
    ];

    for (const res of results) {
      const t = res.turn;
      lines.push(
        `• Turn #${t.turnNumber} (Relevance: ${(res.score * 100).toFixed(0)}%, Mode: ${res.matchType}):`,
        `  - User Goal: "${t.userPrompt.slice(0, 160)}${t.userPrompt.length > 160 ? '...' : ''}"`,
        `  - Outcome: ${t.assistantSummary.slice(0, 220)}${t.assistantSummary.length > 220 ? '...' : ''}`
      );
      if (t.filesTouched && t.filesTouched.length > 0) {
        lines.push(`  - Files Modified: ${t.filesTouched.slice(0, 4).join(', ')}`);
      }
      if (t.keyDecisions && t.keyDecisions.length > 0) {
        lines.push(`  - Key Invariant: ${t.keyDecisions.slice(0, 2).join('; ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Định dạng dữ liệu Observation đã bị Mask để Re-inject on-demand
   */
  formatMaskedObservationForContext(record: MaskedObservationRecord): string {
    const lines: string[] = [
      `📦 [ON-DEMAND UNMASKED OBSERVATION: ${record.toolName} (ID: ${record.id})]`,
    ];
    if (record.targetPath) {
      lines.push(`  - Target: ${record.targetPath}`);
    }
    if (record.command) {
      lines.push(`  - Command: ${record.command} (exitCode: ${record.exitCode ?? 0})`);
    }
    lines.push(`  - Summary: ${record.summary}`);

    // Trích xuất preview an toàn từ originalPayload để Agent có đủ dữ liệu mà không tràn context
    if (record.originalPayload) {
      const p = record.originalPayload;
      if (p.content && typeof p.content === 'string') {
        const preview = p.content.slice(0, 400);
        lines.push(`  - Cached Content Preview:\n\`\`\`\n${preview}${p.content.length > 400 ? '\n... [truncated]' : ''}\n\`\`\``);
      } else if (p.stdout || p.stderr) {
        const out = String(p.stdout || p.stderr || '').trim();
        const preview = out.slice(0, 400);
        lines.push(`  - Cached Output Preview:\n\`\`\`\n${preview}${out.length > 400 ? '\n... [truncated]' : ''}\n\`\`\``);
      }
    }
    return lines.join('\n');
  }

  /**
   * Truy vấn và sinh trực tiếp đoạn ngữ cảnh re-injection nếu có turn hoặc observation liên quan
   */
  async retrieveContextSnippet(query: string, options?: TurnMemoryOptions): Promise<string> {
    await this.init();
    const snippets: string[] = [];

    // 1. Episodic past turns
    const results = await this.retrieveRelevantTurns(query, options);
    if (results.length > 0) {
      snippets.push(this.formatForContextInjection(results));
    }

    // 2. On-demand masked observations
    const matchedObs = this.searchMaskedObservations(query, 2);
    if (matchedObs.length > 0) {
      const obsSnippets = matchedObs.map((obs) => this.formatMaskedObservationForContext(obs));
      snippets.push(
        `🔍 [ON-DEMAND RETRIEVED OBSERVATIONS - EPISODIC CACHE]:\n> Previously masked observations retrieved on-demand to avoid re-running tools:\n` +
        obsSnippets.join('\n\n')
      );
    }

    return snippets.join('\n\n');
  }

  getArchivedTurnCount(): number {
    return this.turnsMap.size;
  }

  getMaskedObservationCount(): number {
    return this.maskedObservationsMap.size;
  }
}
