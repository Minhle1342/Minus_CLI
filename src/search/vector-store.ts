import fs from 'node:fs/promises';
import path from 'node:path';
import { cosineSimilarity } from '../memory/vector-memory.js';
import { writeFileAtomically } from '../memory/atomic-write.js';
import { sha256 } from './semantic-chunker.js';

export interface VectorStoreRecord<TMetadata extends object = Record<string, unknown>> {
  id: string;
  vector: number[];
  metadata: TMetadata;
}

export interface VectorStoreHit<TMetadata extends object = Record<string, unknown>> {
  id: string;
  similarity: number;
  metadata: TMetadata;
}

export interface VectorStoreDiagnostics {
  backend: 'hnsw' | 'exact';
  size: number;
  dimensions: number;
  modelId?: string;
  indexRevision?: string;
  warnings: string[];
}

interface PersistedManifest<TMetadata extends object> {
  version: 1;
  dimensions: number;
  modelId: string;
  indexRevision: string;
  hnswFile?: string;
  records: Array<VectorStoreRecord<TMetadata> & { label: number }>;
}

interface HnswSearchResult {
  distances: number[];
  neighbors: number[];
}

interface HnswIndex {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number, allowReplaceDeleted?: boolean): void;
  addPoint(point: number[], label: number): void;
  setEf(ef: number): void;
  searchKnn(point: number[], limit: number): HnswSearchResult;
  readIndex(filePath: string, allowReplaceDeleted?: boolean): Promise<boolean>;
  writeIndex(filePath: string): Promise<boolean>;
}

type HnswConstructor = new (space: 'cosine', dimensions: number) => HnswIndex;

/** Persistent HNSW store with a metadata-backed exact fallback. */
export class PersistentVectorStore<TMetadata extends object = Record<string, unknown>> {
  private readonly directory: string;
  private readonly manifestPath: string;
  private readonly dimensions: number;
  private records: Array<VectorStoreRecord<TMetadata> & { label: number }> = [];
  private byLabel = new Map<number, VectorStoreRecord<TMetadata> & { label: number }>();
  private index?: HnswIndex;
  private backend: 'hnsw' | 'exact' = 'exact';
  private modelId?: string;
  private indexRevision?: string;
  private warnings: string[] = [];
  private loaded = false;

  constructor(directory: string, dimensions: number) {
    this.directory = path.resolve(directory);
    this.manifestPath = path.join(this.directory, `vectors-${dimensions}.json`);
    this.dimensions = dimensions;
  }

