import { EmbeddingService } from '../memory/vector-memory.js';

export interface EmbeddingInput {
  id: string;
  text: string;
}

export interface CodeEmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly qualityTier: 'learned-code' | 'learned-general' | 'deterministic-baseline';
  embedDocuments(items: EmbeddingInput[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

export interface OpenAICompatibleEmbeddingOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  dimensions?: number;
  batchSize?: number;
  timeoutMs?: number;
}

/** Offline deterministic fallback. It is deliberately labelled as a baseline, not learned semantics. */
export class DeterministicCodeEmbeddingProvider implements CodeEmbeddingProvider {
  readonly modelId = 'minus-subword-hash-v1';
  readonly dimensions = EmbeddingService.VECTOR_DIMENSIONS;
  readonly qualityTier = 'deterministic-baseline' as const;
  private readonly service = new EmbeddingService({ geminiApiKey: '', openaiApiKey: '' });

  async embedDocuments(items: EmbeddingInput[]): Promise<number[][]> {
    return items.map((item) => this.service.generateLocalSubwordEmbedding(item.text));
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.service.generateLocalSubwordEmbedding(query);
  }
}

/** Provider-neutral adapter for Voyage, OpenAI, Jina and compatible /embeddings endpoints. */
export class OpenAICompatibleCodeEmbeddingProvider implements CodeEmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly qualityTier = 'learned-code' as const;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    if (!options.apiKey.trim()) throw new Error('Embedding API key must not be empty.');
    if (!options.model.trim()) throw new Error('Embedding model must not be empty.');
    this.apiKey = options.apiKey;
    this.baseURL = (options.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.modelId = options.model;
    this.dimensions = options.dimensions ?? 1_024;
    this.batchSize = clamp(options.batchSize ?? 64, 1, 256);
    this.timeoutMs = clamp(options.timeoutMs ?? 30_000, 1_000, 120_000);
  }

  async embedDocuments(items: EmbeddingInput[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < items.length; offset += this.batchSize) {
      const batch = items.slice(offset, offset + this.batchSize);
      vectors.push(...await this.request(batch.map((item) => item.text), 'document'));
    }
    return vectors;
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.request([query], 'query');
    return vector;
  }

  private async request(input: string[], inputType: 'document' | 'query'): Promise<number[][]> {
    const voyageDialect = this.baseURL.includes('voyageai.com');
    const jinaDialect = this.baseURL.includes('jina.ai');
    const body = voyageDialect
      ? { model: this.modelId, input, input_type: inputType, output_dimension: this.dimensions }
      : jinaDialect
        ? { model: this.modelId, input, task: inputType === 'query' ? 'retrieval.query' : 'retrieval.passage', dimensions: this.dimensions }
        : { model: this.modelId, input, dimensions: this.dimensions };
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding API error (${response.status}): ${body.slice(0, 500)}`);
    }
    const parsed = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    const ordered = [...(parsed.data || [])].sort((a, b) => a.index - b.index);
    if (ordered.length !== input.length) {
      throw new Error(`Embedding API returned ${ordered.length} vectors for ${input.length} inputs.`);
    }
    return ordered.map((item) => normalizeVector(item.embedding, this.dimensions));
  }
}

export function createCodeEmbeddingProviderFromEnv(): CodeEmbeddingProvider {
  const apiKey = process.env.MINUS_EMBEDDING_API_KEY?.trim();
  const model = process.env.MINUS_EMBEDDING_MODEL?.trim();
  if (!apiKey || !model) return new DeterministicCodeEmbeddingProvider();
  return new OpenAICompatibleCodeEmbeddingProvider({
    apiKey,
    model,
    baseURL: process.env.MINUS_EMBEDDING_BASE_URL,
    dimensions: parsePositiveInteger(process.env.MINUS_EMBEDDING_DIMENSIONS, 1_024),
    batchSize: parsePositiveInteger(process.env.MINUS_EMBEDDING_BATCH_SIZE, 64),
    timeoutMs: parsePositiveInteger(process.env.MINUS_EMBEDDING_TIMEOUT_MS, 30_000),
  });
}

function normalizeVector(vector: number[], dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding dimension mismatch: expected ${dimensions}, received ${vector?.length ?? 0}.`);
  }
  let magnitudeSquared = 0;
  for (const value of vector) magnitudeSquared += value * value;
  const magnitude = Math.sqrt(magnitudeSquared);
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
