import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createCodeEmbeddingProviderFromEnv,
  type CodeEmbeddingProvider,
  type EmbeddingInput,
} from './embedding-provider.js';
import { chunkCodeFile, sha256, type SemanticCodeChunk } from './semantic-chunker.js';
import { PersistentVectorStore, type VectorStoreRecord } from './vector-store.js';

export type GraphExpansionMode = 'none' | 'dependencies' | 'impact' | 'auto';

export interface SemanticSearchOptions {
  limit?: number;
  minSimilarity?: number;
  graphExpansion?: GraphExpansionMode;
}

export interface SemanticCodeSearchHit {
  chunk: SemanticCodeChunk;
  semanticScore: number;
  graphScore: number;
  expandedFrom?: string;
}

export interface SemanticCodeIndexDiagnostics {
  status: 'cold' | 'ready' | 'warming' | 'error';
  indexedFiles: number;
  indexedChunks: number;
  builtAt?: string;
  indexRevision?: string;
  modelId: string;
  qualityTier: CodeEmbeddingProvider['qualityTier'];
  backend: 'hnsw' | 'exact';
  warnings: string[];
}

interface IndexedFile {
  relativePath: string;
  content: string;
  fingerprint: string;
}

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.rb', '.sh', '.yaml', '.yml', '.toml', '.json', '.md',
]);

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', '.codingagent', '.minus', '.next', '.cache', 'coverage', 'out',
]);

/** Symbol-level semantic index with incremental embedding reuse and bounded graph expansion. */
export class SemanticCodeIndex {
  private readonly workspaceDir: string;
  private readonly provider: CodeEmbeddingProvider;
  private readonly store: PersistentVectorStore<SemanticCodeChunk>;
  private fileManifest = new Map<string, string>();
  private chunksByPath = new Map<string, SemanticCodeChunk[]>();
  private buildPromise?: Promise<number>;
  private status: SemanticCodeIndexDiagnostics['status'] = 'cold';
  private builtAt?: string;
  private indexRevision?: string;
  private warnings: string[] = [];