  async load(expectedModelId?: string): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')) as PersistedManifest<TMetadata>;
      if (manifest.version !== 1 || manifest.dimensions !== this.dimensions) {
        this.warnings.push('Vector manifest schema or dimensions changed; a rebuild is required.');
        return;
      }
      if (expectedModelId && manifest.modelId !== expectedModelId) {
        this.warnings.push(`Embedding model changed from ${manifest.modelId} to ${expectedModelId}; a rebuild is required.`);
        return;
      }
      this.records = manifest.records.filter((record) => this.isValidRecord(record));
      this.rebuildLabelMap();
      this.modelId = manifest.modelId;
      this.indexRevision = manifest.indexRevision;
      if (manifest.hnswFile) {
        await this.tryLoadHnsw(path.join(this.directory, manifest.hnswFile));
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') this.warnings.push(`Cannot load vector manifest: ${error.message}`);
    }
  }

  async replaceAll(records: VectorStoreRecord<TMetadata>[], modelId: string, indexRevision: string): Promise<void> {
    for (const record of records) {
      if (!this.isValidRecord(record)) {
        throw new Error(`Invalid vector record ${record.id}: expected ${this.dimensions} finite dimensions.`);
      }
    }
    this.records = records.map((record, label) => ({ ...record, label }));
    this.rebuildLabelMap();
    this.modelId = modelId;
    this.indexRevision = indexRevision;
    this.loaded = true;
    await fs.mkdir(this.directory, { recursive: true });

    const hnswFile = await this.tryBuildHnsw(indexRevision);
    const manifest: PersistedManifest<TMetadata> = {
      version: 1,
      dimensions: this.dimensions,
      modelId,
      indexRevision,
      ...(hnswFile ? { hnswFile } : {}),
      records: this.records,
    };
    await writeFileAtomically(this.manifestPath, JSON.stringify(manifest));
  }

  async search(vector: number[], limit = 10, minSimilarity = 0): Promise<VectorStoreHit<TMetadata>[]> {
    await this.load(this.modelId);
    if (vector.length !== this.dimensions) {
      throw new Error(`Query vector dimension mismatch: expected ${this.dimensions}, received ${vector.length}.`);
    }
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), this.records.length || 1));
    if (this.index && this.records.length > 0) {
      try {
        const result = this.index.searchKnn(vector, boundedLimit);
        return result.neighbors.map((label, index) => {
          const record = this.byLabel.get(label);
          if (!record) return undefined;
          const similarity = Math.max(-1, Math.min(1, 1 - result.distances[index]));
          return similarity >= minSimilarity
            ? { id: record.id, similarity, metadata: record.metadata }
            : undefined;
        }).filter((hit): hit is VectorStoreHit<TMetadata> => Boolean(hit));
      } catch (error: any) {
        this.warnings.push(`HNSW query failed; using exact fallback: ${error.message}`);
        this.index = undefined;
        this.backend = 'exact';
      }
    }
    return this.records
      .map((record) => ({
        id: record.id,
        similarity: cosineSimilarity(vector, record.vector),
        metadata: record.metadata,
      }))
      .filter((hit) => hit.similarity >= minSimilarity)
      .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
      .slice(0, boundedLimit);
  }

  getRecords(): VectorStoreRecord<TMetadata>[] {
    return this.records.map(({ label: _label, ...record }) => record);
  }

  getDiagnostics(): VectorStoreDiagnostics {
    return {
      backend: this.backend,
      size: this.records.length,
      dimensions: this.dimensions,
      ...(this.modelId ? { modelId: this.modelId } : {}),
      ...(this.indexRevision ? { indexRevision: this.indexRevision } : {}),
      warnings: [...new Set(this.warnings)],
    };
  }

  private async tryBuildHnsw(indexRevision: string): Promise<string | undefined> {
    this.index = undefined;
    this.backend = 'exact';
    if (this.records.length === 0) return undefined;
    try {
      const Constructor = await loadHnswConstructor();
      if (!Constructor) {
        this.warnings.push('Optional hnswlib-node backend is unavailable; using exact vector search.');
        return undefined;
      }
      const index = new Constructor('cosine', this.dimensions);
      index.initIndex(Math.max(16, this.records.length), 16, 200, 100, false);
      index.setEf(Math.min(128, Math.max(32, this.records.length)));
      for (const record of this.records) index.addPoint(record.vector, record.label);
      const fileName = `hnsw-${sha256(`${this.dimensions}:${indexRevision}`).slice(0, 20)}.bin`;
      await index.writeIndex(path.join(this.directory, fileName));
      this.index = index;
      this.backend = 'hnsw';
      return fileName;
    } catch (error: any) {
      this.warnings.push(`Cannot build HNSW index; using exact vector search: ${error.message}`);
      return undefined;
    }
  }

  private async tryLoadHnsw(filePath: string): Promise<void> {
    try {
      const Constructor = await loadHnswConstructor();
      if (!Constructor) return;
      const index = new Constructor('cosine', this.dimensions);
      await index.readIndex(filePath, false);
      index.setEf(Math.min(128, Math.max(32, this.records.length)));
      this.index = index;
      this.backend = 'hnsw';
    } catch (error: any) {
      this.warnings.push(`Cannot load HNSW index; using exact vector search: ${error.message}`);
    }
  }

  private isValidRecord(record: VectorStoreRecord<TMetadata>): boolean {
    return Boolean(record?.id)
      && Array.isArray(record.vector)
      && record.vector.length === this.dimensions
      && record.vector.every(Number.isFinite)
      && Boolean(record.metadata);
  }

  private rebuildLabelMap(): void {
    this.byLabel = new Map(this.records.map((record) => [record.label, record]));
  }
}

let cachedHnswConstructor: HnswConstructor | null | undefined;

async function loadHnswConstructor(): Promise<HnswConstructor | null> {
  if (cachedHnswConstructor !== undefined) return cachedHnswConstructor;
  try {
    const imported = await import('hnswlib-node');
    const moduleValue = (imported.default || imported) as unknown as { HierarchicalNSW?: HnswConstructor };
    cachedHnswConstructor = moduleValue.HierarchicalNSW || null;
  } catch {
    cachedHnswConstructor = null;
  }
  return cachedHnswConstructor;
}
