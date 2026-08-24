import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface VectorDocument {
  id: string;
  text: string;
  vector: number[];
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface VectorSearchResult {
  document: VectorDocument;
  similarity: number;
}

export interface VectorSearchOptions {
  limit?: number;
  minSimilarity?: number;
  filter?: (doc: VectorDocument) => boolean;
}

/**
 * Tính Cosine Similarity giữa 2 vector đơn vị đã được chuẩn hoá L2.
 * cos(theta) = (A . B) / (||A|| * ||B||)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * EmbeddingService - Dịch vụ Vector Embedding đa tầng:
 * 1. Offline Fast Subword & Character N-Gram Hashing Vectorizer (384-dimensional unit vector):
 *    - 100% Deterministic, không phụ thuộc API key, không độ trễ mạng.
 *    - Trích xuất đặc trưng ngữ nghĩa từ từ vựng, n-gram ký tự (tri-grams/4-grams), tiền tố/hậu tố.
 * 2. Remote Cloud Embedding Provider (Gemini / OpenAI) khi có API key.
 * 3. Tự động Fallback về local vectorizer nếu mạng lỗi hoặc chưa cấu hình key.
 */
export class EmbeddingService {
  public static readonly VECTOR_DIMENSIONS = 384;
  private geminiApiKey?: string;
  private openaiApiKey?: string;

  constructor(options?: { geminiApiKey?: string; openaiApiKey?: string }) {
    this.geminiApiKey = options?.geminiApiKey || process.env.GEMINI_API_KEY;
    this.openaiApiKey = options?.openaiApiKey || process.env.OPENAI_API_KEY;
  }

  /**
   * Tạo vector nhúng chuẩn hoá L2 cho chuỗi văn bản
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const cleanText = text.trim();
    if (!cleanText) {
      return new Array(EmbeddingService.VECTOR_DIMENSIONS).fill(0);
    }

    // 1. Thử gọi Remote Embedding nếu có Gemini API Key
    if (this.geminiApiKey) {
      try {
        const vector = await this.fetchGeminiEmbedding(cleanText);
        if (vector && vector.length > 0) {
          return this.normalizeL2(this.projectDimensions(vector, EmbeddingService.VECTOR_DIMENSIONS));
        }
      } catch {
        // Fallback sang Local Vectorizer
      }
    }

    // 2. Local Deterministic N-Gram Subword Vectorizer (Zero-API-Key, 100% Offline)
    return this.generateLocalSubwordEmbedding(cleanText);
  }

  /**
   * Vectorizer cục bộ hiệu năng cao:
   * Kết hợp Bag-of-Words, Subword Stemming, và Character 3-Gram / 4-Gram Hashing
   */
  generateLocalSubwordEmbedding(text: string): number[] {
    const dims = EmbeddingService.VECTOR_DIMENSIONS;
    const vector = new Array<number>(dims).fill(0);
    const normalized = text.toLowerCase();

    // 1. Phân tách từ (Word Tokens)
    const words = normalized.split(/[^a-z0-9_#$@\.\-]+/).filter((w) => w.length > 0);

    for (const word of words) {
      // Băm toàn từ (Full Word Hash)
      const wordHash = this.hashString(word);
      const idx1 = Math.abs(wordHash) % dims;
      const sign1 = wordHash % 2 === 0 ? 1.0 : -1.0;
      vector[idx1] += 2.0 * sign1;

      // 2. Character N-Grams (Tri-grams & 4-grams cho Subword Similarity)
      if (word.length >= 3) {
        for (let i = 0; i <= word.length - 3; i++) {
          const tri = word.slice(i, i + 3);
          const triHash = this.hashString(tri);
          const idx2 = Math.abs(triHash) % dims;
          const sign2 = triHash % 2 === 0 ? 0.5 : -0.5;
          vector[idx2] += sign2;
        }
      }

      if (word.length >= 4) {
        for (let i = 0; i <= word.length - 4; i++) {
          const quad = word.slice(i, i + 4);
          const quadHash = this.hashString(quad);
          const idx3 = Math.abs(quadHash) % dims;
          const sign3 = quadHash % 2 === 0 ? 0.75 : -0.75;
          vector[idx3] += sign3;
        }
      }
    }

    // Chuẩn hoá độ dài L2 để chuẩn bị cho Cosine Dot-Product
    return this.normalizeL2(vector);
  }

  private hashString(str: string): number {
    let hash = 2166136261; // FNV-1a 32-bit offset basis
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }

  private normalizeL2(vec: number[]): number[] {
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      sumSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(sumSq);
    if (norm === 0) return vec;
    return vec.map((val) => val / norm);
  }

  private projectDimensions(vec: number[], targetDim: number): number[] {
    if (vec.length === targetDim) return vec;
    const result = new Array<number>(targetDim).fill(0);
    for (let i = 0; i < vec.length; i++) {
      const idx = i % targetDim;
      result[idx] += vec[i];
    }
    return result;
  }

  private async fetchGeminiEmbedding(text: string): Promise<number[] | null> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${this.geminiApiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as any;
    return data.embedding?.values || null;
  }
}

/**
 * VectorMemoryStore - Kho lưu trữ và truy vấn Vector RAG cục bộ
 * Lưu trữ tại `.codingagent/vector-memory.json`
 */
export class VectorMemoryStore {
  private filePath: string;
  private documents = new Map<string, VectorDocument>();
  private embeddingService: EmbeddingService;
  private isLoaded = false;

  constructor(filePath: string, embeddingService?: EmbeddingService) {
    this.filePath = path.resolve(filePath);
    this.embeddingService = embeddingService || new EmbeddingService();
  }

  getEmbeddingService(): EmbeddingService {
    return this.embeddingService;
  }

  async init(): Promise<void> {
    if (this.isLoaded) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed: VectorDocument[] = JSON.parse(raw);
      this.documents.clear();
      for (const doc of parsed) {
        if (doc && doc.id && Array.isArray(doc.vector)) {
          this.documents.set(doc.id, doc);
        }
      }
    } catch {
      // File chưa tồn tại
      this.documents.clear();
    }
    this.isLoaded = true;
  }

  async upsert(id: string, text: string, metadata: Record<string, any> = {}): Promise<VectorDocument> {
    await this.init();
    const now = new Date().toISOString();
    const existing = this.documents.get(id);

    // Tính vector nhúng nếu text thay đổi hoặc chưa có
    let vector: number[];
    if (existing && existing.text === text && existing.vector?.length > 0) {
      vector = existing.vector;
    } else {
      vector = await this.embeddingService.generateEmbedding(text);
    }

    const doc: VectorDocument = {
      id,
      text,
      vector,
      metadata: { ...(existing?.metadata || {}), ...metadata },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this.documents.set(id, doc);
    await this.save();
    return doc;
  }

  async delete(id: string): Promise<boolean> {
    await this.init();
    const existed = this.documents.delete(id);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  get(id: string): VectorDocument | undefined {
    return this.documents.get(id);
  }

  getAll(): VectorDocument[] {
    return Array.from(this.documents.values());
  }

  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    await this.init();
    const queryVector = await this.embeddingService.generateEmbedding(query);
    const limit = options.limit ?? 8;
    const minSimilarity = options.minSimilarity ?? 0.05;

    const results: VectorSearchResult[] = [];

    for (const doc of this.documents.values()) {
      if (options.filter && !options.filter(doc)) {
        continue;
      }
      const similarity = cosineSimilarity(queryVector, doc.vector);
      if (similarity >= minSimilarity) {
        results.push({ document: doc, similarity });
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity || b.document.updatedAt.localeCompare(a.document.updatedAt))
      .slice(0, limit);
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const docsArray = Array.from(this.documents.values());
      await fs.writeFile(this.filePath, JSON.stringify(docsArray, null, 2), 'utf-8');
    } catch (err: any) {
      console.warn(`[VectorMemoryStore] Failed to persist vector store: ${err.message}`);
    }
  }

  get size(): number {
    return this.documents.size;
  }
}
