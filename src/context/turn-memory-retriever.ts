import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import MiniSearch from 'minisearch';
import { getNativeCore } from '../native/index.js';
import type { MaskedObservationRecord } from '../agent/context-compactor.js';
import { LivingPlaybookManager } from './living-playbook.js';

export interface FileDeltaRecord {
  path: string;
  action: 'read' | 'created' | 'modified' | 'deleted';
  modifiedSymbols?: string[];
  summary?: string;
}

export interface ArchivedTurnDocument {
  id: string;
  turnNumber: number;
  userPrompt: string;
  assistantSummary: string;
  toolsUsed: string[];
  filesTouched: string[];
  fileDeltas?: FileDeltaRecord[];
  highSaliencyTraces?: string[];
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
  activeFiles?: string[];
  /** Vector embedding của query đã tính trước để các tầng retrieval dùng chung. */
  queryVector?: number[];
}

/** Trần bộ nhớ để chi phí cuối mỗi turn không tăng theo tuổi workspace. */
export const MAX_ARCHIVED_TURNS = 200;
export const MAX_EPISODIC_EXPERIENCES = 100;
export const MAX_SEMANTIC_INVARIANTS = 100;
const MAX_SNIPPET_MEMO_ENTRIES = 5;

interface NativeVectorScorer {
  rsCosineSimilarity?(query: number[], candidate: number[]): number;
  rsBatchCosineSimilarity?(query: Float64Array, database: Float64Array, dims: number): number[];
}

/** Scores same-sized vectors in one N-API crossing when the native batch API is available. */
export function scoreVectorBatch(
  native: NativeVectorScorer,
  query: number[],
  candidates: Iterable<[string, number[] | undefined]>,
): Map<string, number> {
  const valid = Array.from(candidates).filter(([, vector]) => vector?.length === query.length) as Array<[string, number[]]>;
  const scores = new Map<string, number>();
  if (valid.length === 0 || query.length === 0) return scores;

  if (typeof native.rsBatchCosineSimilarity === 'function') {
    try {
      const database = new Float64Array(valid.length * query.length);
      for (let row = 0; row < valid.length; row++) {
        database.set(valid[row][1], row * query.length);
      }
      const batchScores = native.rsBatchCosineSimilarity(new Float64Array(query), database, query.length);
      for (let index = 0; index < valid.length; index++) {
        scores.set(valid[index][0], Math.max(0, Number(batchScores[index]) || 0));
      }
      return scores;
    } catch {
      // Retain scalar compatibility with older native artifacts.
    }
  }

  if (typeof native.rsCosineSimilarity === 'function') {
    for (const [id, vector] of valid) {
      try {
        scores.set(id, Math.max(0, native.rsCosineSimilarity(query, vector)));
      } catch {
        // Skip individual malformed vectors without failing retrieval.
      }
    }
  }
  return scores;
}

export interface AntiPatternRecord {
  id: string;
  triggerPattern: string;
  failedApproach: string;
  negativeConstraint: string;
  taskClass?: string;
  timestamp: string;
  repetitionCount?: number;
}

/**
 * ExpeRepair (arXiv:2506.10484) Episodic Experience Record
 * Lưu vết cụ thể ca sửa lỗi / tính năng thành công để tái sử dụng
 */
export interface EpisodicExperienceRecord {
  id: string;
  taskIntent: string;
  rootCause?: string;
  faultLocalizedEntities: string[];
  patchSummary: string;
  verificationCommand: string;
  verificationExitCode: number;
  fileHashes?: Record<string, string>;
  timestamp: string;
  accessCount?: number;
  lastAccessedAt?: string;
  isStale?: boolean;
  vector?: number[];
}

/**
 * ExpeRepair (arXiv:2506.10484) Semantic Invariant Record
 * Quy tắc, hợp đồng và bất biến kiến trúc trừu tượng rút ra từ quá khứ
 */
export interface SemanticInvariantRecord {
  id: string;
  ruleStatement: string;
  category: 'architecture_invariant' | 'api_contract' | 'coding_convention' | 'negative_constraint';
  applicablePatterns: string[];
  provenanceCitation?: string;
  confidence: number;
  accessCount?: number;
  lastValidatedAt?: string;
}

/**
 * Kết quả truy hồi Dual-Memory có cổng lọc Contrastive Relevance Gate (CTIM-Rover arXiv:2505.23422)
 */
export interface DualMemoryRetrievalResult {
  episodicExemplars: Array<{
    record: EpisodicExperienceRecord;
    score: number;
    gatingTier: 'full_exemplar' | 'advisory_hint';
  }>;
  semanticInvariants: Array<{
    record: SemanticInvariantRecord;
    score: number;
  }>;
  rendered: string;
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
 * 5. Episodic Anti-Pattern Memory (Meta-Harness 2026): Tự động lưu trữ và tái nạp các bài học/ràng buộc phủ định
 *    từ các thất bại trước đó để ngăn Agent lặp lại cùng một sai lầm.
 * 6. Dual-Memory Stream (ExpeRepair arXiv:2506.10484): Tách biệt kho lưu trữ Episodic và Semantic Memory.
 * 7. Contrastive Relevance Gating (CTIM-Rover arXiv:2505.23422): Chặn 100% rác bộ nhớ và bẫy tương tự sai lệch.
 * 8. Memory Hygiene & Citation Staleness Audit (DreamBench-SWE arXiv:2608.20664): Loại bỏ ký ức cũ khi mã nguồn thay đổi.
 */
export class TurnMemoryRetriever {
  readonly workspaceDir: string;
  readonly storageDir: string;
  readonly storageFilePath: string;
  readonly maskedStorageFilePath: string;
  readonly antiPatternsFilePath: string;
  readonly episodicStorageFilePath: string;
  readonly semanticStorageFilePath: string;