  constructor(workspaceDir: string, provider: CodeEmbeddingProvider = createCodeEmbeddingProviderFromEnv()) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.provider = provider;
    this.store = new PersistentVectorStore<SemanticCodeChunk>(
      path.join(this.workspaceDir, '.codingagent', 'code-index'),
      provider.dimensions,
    );
  }

  async buildIndex(): Promise<number> {
    if (this.buildPromise) return this.buildPromise;
    this.status = 'warming';
    this.buildPromise = this.rebuildIndex();
    try {
      return await this.buildPromise;
    } catch (error: any) {
      this.status = 'error';
      this.warnings.push(error.message);
      throw error;
    } finally {
      this.buildPromise = undefined;
    }
  }

  async search(query: string, options: SemanticSearchOptions = {}): Promise<SemanticCodeSearchHit[]> {
    await this.ensureFreshIndex();
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const requestedLimit = clamp(options.limit ?? 10, 1, 100);
    const queryVector = await this.provider.embedQuery(normalizedQuery);
    const vectorHits = await this.store.search(
      queryVector,
      Math.max(requestedLimit * 3, 24),
      options.minSimilarity ?? 0.05,
    );
    const seeds: SemanticCodeSearchHit[] = vectorHits.map((hit) => ({
      chunk: hit.metadata,
      semanticScore: roundScore(hit.similarity),
      graphScore: 0,
    }));
    const expansionMode = options.graphExpansion ?? 'none';
    const expanded = expansionMode === 'none'
      ? seeds
      : this.expandGraph(seeds.slice(0, Math.min(8, requestedLimit)), expansionMode);
    return deduplicateHits(expanded)
      .sort((left, right) => combinedScore(right) - combinedScore(left)
        || left.chunk.qualifiedName.localeCompare(right.chunk.qualifiedName))
      .slice(0, requestedLimit);
  }

  getDiagnostics(): SemanticCodeIndexDiagnostics {
    const vector = this.store.getDiagnostics();
    return {
      status: this.status,
      indexedFiles: this.fileManifest.size,
      indexedChunks: vector.size,
      ...(this.builtAt ? { builtAt: this.builtAt } : {}),
      ...(this.indexRevision ? { indexRevision: this.indexRevision } : {}),
      modelId: this.provider.modelId,
      qualityTier: this.provider.qualityTier,
      backend: vector.backend,
      warnings: [...new Set([...this.warnings, ...vector.warnings])],
    };
  }

  private async rebuildIndex(): Promise<number> {
    await this.store.load(this.provider.modelId);
    const files = await this.scanWorkspace();
    const manifest = new Map(files.map((file) => [file.relativePath, file.fingerprint]));
    const chunks = files.flatMap((file) => chunkCodeFile(file.relativePath, file.content));
    const existing = new Map(this.store.getRecords().map((record) => [record.id, record]));
    const vectorsById = new Map<string, number[]>();
    const missing: EmbeddingInput[] = [];
    for (const chunk of chunks) {
      const previous = existing.get(chunk.id);
      if (previous && previous.metadata.sourceHash === chunk.sourceHash) {
        vectorsById.set(chunk.id, previous.vector);
      } else {
        missing.push({ id: chunk.id, text: chunk.embeddingText });
      }
    }
    if (missing.length > 0) {
      const vectors = await this.provider.embedDocuments(missing);
      if (vectors.length !== missing.length) {
        throw new Error(`Embedding provider returned ${vectors.length} vectors for ${missing.length} chunks.`);
      }
      missing.forEach((item, index) => vectorsById.set(item.id, vectors[index]));
    }
    const revisionMaterial = [
      this.provider.modelId,
      ...[...manifest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`),
    ].join('\n');
    const indexRevision = sha256(revisionMaterial);
    const records: VectorStoreRecord<SemanticCodeChunk>[] = chunks.map((chunk) => ({
      id: chunk.id,
      vector: vectorsById.get(chunk.id) || existing.get(chunk.id)?.vector || [],
      metadata: chunk,
    }));
    await this.store.replaceAll(records, this.provider.modelId, indexRevision);
    this.fileManifest = manifest;
    this.indexRevision = indexRevision;
    this.builtAt = new Date().toISOString();
    this.status = 'ready';
    this.warnings = [];
    this.rebuildPathMap(chunks);
    return chunks.length;
  }

  private async ensureFreshIndex(): Promise<void> {
    if (this.status === 'cold' || this.status === 'error') {
      await this.buildIndex();
      return;
    }
    const files = await this.scanWorkspace(false);
    const current = new Map(files.map((file) => [file.relativePath, file.fingerprint]));
    if (!manifestsEqual(this.fileManifest, current)) await this.buildIndex();
  }

  private async scanWorkspace(readContent = true): Promise<IndexedFile[]> {
    const files: IndexedFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const stat = await fs.stat(absolutePath);
        if (stat.size >= 500 * 1024) continue;
        const relativePath = path.relative(this.workspaceDir, absolutePath).replace(/\\/g, '/');
        files.push({
          relativePath,
          content: readContent ? await fs.readFile(absolutePath, 'utf8') : '',
          fingerprint: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
        });
      }
    };
    await visit(this.workspaceDir);
    return files;
  }

  private rebuildPathMap(chunks: SemanticCodeChunk[]): void {
    this.chunksByPath.clear();
    for (const chunk of chunks) {
      const existing = this.chunksByPath.get(chunk.path) || [];
      existing.push(chunk);
      this.chunksByPath.set(chunk.path, existing);
    }
  }

  private expandGraph(seeds: SemanticCodeSearchHit[], mode: GraphExpansionMode): SemanticCodeSearchHit[] {
    const results = [...seeds];
    const reverseImports = new Map<string, Set<string>>();
    for (const [sourcePath, chunks] of this.chunksByPath) {
      for (const imported of chunks[0]?.imports || []) {
        const targetPath = this.resolveImportPath(sourcePath, imported);
        if (!targetPath) continue;
        const sources = reverseImports.get(targetPath) || new Set<string>();
        sources.add(sourcePath);
        reverseImports.set(targetPath, sources);
      }
    }

    for (const seed of seeds) {
      const relatedPaths = new Set<string>();
      if (mode === 'dependencies' || mode === 'auto') {
        for (const imported of seed.chunk.imports) {
          const resolved = this.resolveImportPath(seed.chunk.path, imported);
          if (resolved) relatedPaths.add(resolved);
        }
      }
      if (mode === 'impact' || mode === 'auto') {
        for (const importer of reverseImports.get(seed.chunk.path) || []) relatedPaths.add(importer);
      }
      let added = 0;
      for (const relatedPath of [...relatedPaths].sort()) {
        const neighbor = this.chunksByPath.get(relatedPath)?.[0];
        if (!neighbor) continue;
        results.push({
          chunk: neighbor,
          semanticScore: roundScore(seed.semanticScore * 0.72),
          graphScore: 0.18,
          expandedFrom: seed.chunk.qualifiedName,
        });
        if (++added >= 12) break;
      }
    }
    return results;
  }

  private resolveImportPath(sourcePath: string, imported: string): string | undefined {
    if (!imported.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), imported));
    const candidates = [
      base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.py`,
      `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
    ];
    return candidates.find((candidate) => this.chunksByPath.has(candidate));
  }
}

function deduplicateHits(hits: SemanticCodeSearchHit[]): SemanticCodeSearchHit[] {
  const best = new Map<string, SemanticCodeSearchHit>();
  for (const hit of hits) {
    const previous = best.get(hit.chunk.sourceHash);
    if (!previous || combinedScore(hit) > combinedScore(previous)) best.set(hit.chunk.sourceHash, hit);
  }
  return [...best.values()];
}

function combinedScore(hit: SemanticCodeSearchHit): number {
  return hit.semanticScore + hit.graphScore;
}

function manifestsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [filePath, fingerprint] of left) {
    if (right.get(filePath) !== fingerprint) return false;
  }
  return true;
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
