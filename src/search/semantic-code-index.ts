import fs from 'node:fs/promises';
import path from 'node:path';
import { getNativeCore, type NativeCodeGraph, type NativeGraphEdge } from '../native/index.js';
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
const CHUNK_SCHEMA_VERSION = 'code-chunks-v2-rust-ast';

/** Symbol-level semantic index with incremental embedding reuse and bounded graph expansion. */
export class SemanticCodeIndex {
  private readonly workspaceDir: string;
  private readonly provider: CodeEmbeddingProvider;
  private readonly store: PersistentVectorStore<SemanticCodeChunk>;
  private fileManifest = new Map<string, string>();
  private chunksByPath = new Map<string, SemanticCodeChunk[]>();
  private chunksById = new Map<string, SemanticCodeChunk>();
  private chunksByName = new Map<string, SemanticCodeChunk[]>();
  private outEdges = new Map<string, Array<{ targetId: string; relation: string; weight: number }>>();
  private inEdges = new Map<string, Array<{ sourceId: string; relation: string; weight: number }>>();
  private nativeGraph?: NativeCodeGraph;
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
      if (previous && previous.metadata.sourceHash === chunk.sourceHash && previous.metadata.embeddingText === chunk.embeddingText) {
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
      CHUNK_SCHEMA_VERSION,
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
    this.chunksById.clear();
    this.chunksByName.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.nativeGraph = undefined;

    for (const chunk of chunks) {
      this.chunksById.set(chunk.id, chunk);

      const existing = this.chunksByPath.get(chunk.path) || [];
      existing.push(chunk);
      this.chunksByPath.set(chunk.path, existing);

      const nameList = this.chunksByName.get(chunk.name) || [];
      nameList.push(chunk);
      this.chunksByName.set(chunk.name, nameList);
    }

    // Xây dựng các cạnh đồ thị ngữ nghĩa (Callers, Callees, Types, Inheritance)
    for (const chunk of chunks) {
      const edges = chunk.graphEdges || [];
      for (const edge of edges) {
        const candidates = this.chunksByName.get(edge.target) || [];
        if (candidates.length === 0) continue;

        // Qualified Rust calls must resolve through their named module or local owner.
        let resolved: SemanticCodeChunk | undefined;
        const targetPath = edge.targetPath;
        if (chunk.language === 'rust' && targetPath) {
          resolved = candidates.find((c) => c.path === chunk.path
            && c.qualifiedName.endsWith(`::${targetPath.replaceAll('::', '.')}.${edge.target}`));
          const imports = chunk.imports.filter((imp) => imp === targetPath
            || imp.endsWith(`::${targetPath}`));
          if (/^(?:crate|self|super)::/.test(targetPath)) imports.push(targetPath);
          if (!resolved) resolved = candidates.find((c) => imports.some((imp) =>
            this.resolveImportPath(chunk.path, imp) === c.path));
          if (!resolved) continue;
        }

        // Prefer a local symbol, then a symbol in a referenced file.
        if (!resolved) resolved = candidates.find((c) => c.path === chunk.path);
        if (!resolved && chunk.imports.length > 0) {
          resolved = candidates.find((c) => {
            return chunk.imports.some((imp) => {
              const res = this.resolveImportPath(chunk.path, imp);
              return res === c.path;
            });
          });
        }
        if (!resolved && chunk.language !== 'rust') {
          resolved = candidates[0];
        } else if (!resolved && candidates.length === 1) {
          resolved = candidates[0];
        }

        if (resolved && resolved.id !== chunk.id) {
          const outs = this.outEdges.get(chunk.id) || [];
          if (!outs.some((e) => e.targetId === resolved!.id)) {
            outs.push({ targetId: resolved.id, relation: edge.relation, weight: edge.weight ?? 1.0 });
            this.outEdges.set(chunk.id, outs);
          }
          const ins = this.inEdges.get(resolved.id) || [];
          if (!ins.some((e) => e.sourceId === chunk.id)) {
            ins.push({ sourceId: chunk.id, relation: edge.relation, weight: edge.weight ?? 1.0 });
            this.inEdges.set(resolved.id, ins);
          }
        }
      }
    }

    const constructor = getNativeCore()?.RsCodeGraph;
    if (constructor) {
      try {
        const edges: NativeGraphEdge[] = [];
        for (const [source, outgoing] of this.outEdges) {
          for (const edge of outgoing) edges.push({ source, target: edge.targetId, weight: edge.weight });
        }
        this.nativeGraph = new constructor(chunks.map((chunk) => chunk.id), edges);
      } catch {
        this.nativeGraph = undefined;
      }
    }
  }