  private miniSearch: MiniSearch<ArchivedTurnDocument>;
  private episodicMiniSearch: MiniSearch<EpisodicExperienceRecord>;
  private semanticMiniSearch: MiniSearch<SemanticInvariantRecord>;
  private turnsMap: Map<string, ArchivedTurnDocument> = new Map();
  private maskedObservationsMap: Map<string, MaskedObservationRecord> = new Map();
  private antiPatternsMap: Map<string, AntiPatternRecord> = new Map();
  private episodicMap: Map<string, EpisodicExperienceRecord> = new Map();
  private semanticMap: Map<string, SemanticInvariantRecord> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private memoryVersion = 0;
  private snippetMemo = new Map<string, string>();
  private readonly snippetCacheStats = { hits: 0, misses: 0 };

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
    this.storageDir = path.join(this.workspaceDir, '.codingagent', 'memory');
    this.storageFilePath = path.join(this.storageDir, 'archived_turns.json');
    this.maskedStorageFilePath = path.join(this.storageDir, 'masked_observations.json');
    this.antiPatternsFilePath = path.join(this.storageDir, 'anti_patterns.json');
    this.episodicStorageFilePath = path.join(this.storageDir, 'episodic_experiences.json');
    this.semanticStorageFilePath = path.join(this.storageDir, 'semantic_invariants.json');

    this.livingPlaybook = new LivingPlaybookManager(this.workspaceDir);
    this.miniSearch = this.createMiniSearch();
    this.episodicMiniSearch = this.createEpisodicMiniSearch();
    this.semanticMiniSearch = this.createSemanticMiniSearch();
  }

  readonly livingPlaybook: LivingPlaybookManager;

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