  /**
   * Personalized PageRank (PPR) lan truyền xác suất trên Code Property Graph
   */
  computePersonalizedPageRank(
    seeds: Map<string, number>,
    mode: GraphExpansionMode,
    maxIterations = 8,
    dampingFactor = 0.85,
  ): Map<string, number> {
    if (seeds.size === 0) return new Map();

    let totalInitial = 0;
    for (const score of seeds.values()) totalInitial += score;
    const p0 = new Map<string, number>();
    for (const [id, score] of seeds) {
      p0.set(id, totalInitial > 0 ? score / totalInitial : 1 / seeds.size);
    }

    let pCurrent = new Map<string, number>(p0);

    for (let iter = 0; iter < maxIterations; iter++) {
      const pNext = new Map<string, number>();

      for (const [nodeId, score] of pCurrent) {
        if (score <= 0) continue;

        const outList: Array<{ neighborId: string; weight: number }> = [];

        if (mode === 'dependencies' || mode === 'auto') {
          for (const edge of this.outEdges.get(nodeId) || []) {
            outList.push({ neighborId: edge.targetId, weight: edge.weight });
          }
        }

        if (mode === 'impact' || mode === 'auto') {
          for (const edge of this.inEdges.get(nodeId) || []) {
            outList.push({ neighborId: edge.sourceId, weight: edge.weight });
          }
        }

        if (outList.length === 0) {
          pNext.set(nodeId, (pNext.get(nodeId) || 0) + score * (1 - dampingFactor));
          continue;
        }

        let totalWeight = 0;
        for (const out of outList) totalWeight += out.weight;

        for (const out of outList) {
          const transitionProb = totalWeight > 0 ? out.weight / totalWeight : 1 / outList.length;
          const contributed = score * dampingFactor * transitionProb;
          pNext.set(out.neighborId, (pNext.get(out.neighborId) || 0) + contributed);
        }
      }

      for (const [id, restartProb] of p0) {
        pNext.set(id, (pNext.get(id) || 0) + (1 - dampingFactor) * restartProb);
      }

      pCurrent = pNext;
    }

    return pCurrent;
  }

  private expandGraph(seeds: SemanticCodeSearchHit[], mode: GraphExpansionMode): SemanticCodeSearchHit[] {
    const results = [...seeds];
    const seedIds = new Set(seeds.map((s) => s.chunk.id));

    // 1. Chạy Personalized PageRank trên Code Property Graph
    const seedScores = new Map<string, number>();
    for (const seed of seeds) {
      seedScores.set(seed.chunk.id, Math.max(0.1, seed.semanticScore));
    }

    let candidates: Array<[string, number]> | undefined;
    if (process.env.MINUS_DISABLE_NATIVE_GRAPH !== '1' && this.nativeGraph?.personalizedPageRankTop) {
      try {
        const scores = this.nativeGraph.personalizedPageRankTop(
          [...seedScores].map(([id, score]) => ({ id, score })), mode, 6, 0.85, 12,
        );
        if (Array.isArray(scores) && scores.every((item) =>
          this.chunksById.has(item.id) && !seedIds.has(item.id) && Number.isFinite(item.score))) {
          candidates = scores.map((item) => [item.id, item.score]);
        }
      } catch {
        // Preserve TypeScript graph expansion on addon errors.
      }
    }
    candidates ||= Array.from(this.computePersonalizedPageRank(seedScores, mode, 6, 0.85).entries())
      .filter(([id]) => !seedIds.has(id))
      .sort((a, b) => b[1] - a[1]);

    let addedSymbols = 0;
    for (const [id, pprScore] of candidates) {
      const neighbor = this.chunksById.get(id);
      if (!neighbor) continue;

      const seedSource = seeds.find((s) => {
        const outs = this.outEdges.get(s.chunk.id) || [];
        const ins = this.inEdges.get(s.chunk.id) || [];
        return outs.some((e) => e.targetId === id) || ins.some((e) => e.sourceId === id);
      });

      const baseScore = seedSource?.semanticScore ?? seeds[0]?.semanticScore ?? 0.5;
      results.push({
        chunk: neighbor,
        semanticScore: roundScore(baseScore * 0.75),
        graphScore: roundScore(Math.min(0.35, pprScore * 0.5 + 0.15)),
        expandedFrom: seedSource?.chunk.qualifiedName || seeds[0]?.chunk.qualifiedName,
      });

      if (++addedSymbols >= 12) break;
    }

    // 2. Fallback Import Cấp File nếu graph symbols còn ít (bảo đảm 100% backward compatibility)
    if (addedSymbols < 4) {
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
        for (const relatedPath of [...relatedPaths].sort()) {
          const neighbor = this.chunksByPath.get(relatedPath)?.[0];
          if (!neighbor || results.some((r) => r.chunk.id === neighbor.id)) continue;
          results.push({
            chunk: neighbor,
            semanticScore: roundScore(seed.semanticScore * 0.72),
            graphScore: 0.18,
            expandedFrom: seed.chunk.qualifiedName,
          });
          if (++addedSymbols >= 12) break;
        }
      }
    }