  private createEpisodicMiniSearch(): MiniSearch<EpisodicExperienceRecord> {
    return new MiniSearch<EpisodicExperienceRecord>({
      fields: ['taskIntent', 'rootCause', 'faultLocalizedEntities', 'patchSummary', 'verificationCommand'],
      storeFields: ['id', 'taskIntent', 'rootCause', 'faultLocalizedEntities', 'patchSummary', 'verificationCommand', 'verificationExitCode', 'timestamp', 'isStale', 'accessCount'],
      searchOptions: {
        boost: {
          taskIntent: 2.5,
          faultLocalizedEntities: 2.5,
          rootCause: 2.0,
          patchSummary: 1.2,
          verificationCommand: 1.0,
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

  private createSemanticMiniSearch(): MiniSearch<SemanticInvariantRecord> {
    return new MiniSearch<SemanticInvariantRecord>({
      fields: ['ruleStatement', 'category', 'applicablePatterns', 'provenanceCitation'],
      storeFields: ['id', 'ruleStatement', 'category', 'applicablePatterns', 'provenanceCitation', 'confidence', 'accessCount'],
      searchOptions: {
        boost: {
          ruleStatement: 2.5,
          applicablePatterns: 2.0,
          category: 1.5,
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
    if (!this.initPromise) {
      this.initPromise = this.loadPersistedState().then(
        () => { this.initialized = true; },
        (error) => { this.initPromise = undefined; throw error; },
      );
    }
    return this.initPromise;
  }

  /**
   * Nạp toàn bộ state từ đĩa. Luôn chạy đúng một lần nhờ init-promise: mọi
   * caller đồng thời đều await cùng một promise, nên không còn cửa sổ "đã khởi
   * tạo nhưng map vẫn rỗng" khiến persist() ghi đè mất dữ liệu đĩa.
   */
  private async loadPersistedState(): Promise<void> {
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

    try {
      const apRaw = await fs.readFile(this.antiPatternsFilePath, 'utf8');
      const apDocs: AntiPatternRecord[] = JSON.parse(apRaw);
      if (Array.isArray(apDocs) && apDocs.length > 0) {
        for (const doc of apDocs) {
          this.antiPatternsMap.set(doc.id, doc);
        }
      }
    } catch {
      // File chưa tồn tại hoặc rỗng, bỏ qua
    }

    try {
      const epRaw = await fs.readFile(this.episodicStorageFilePath, 'utf8');
      const epDocs: EpisodicExperienceRecord[] = JSON.parse(epRaw);
      if (Array.isArray(epDocs) && epDocs.length > 0) {
        for (const doc of epDocs) {
          this.episodicMap.set(doc.id, doc);
        }
        this.episodicMiniSearch.removeAll();
        this.episodicMiniSearch.addAll(epDocs);
      }
    } catch {
      // File chưa tồn tại hoặc rỗng, bỏ qua
    }

    try {
      const semRaw = await fs.readFile(this.semanticStorageFilePath, 'utf8');
      const semDocs: SemanticInvariantRecord[] = JSON.parse(semRaw);
      if (Array.isArray(semDocs) && semDocs.length > 0) {
        for (const doc of semDocs) {
          this.semanticMap.set(doc.id, doc);
        }
        this.semanticMiniSearch.removeAll();
        this.semanticMiniSearch.addAll(semDocs);
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

    const { evictedTurns } = this.enforceMemoryCaps();
    if (newDocs.length > 0) {
      this.bumpMemoryVersion();
      this.miniSearch.addAll(newDocs);
      await this.persist();
    } else if (evictedTurns > 0) {
      await this.persist();
    }
  }

  /**
   * Lưu trữ các observations đã bị mask vào bộ nhớ on-demand (tối ưu bộ nhớ RAM)
   */
  async archiveMaskedObservations(records: MaskedObservationRecord[]): Promise<void> {
    await this.init();
    if (!records || records.length === 0) return;

    let hasNew = false;
    for (const rec of records) {
      if (!this.maskedObservationsMap.has(rec.id)) {
        // Tối ưu RAM: Cắt gọn payload khổng lồ (> 64KB) nếu là chuỗi dài hoặc object cồng kềnh
        let optimizedPayload = rec.originalPayload;
        if (typeof optimizedPayload === 'string' && optimizedPayload.length > 64 * 1024) {
          optimizedPayload = `${optimizedPayload.slice(0, 32 * 1024)}\n...[TRUNCATED IN-MEMORY OBSERVATION: ${optimizedPayload.length} bytes]...\n${optimizedPayload.slice(-16 * 1024)}`;
        } else if (optimizedPayload && typeof optimizedPayload === 'object') {
          const serialized = JSON.stringify(optimizedPayload);
          if (serialized.length > 64 * 1024) {
            optimizedPayload = {
              ...optimizedPayload,
              content: typeof (optimizedPayload as any).content === 'string'
                ? `${(optimizedPayload as any).content.slice(0, 32 * 1024)}\n...[TRUNCATED IN-MEMORY CONTENT]...`
                : (optimizedPayload as any).content,
            };
          }
        }
        this.maskedObservationsMap.set(rec.id, {
          ...rec,
          originalPayload: optimizedPayload,
        });
        hasNew = true;
      }
    }

    // Giữ tối đa 40 observations gần nhất để tối ưu RAM (< 50MB)
    const MAX_MASKED_IN_MEMORY = 40;
    if (this.maskedObservationsMap.size > MAX_MASKED_IN_MEMORY) {
      const keys = Array.from(this.maskedObservationsMap.keys());
      const toRemove = keys.slice(0, keys.length - MAX_MASKED_IN_MEMORY);
      for (const k of toRemove) {
        this.maskedObservationsMap.delete(k);
      }
    }

    if (hasNew) {
      this.bumpMemoryVersion();
      await this.persistMaskedObservations();
    }
  }

  private async persistMaskedObservations(): Promise<void> {
    try {
      const allDocs = Array.from(this.maskedObservationsMap.values());
      await fs.writeFile(this.maskedStorageFilePath, JSON.stringify(allDocs), 'utf8');
    } catch {
      // Không làm sập tiến trình nếu ghi file lỗi
    }
  }

  /**
   * Truy hồi chính xác 1 observation theo ID hoặc targetPath
   */
  retrieveMaskedObservation(idOrTarget: string): MaskedObservationRecord | undefined {
    if (!idOrTarget || typeof idOrTarget !== 'string') return undefined;
    const trimmed = idOrTarget.trim();
    if (this.maskedObservationsMap.has(trimmed)) {
      return this.maskedObservationsMap.get(trimmed);
    }
    const targetVariants = new Set([
      trimmed,
      trimmed.toLowerCase(),
      path.normalize(trimmed).toLowerCase(),
      path.resolve(trimmed).toLowerCase(),
      path.normalize(trimmed).toLowerCase().replace(/\\/g, '/'),
      path.resolve(trimmed).toLowerCase().replace(/\\/g, '/'),
    ]);
    for (const record of this.maskedObservationsMap.values()) {
      if (record.id && targetVariants.has(record.id)) return record;
      if (record.targetPath) {
        const recordVariants = [
          record.targetPath,
          record.targetPath.toLowerCase(),
          path.normalize(record.targetPath).toLowerCase(),
          path.resolve(record.targetPath).toLowerCase(),
          path.normalize(record.targetPath).toLowerCase().replace(/\\/g, '/'),
          path.resolve(record.targetPath).toLowerCase().replace(/\\/g, '/'),
        ];
        if (recordVariants.some((v) => targetVariants.has(v))) {
          return record;
        }
      }
      if (record.command && (record.command === trimmed || record.command.toLowerCase() === trimmed.toLowerCase())) {
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

    // 2. Tìm kiếm Dense Vector Cosine Similarity (dùng vector đã tính trước nếu có
    // để retrieveContextSnippet chỉ sinh embedding một lần cho mọi tầng).
    const native = getNativeCore();
    let queryVector = options?.queryVector;
    if (!queryVector && native && typeof native.rsGenerateSubwordEmbedding === 'function') {
      try {
        queryVector = native.rsGenerateSubwordEmbedding(query);
      } catch {
        queryVector = undefined;
      }
    }
    if (queryVector && native && typeof native.rsCosineSimilarity === 'function') {
      try {
        const vectorScores = scoreVectorBatch(native, queryVector, Array.from(this.turnsMap.entries(), ([id, doc]) => [id, doc.vector]));
        for (const [id, doc] of this.turnsMap.entries()) {
          if (doc.vector && doc.vector.length > 0) {
            const cosSim = vectorScores.get(id) || 0;
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
   * Lưu trữ một bài học thất bại (Anti-Pattern) vào cơ sở dữ liệu trí nhớ dài hạn
   */
  async recordAntiPattern(record: AntiPatternRecord): Promise<void> {
    await this.init();
    if (!record || !record.id) return;

    const existing = this.antiPatternsMap.get(record.id);
    if (existing) {
      existing.repetitionCount = (existing.repetitionCount || 1) + 1;
      existing.timestamp = record.timestamp || new Date().toISOString();
      if (record.negativeConstraint) existing.negativeConstraint = record.negativeConstraint;
    } else {
      this.antiPatternsMap.set(record.id, {
        ...record,
        repetitionCount: record.repetitionCount || 1,
      });
    }

    // Giới hạn tối đa 50 anti-patterns gần nhất
    if (this.antiPatternsMap.size > 50) {
      const keys = Array.from(this.antiPatternsMap.keys());
      const toRemove = keys.slice(0, keys.length - 50);
      for (const k of toRemove) {
        this.antiPatternsMap.delete(k);
      }
    }
    this.bumpMemoryVersion();

    try {
      const all = Array.from(this.antiPatternsMap.values());
      await fs.writeFile(this.antiPatternsFilePath, JSON.stringify(all, null, 2), 'utf8');
    } catch {
      // Bỏ qua lỗi ghi đĩa
    }
  }

  /**
   * Tìm kiếm các Anti-Pattern liên quan đến câu lệnh / ngữ cảnh hiện tại
   */
  retrieveRelevantAntiPatterns(query: string, limit: number = 2): AntiPatternRecord[] {
    if (!query || this.antiPatternsMap.size === 0) return [];
    const lowerQuery = query.toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter((t) => t.length >= 3);
    const scored: Array<{ record: AntiPatternRecord; score: number }> = [];

    for (const record of this.antiPatternsMap.values()) {
      let score = 0;
      const trigger = (record.triggerPattern || '').toLowerCase();
      const failed = (record.failedApproach || '').toLowerCase();
      const constraint = (record.negativeConstraint || '').toLowerCase();

      if (trigger && lowerQuery.includes(trigger)) score += 10;
      for (const token of queryTokens) {
        if (trigger.includes(token)) score += 3;
        if (failed.includes(token)) score += 2;
        if (constraint.includes(token)) score += 1;
      }

      if (score > 0) {
        scored.push({ record, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.record);
  }

  /**
   * Định dạng khối Anti-Patterns thành hướng dẫn ràng buộc phủ định
   */
  formatAntiPatternsForContext(patterns: AntiPatternRecord[]): string {
    if (patterns.length === 0) return '';
    const lines: string[] = [
      `🚫 [EPISODIC ANTI-PATTERNS - AVOID THESE PAST MISTAKES]:`,
      `> Lessons learned from past failed trajectories on this codebase:`,
    ];
    for (const p of patterns) {
      lines.push(
        `• Context: "${p.triggerPattern}" (Failed times: ${p.repetitionCount || 1})`,
        `  - Flawed Approach: ${p.failedApproach}`,
        `  - MANDATORY NEGATIVE CONSTRAINT: ${p.negativeConstraint}`
      );
    }
    return lines.join('\n');
  }

  /**
   * Truy vấn và sinh trực tiếp đoạn ngữ cảnh re-injection nếu có turn, observation hoặc anti-pattern liên quan
   */
  async retrieveContextSnippet(query: string, options?: TurnMemoryOptions): Promise<string> {
    await this.init();
    // Memo theo query trong cùng một turn: các step liên tiếp thường hỏi giống nhau,
    // mọi ghi vào kho đều đã xóa memo qua bumpMemoryVersion().
    const memoKey = JSON.stringify({
      q: query,
      topK: options?.topK ?? 2,
      minScore: options?.minScore ?? 0.60,
      files: [...(options?.activeFiles || [])].sort(),
      pv: this.livingPlaybook.getVersion(),
    });
    const memoized = this.snippetMemo.get(memoKey);
    if (memoized !== undefined) {
      this.snippetCacheStats.hits++;
      return memoized;
    }
    this.snippetCacheStats.misses++;
    const snippets: string[] = [];

    // Sinh embedding một lần, dùng chung cho cả hai tầng retrieval.
    const native = getNativeCore();
    let sharedQueryVector: number[] | undefined;
    if (native && typeof native.rsGenerateSubwordEmbedding === 'function') {
      try {
        sharedQueryVector = native.rsGenerateSubwordEmbedding(query);
      } catch {
        sharedQueryVector = undefined;
      }
    }

    // 0. Dual-Memory Stream (ExpeRepair & CTIM-Rover)
    const dualMem = await this.retrieveDualMemory(query, {
      topK: options?.topK ?? 2,
      minScore: options?.minScore ?? 0.60,
      activeFiles: options?.activeFiles,
      queryVector: sharedQueryVector,
    });
    if (dualMem.rendered) {
      snippets.push(dualMem.rendered);
    }

    // 1. Episodic past turns
    const results = await this.retrieveRelevantTurns(query, { ...options, queryVector: sharedQueryVector });
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

    // 3. Episodic anti-patterns (Bài học từ thất bại quá khứ)
    const matchedAntiPatterns = this.retrieveRelevantAntiPatterns(query, 2);
    if (matchedAntiPatterns.length > 0) {
      snippets.push(this.formatAntiPatternsForContext(matchedAntiPatterns));
    }

    // 4. Living Playbook Bullets (Agentic Context Engineering - ACE)
    try {
      await this.livingPlaybook.init();
      const matchedBullets = this.livingPlaybook.subsetRelevantBullets(query, 3);
      if (matchedBullets.length > 0) {
        snippets.push(this.livingPlaybook.formatForPromptContext(matchedBullets));
      }
    } catch {
      // Bỏ qua nếu lỗi đọc playbook
    }

    const snippet = snippets.join('\n\n');
    if (this.snippetMemo.size >= MAX_SNIPPET_MEMO_ENTRIES) {
      const oldest = this.snippetMemo.keys().next();
      if (!oldest.done) this.snippetMemo.delete(oldest.value);
    }
    this.snippetMemo.set(memoKey, snippet);
    return snippet;
  }

  /**
   * Lưu trữ một ca sửa lỗi / tính năng thành công vào kho Episodic Experience (ExpeRepair)
   */
  async recordEpisodicExperience(
    record: Omit<EpisodicExperienceRecord, 'timestamp'> & { timestamp?: string }
  ): Promise<EpisodicExperienceRecord> {
    await this.init();
    const id = record.id || `ep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = record.timestamp || new Date().toISOString();

    // Tự động tính hash các file liên quan để phục vụ Memory Hygiene Audit (DreamBench-SWE)
    const fileHashes: Record<string, string> = { ...(record.fileHashes || {}) };
    for (const relFile of record.faultLocalizedEntities || []) {
      if (!fileHashes[relFile]) {
        try {
          const absPath = path.isAbsolute(relFile) ? relFile : path.resolve(this.workspaceDir, relFile);
          const content = await fs.readFile(absPath, 'utf8');
          fileHashes[relFile] = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        } catch {
          // Bỏ qua nếu file không tồn tại trên đĩa
        }
      }
    }

    // Tự động tính subword embedding vector nếu có native SIMD
    const native = getNativeCore();
    let vector = record.vector;
    if (!vector && native && typeof native.rsGenerateSubwordEmbedding === 'function') {
      try {
        const textForEmbedding = `${record.taskIntent} ${record.rootCause || ''} ${record.faultLocalizedEntities.join(' ')}`;
        vector = native.rsGenerateSubwordEmbedding(textForEmbedding);
      } catch {}
    }

    const fullRecord: EpisodicExperienceRecord = {
      ...record,
      id,
      timestamp,
      fileHashes,
      accessCount: record.accessCount ?? 0,
      isStale: record.isStale ?? false,
      vector,
    };

    const isUpdate = this.episodicMap.has(id);
    this.episodicMap.set(id, fullRecord);
    // Index tăng dần thay vì removeAll+addAll toàn bộ mỗi lần ghi.
    if (isUpdate) {
      try { this.episodicMiniSearch.discard(id); } catch { /* best-effort */ }
    }
    this.episodicMiniSearch.add(fullRecord);
    this.enforceMemoryCaps();
    this.bumpMemoryVersion();
    await this.persistEpisodic();
    return fullRecord;
  }

  /**
   * Lưu trữ quy tắc / bất biến kiến trúc trừu tượng (ExpeRepair Semantic Memory)
   */
  async recordSemanticInvariant(record: SemanticInvariantRecord): Promise<void> {
    await this.init();
    const existing = this.semanticMap.get(record.id);
    if (existing) {
      existing.ruleStatement = record.ruleStatement;
      existing.confidence = record.confidence;
      existing.applicablePatterns = record.applicablePatterns;
      existing.provenanceCitation = record.provenanceCitation || existing.provenanceCitation;
      existing.accessCount = (existing.accessCount || 0) + 1;
      existing.lastValidatedAt = new Date().toISOString();
    } else {
      this.semanticMap.set(record.id, {
        ...record,
        accessCount: record.accessCount ?? 0,
        lastValidatedAt: record.lastValidatedAt || new Date().toISOString(),
      });
    }

    // Index tăng dần thay vì removeAll+addAll toàn bộ mỗi lần ghi.
    try { this.semanticMiniSearch.discard(record.id); } catch { /* best-effort */ }
    const stored = this.semanticMap.get(record.id);
    if (stored) this.semanticMiniSearch.add(stored);
    this.enforceMemoryCaps();
    this.bumpMemoryVersion();
    await this.persistSemantic();
  }

  /**
   * Memory Hygiene Audit (DreamBench-SWE arXiv:2608.20664):
   * Tự động kiểm tra tính hợp lệ của các file trong Episodic Memory.
   * Nếu file đã bị sửa đổi đáng kể hoặc bị xóa, đánh dấu record là isStale: true.
   */
  async auditMemoryHygiene(): Promise<{ totalChecked: number; staleCount: number; validCount: number }> {
    await this.init();
    let staleCount = 0;
    let validCount = 0;

    for (const record of this.episodicMap.values()) {
      if (!record.fileHashes || Object.keys(record.fileHashes).length === 0) {
        validCount++;
        continue;
      }

      let isStale = false;
      for (const [relPath, expectedHash] of Object.entries(record.fileHashes)) {
        try {
          const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(this.workspaceDir, relPath);
          const content = await fs.readFile(absPath, 'utf8');
          const currentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
          if (currentHash !== expectedHash) {
            isStale = true;
            break;
          }
        } catch {
          // File đã bị xóa hoặc đổi tên
          isStale = true;
          break;
        }
      }

      record.isStale = isStale;
      if (isStale) {
        staleCount++;
      } else {
        validCount++;
      }
    }

    if (staleCount > 0) {
      await this.persistEpisodic();
    }

    return {
      totalChecked: this.episodicMap.size,
      staleCount,
      validCount,
    };
  }

  /**
   * Truy hồi lai Dual-Memory với Cổng lọc Contrastive Relevance Gate (CTIM-Rover)
   */
  async retrieveDualMemory(
    query: string,
    options?: { topK?: number; minScore?: number; activeFiles?: string[]; queryVector?: number[] }
  ): Promise<DualMemoryRetrievalResult> {
    await this.init();
    const topK = options?.topK ?? 2;
    const minScore = options?.minScore ?? 0.60;
    const activeFiles = (options?.activeFiles || []).map((f) => path.basename(f).toLowerCase());

    if (!query || query.trim().length === 0) {
      return { episodicExemplars: [], semanticInvariants: [], rendered: '' };
    }
    if (this.episodicMap.size === 0 && this.semanticMap.size === 0) {
      return { episodicExemplars: [], semanticInvariants: [], rendered: '' };
    }

    const native = getNativeCore();
    let queryVector = options?.queryVector;
    if (!queryVector && native && typeof native.rsGenerateSubwordEmbedding === 'function') {
      try {
        queryVector = native.rsGenerateSubwordEmbedding(query);
      } catch {}
    }

    // --- 1. Episodic Retrieval with Contrastive Relevance Gate (CTIM-Rover) ---
    const episodicScores = new Map<string, { bm25: number; vector: number; entityOverlap: number }>();
    const epBm25Hits = this.episodicMiniSearch.search(query);
    let maxEpBm25 = 1;
    for (const h of epBm25Hits) {
      if (h.score > maxEpBm25) maxEpBm25 = h.score;
    }
    for (const h of epBm25Hits) {
      episodicScores.set(h.id, { bm25: h.score / maxEpBm25, vector: 0, entityOverlap: 0 });
    }

    const episodicVectorScores = queryVector && native
      ? scoreVectorBatch(native, queryVector, Array.from(this.episodicMap.entries(), ([id, rec]) => [id, rec.vector]))
      : new Map<string, number>();
    for (const [id, rec] of this.episodicMap.entries()) {
      const entry = episodicScores.get(id) || { bm25: 0, vector: 0, entityOverlap: 0 };
      if (queryVector && rec.vector) {
        entry.vector = episodicVectorScores.get(id) || 0;
      }
      // Check entity overlap
      const hasOverlap = (rec.faultLocalizedEntities || []).some((f) => {
        const base = path.basename(f).toLowerCase();
        return query.toLowerCase().includes(base) || activeFiles.includes(base);
      });
      if (hasOverlap) {
        entry.entityOverlap = 1.0;
      }
      if (entry.bm25 > 0 || entry.vector > 0 || entry.entityOverlap > 0) {
        episodicScores.set(id, entry);
      }
    }

    const candidateEpisodes: Array<{
      record: EpisodicExperienceRecord;
      score: number;
      gatingTier: 'full_exemplar' | 'advisory_hint';
    }> = [];

    for (const [id, sc] of episodicScores.entries()) {
      const rec = this.episodicMap.get(id);
      if (!rec) continue;
      let score = (sc.bm25 * 0.45) + (sc.vector * 0.35) + (sc.entityOverlap * 0.20);

      // Frequency boost: SWE-Bench-CL
      const accessCount = rec.accessCount || 0;
      score = score * (1 + 0.1 * Math.log(1 + accessCount));

      // Staleness penalty: DreamBench-SWE
      if (rec.isStale) {
        score = score * 0.5;
      }

      // Revalidate high-value exemplars against the current repository before injection.
      // Similarity alone is insufficient because a once-correct patch can become stale.
      if (score >= minScore) {
        const repositoryCurrent = await this.verifyEpisodicRecordCurrent(rec);
        const hasEntityEvidence = sc.entityOverlap > 0 || sc.bm25 >= 0.55;
        if (!repositoryCurrent) {
          rec.isStale = true;
          score *= 0.5;
        }
        if (score < minScore || (!hasEntityEvidence && score < 0.82)) continue;
        const gatingTier = repositoryCurrent && hasEntityEvidence && score >= 0.78
          ? 'full_exemplar'
          : 'advisory_hint';
        candidateEpisodes.push({
          record: rec,
          score: Number(score.toFixed(3)),
          gatingTier,
        });
        rec.accessCount = accessCount + 1;
        rec.lastAccessedAt = new Date().toISOString();
      }
    }

    candidateEpisodes.sort((a, b) => b.score - a.score);
    const selectedEpisodes = candidateEpisodes.slice(0, topK);

    // --- 2. Semantic Invariants Retrieval ---
    const semanticScores = new Map<string, number>();
    const semHits = this.semanticMiniSearch.search(query);
    let maxSem = 1;
    for (const h of semHits) {
      if (h.score > maxSem) maxSem = h.score;
    }
    for (const h of semHits) {
      semanticScores.set(h.id, h.score / maxSem);
    }

    // Direct keyword check for applicablePatterns
    for (const [id, inv] of this.semanticMap.entries()) {
      const matchPattern = (inv.applicablePatterns || []).some((p) => query.toLowerCase().includes(p.toLowerCase()));
      if (matchPattern) {
        const cur = semanticScores.get(id) || 0;
        semanticScores.set(id, Math.max(cur, 0.85));
      }
    }

    const candidateSemantics: Array<{
      record: SemanticInvariantRecord;
      score: number;
    }> = [];

    for (const [id, score] of semanticScores.entries()) {
      const inv = this.semanticMap.get(id);
      if (!inv) continue;
      if (score >= 0.50) {
        candidateSemantics.push({
          record: inv,
          score: Number(score.toFixed(3)),
        });
        inv.accessCount = (inv.accessCount || 0) + 1;
      }
    }

    candidateSemantics.sort((a, b) => b.score - a.score);
    const selectedSemantics = candidateSemantics.slice(0, 3);

    const result: DualMemoryRetrievalResult = {
      episodicExemplars: selectedEpisodes,
      semanticInvariants: selectedSemantics,
      rendered: '',
    };

    result.rendered = this.formatDualMemoryForContext(result);
    return result;
  }

  private async verifyEpisodicRecordCurrent(record: EpisodicExperienceRecord): Promise<boolean> {
    if (record.isStale) return false;
    const hashes = record.fileHashes || {};
    const entries = Object.entries(hashes);
    if (entries.length === 0) return true;
    for (const [relativeFile, expectedHash] of entries) {
      try {
        const absoluteFile = path.isAbsolute(relativeFile)
          ? relativeFile
          : path.join(this.workspaceDir, relativeFile);
        const bytes = await fs.readFile(absoluteFile);
        const actualHash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, expectedHash.length);
        if (actualHash !== expectedHash) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Định dạng dữ liệu Dual-Memory thành Markdown có cấu trúc để đưa vào prompt
   */
  formatDualMemoryForContext(dualMem: DualMemoryRetrievalResult): string {
    if (dualMem.episodicExemplars.length === 0 && dualMem.semanticInvariants.length === 0) {
      return '';
    }

    const lines: string[] = [
      `🧠 [DUAL-MEMORY GUIDANCE - EXPEREPAIR & CTIM-ROVER]:`,
      `> Distilled cross-session engineering memory (Gated by strict relevance threshold):`,
    ];

    if (dualMem.episodicExemplars.length > 0) {
      lines.push(`\n[EPISODIC EXPERIENCE DEMONSTRATIONS]:`);
      for (const { record, score, gatingTier } of dualMem.episodicExemplars) {
        const scorePct = (score * 100).toFixed(0);
        if (gatingTier === 'full_exemplar') {
          lines.push(
            `• Verified Case #${record.id} (Relevance: ${scorePct}%, Tier: FULL_EXEMPLAR):`,
            `  - Intent: "${record.taskIntent.slice(0, 140)}"`,
            `  - Root Cause: ${record.rootCause || 'N/A'}`,
            `  - Modified Files: ${record.faultLocalizedEntities.join(', ')}`,
            `  - Verified Diff Hunk:\n\`\`\`diff\n${record.patchSummary.slice(0, 350)}\n\`\`\``,
            `  - Verification Command: \`${record.verificationCommand}\` (exitCode: 0)`
          );
        } else {
          lines.push(
            `• Advisory Hint #${record.id} (Relevance: ${scorePct}%, Tier: ADVISORY_HINT):`,
            `  - Task was solved in files: ${record.faultLocalizedEntities.join(', ')}`,
            `  - Verified with: \`${record.verificationCommand}\``
          );
        }
      }
    }

    if (dualMem.semanticInvariants.length > 0) {
      lines.push(`\n[SEMANTIC ARCHITECTURAL INVARIANTS]:`);
      for (const { record, score } of dualMem.semanticInvariants) {
        lines.push(
          `• Invariant [${record.category.toUpperCase()}] (Score: ${(score * 100).toFixed(0)}%, Confidence: ${(record.confidence * 100).toFixed(0)}%):`,
          `  - Rule: ${record.ruleStatement}`,
          record.provenanceCitation ? `  - Citation: ${record.provenanceCitation}` : ''
        );
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  /**
   * Chưng cất kinh nghiệm từ vòng lặp thực thi của Agent (In-Loop Distillation)
   */
  async distillExperience(params: {
    taskIntent: string;
    rootCause?: string;
    faultLocalizedEntities: string[];
    patchSummary: string;
    verificationCommand: string;
    verificationExitCode?: number;
  }): Promise<EpisodicExperienceRecord> {
    return this.recordEpisodicExperience({
      id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskIntent: params.taskIntent,
      rootCause: params.rootCause,
      faultLocalizedEntities: params.faultLocalizedEntities,
      patchSummary: params.patchSummary,
      verificationCommand: params.verificationCommand,
      verificationExitCode: params.verificationExitCode ?? 0,
    });
  }

  private async persistEpisodic(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const all = Array.from(this.episodicMap.values());
      await fs.writeFile(this.episodicStorageFilePath, JSON.stringify(all, null, 2), 'utf8');
    } catch {}
  }

  private async persistSemantic(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const all = Array.from(this.semanticMap.values());
      await fs.writeFile(this.semanticStorageFilePath, JSON.stringify(all, null, 2), 'utf8');
    } catch {}
  }

  getLivingPlaybook(): LivingPlaybookManager {
    return this.livingPlaybook;
  }

  getSnippetCacheStats(): { hits: number; misses: number } {
    return { ...this.snippetCacheStats };
  }

  /** Mọi ghi vào kho đều bump version để vô hiệu memo snippet cùng turn. */
  private bumpMemoryVersion(): void {
    this.memoryVersion++;
    if (this.snippetMemo.size > 0) this.snippetMemo.clear();
  }

  /** Cắt các map vượt trần theo thứ tự chèn (cũ nhất trước), đồng bộ index. */
  private enforceMemoryCaps(): { evictedTurns: number; evictedEpisodic: number; evictedSemantic: number } {
    let evictedTurns = 0;
    let evictedEpisodic = 0;
    let evictedSemantic = 0;
    if (this.turnsMap.size > MAX_ARCHIVED_TURNS) {
      for (const id of Array.from(this.turnsMap.keys()).slice(0, this.turnsMap.size - MAX_ARCHIVED_TURNS)) {
        this.turnsMap.delete(id);
        try { this.miniSearch.discard(id); } catch { /* best-effort */ }
        evictedTurns++;
      }
    }
    if (this.episodicMap.size > MAX_EPISODIC_EXPERIENCES) {
      for (const id of Array.from(this.episodicMap.keys()).slice(0, this.episodicMap.size - MAX_EPISODIC_EXPERIENCES)) {
        this.episodicMap.delete(id);
        try { this.episodicMiniSearch.discard(id); } catch { /* best-effort */ }
        evictedEpisodic++;
      }
    }
    if (this.semanticMap.size > MAX_SEMANTIC_INVARIANTS) {
      for (const id of Array.from(this.semanticMap.keys()).slice(0, this.semanticMap.size - MAX_SEMANTIC_INVARIANTS)) {
        this.semanticMap.delete(id);
        try { this.semanticMiniSearch.discard(id); } catch { /* best-effort */ }
        evictedSemantic++;
      }
    }
    return { evictedTurns, evictedEpisodic, evictedSemantic };
  }

  getArchivedTurnCount(): number {
    return this.turnsMap.size;
  }

  /**
   * Newest-first lightweight view of archived turns for ellipsis resolution.
   * Sync over the in-memory map so turn start stays latency-free; returns
   * whatever is loaded (possibly empty before init).
   */
  getRecentArchivedTurns(limit = 3): Array<{
    userPrompt: string;
    assistantSummary: string;
    keyDecisions: string[];
    turnNumber: number;
  }> {
    const docs = Array.from(this.turnsMap.values()).sort(
      (a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0),
    );
    return docs
      .slice(-Math.max(1, limit))
      .reverse()
      .map((doc) => ({
        userPrompt: doc.userPrompt || '',
        assistantSummary: doc.assistantSummary || '',
        keyDecisions: [...(doc.keyDecisions || [])],
        turnNumber: doc.turnNumber ?? 0,
      }));
  }

  getMaskedObservationCount(): number {
    return this.maskedObservationsMap.size;
  }

  getAntiPatternCount(): number {
    return this.antiPatternsMap.size;
  }

  getEpisodicExperienceCount(): number {
    return this.episodicMap.size;
  }

  getSemanticInvariantCount(): number {
    return this.semanticMap.size;
  }
}