    return results;
  }

  /**
   * Truy xuất các láng giềng đồ thị của một symbol (phục vụ Code Intelligence & Blast Radius)
   */
  getSymbolNeighbors(
    symbolNameOrId: string,
    options?: { depth?: number; direction?: 'upstream' | 'downstream' | 'both' },
  ): Array<{ chunk: SemanticCodeChunk; relation: string; depth: number }> {
    const depth = Math.max(1, Math.min(options?.depth ?? 2, 4));
    const direction = options?.direction ?? 'both';

    let startChunk = this.chunksById.get(symbolNameOrId);
    if (!startChunk) {
      const candidates = this.chunksByName.get(symbolNameOrId);
      if (candidates && candidates.length > 0) startChunk = candidates[0];
    }
    if (!startChunk) return [];

    const results: Array<{ chunk: SemanticCodeChunk; relation: string; depth: number }> = [];
    const visited = new Set<string>([startChunk.id]);
    let currentLevel = [startChunk.id];

    for (let d = 1; d <= depth; d++) {
      const nextLevel: string[] = [];

      for (const currentId of currentLevel) {
        if (direction === 'downstream' || direction === 'both') {
          for (const edge of this.outEdges.get(currentId) || []) {
            if (!visited.has(edge.targetId)) {
              visited.add(edge.targetId);
              nextLevel.push(edge.targetId);
              const neighbor = this.chunksById.get(edge.targetId);
              if (neighbor) {
                results.push({ chunk: neighbor, relation: edge.relation, depth: d });
              }
            }
          }
        }

        if (direction === 'upstream' || direction === 'both') {
          for (const edge of this.inEdges.get(currentId) || []) {
            if (!visited.has(edge.sourceId)) {
              visited.add(edge.sourceId);
              nextLevel.push(edge.sourceId);
              const neighbor = this.chunksById.get(edge.sourceId);
              if (neighbor) {
                results.push({ chunk: neighbor, relation: `called_by_${edge.relation}`, depth: d });
              }
            }
          }
        }
      }

      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    return results;
  }

  private resolveImportPath(sourcePath: string, imported: string): string | undefined {
    if (sourcePath.endsWith('.rs') && /^(?:crate|self|super)::/.test(imported)) {
      const marker = '/src/';
      const markerIndex = sourcePath.lastIndexOf(marker);
      if (markerIndex >= 0 || sourcePath.startsWith('src/')) {
        const root = markerIndex >= 0 ? sourcePath.slice(0, markerIndex + marker.length) : 'src/';
        const sourceModule = sourcePath.slice(root.length).replace(/(?:mod\.rs|lib\.rs|main\.rs|\.rs)$/, '');
        const parts = imported.split('::');
        const prefix = parts.shift();
        const base = prefix === 'crate' ? root : path.posix.join(root, sourceModule, prefix === 'super' ? '..' : '.');
        const modulePath = path.posix.normalize(path.posix.join(base, ...parts));
        for (const candidate of [modulePath, `${modulePath}.rs`, `${modulePath}/mod.rs`,
          `${path.posix.dirname(modulePath)}.rs`, `${path.posix.dirname(modulePath)}/mod.rs`]) {
          if (this.chunksByPath.has(candidate)) return candidate;
        }
      }
      return undefined;
    }
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
