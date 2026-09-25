import MiniSearch from 'minisearch';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface CodeDocument {
  id: string;
  path: string;
  filename: string;
  extension: string;
  symbols: string;
  content: string;
}

export interface CodeSearchHit {
  path: string;
  score: number;
  matchTerms: string[];
  snippet: string;
  lineMatches: Array<{ line: number; text: string }>;
}

export interface CodeSearchDiagnostics {
  indexedFiles: number;
  builtAt?: string;
  warnings: string[];
}

type FileManifest = Map<string, string>;

const DEFAULT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.yaml', '.yml', '.toml',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.codingagent', '.next', '.cache', 'coverage', 'out',
]);

/** In-memory BM25 index with freshness checks and literal-search fallback. */
export class CodeSearchEngine {
  private readonly workspaceDir: string;
  private miniSearch: MiniSearch<CodeDocument>;
  private indexed = false;
  private fileDocMap = new Map<string, CodeDocument>();
  private fileManifest: FileManifest = new Map();
  private buildPromise?: Promise<number>;
  private builtAt?: string;
  private indexWarnings: string[] = [];

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.miniSearch = this.createMiniSearch();
  }

  private createMiniSearch(): MiniSearch<CodeDocument> {
    return new MiniSearch<CodeDocument>({
      fields: ['path', 'filename', 'symbols', 'content'],
      storeFields: ['path', 'filename', 'extension', 'symbols', 'content'],
      searchOptions: {
        boost: { symbols: 3, filename: 2, path: 1.5, content: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /** Build a new index atomically. Concurrent callers share the same build. */
  async buildIndex(): Promise<number> {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this.rebuildIndex();
    try {
      return await this.buildPromise;
    } finally {
      this.buildPromise = undefined;
    }
  }

  private async rebuildIndex(): Promise<number> {
    const docs: CodeDocument[] = [];
    const manifest: FileManifest = new Map();
    const warnings: string[] = [];
    await this.scanDirectory(this.workspaceDir, docs, manifest, warnings, true);

    // Never expose a cleared/partially populated index to another search.
    const nextMiniSearch = this.createMiniSearch();
    const nextFileDocMap = new Map<string, CodeDocument>();
    if (docs.length > 0) {
      nextMiniSearch.addAll(docs);
      for (const document of docs) nextFileDocMap.set(document.path, document);
    }

    this.miniSearch = nextMiniSearch;
    this.fileDocMap = nextFileDocMap;
    this.fileManifest = manifest;
    this.indexWarnings = warnings;
    this.builtAt = new Date().toISOString();
    this.indexed = true;
    return docs.length;
  }

  private async scanDirectory(
    dir: string,
    docs: CodeDocument[],
    manifest: FileManifest,
    warnings: string[],
    isRoot = false,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
      entries.sort((left, right) => left.localeCompare(right));
    } catch (error: any) {
      if (isRoot) {
        throw new Error(`Cannot read code-search workspace "${this.workspaceDir}": ${error.message}`);
      }
      warnings.push(`Cannot scan directory ${this.relativePath(dir)}: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await this.scanDirectory(fullPath, docs, manifest, warnings);
          continue;
        }
        const extension = path.extname(entry).toLowerCase();
        if (!stat.isFile() || !DEFAULT_EXTENSIONS.has(extension) || stat.size >= 500 * 1024) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const relativePath = this.relativePath(fullPath);
        manifest.set(relativePath, this.manifestValue(stat.size, stat.mtimeMs, stat.ctimeMs));
        docs.push({
          id: relativePath,
          path: relativePath,
          filename: entry,
          extension,
          symbols: this.extractSymbols(content),
          content,
        });
      } catch (error: any) {
        warnings.push(`Cannot index ${this.relativePath(fullPath)}: ${error.message}`);
      }
    }
  }

  /** Collect cheap size/mtime fingerprints so a long-lived engine cannot go stale. */
  private async collectManifest(
    dir: string,
    manifest: FileManifest,
    warnings: string[],
    isRoot = false,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
      entries.sort((left, right) => left.localeCompare(right));
    } catch (error: any) {
      if (isRoot) {
        throw new Error(`Cannot read code-search workspace "${this.workspaceDir}": ${error.message}`);
      }
      warnings.push(`Cannot scan directory ${this.relativePath(dir)}: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await this.collectManifest(fullPath, manifest, warnings);
          continue;
        }
        const extension = path.extname(entry).toLowerCase();
        if (stat.isFile() && DEFAULT_EXTENSIONS.has(extension) && stat.size < 500 * 1024) {
          manifest.set(this.relativePath(fullPath), this.manifestValue(stat.size, stat.mtimeMs, stat.ctimeMs));
        }
      } catch (error: any) {
        warnings.push(`Cannot inspect ${this.relativePath(fullPath)}: ${error.message}`);
      }
    }
  }

  private relativePath(target: string): string {
    return path.relative(this.workspaceDir, target).replace(/\\/g, '/') || '.';
  }

  private manifestValue(size: number, mtimeMs: number, ctimeMs: number): string {
    return `${size}:${mtimeMs}:${ctimeMs}`;
  }

  private manifestsEqual(left: FileManifest, right: FileManifest): boolean {
    if (left.size !== right.size) return false;
    for (const [filePath, fingerprint] of left) {
      if (right.get(filePath) !== fingerprint) return false;
    }
    return true;
  }

  private async ensureFreshIndex(): Promise<void> {
    if (!this.indexed) {
      await this.buildIndex();
      return;
    }

    const currentManifest: FileManifest = new Map();
    const warnings: string[] = [];
    await this.collectManifest(this.workspaceDir, currentManifest, warnings, true);
    if (!this.manifestsEqual(this.fileManifest, currentManifest)) {
      await this.buildIndex();
      return;
    }
    this.indexWarnings = warnings;
  }

  private extractSymbols(content: string): string {
    const symbols: string[] = [];
    for (const line of content.split('\n')) {
      const match = line.match(/(?:export\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z0-9_$]+)/);
      if (match?.[1]) symbols.push(match[1]);
    }
    return symbols.join(' ');
  }

  async search(query: string, options: { limit?: number; fuzzy?: boolean } = {}): Promise<CodeSearchHit[]> {
    await this.ensureFreshIndex();

    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const requestedLimit = options.limit ?? 10;
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 10;
    const results = this.miniSearch.search(normalizedQuery, {
      fuzzy: options.fuzzy !== false ? 0.2 : false,
      prefix: true,
      boost: { symbols: 3, filename: 2, path: 1.5, content: 1 },
    });

    const hits: CodeSearchHit[] = [];
    for (const result of results) {
      const document = this.fileDocMap.get(String(result.id));
      if (!document) continue;
      hits.push(this.toHit(
        document,
        normalizedQuery,
        Math.round(result.score * 100) / 100,
        result.terms,
      ));
      if (hits.length >= limit) break;
    }

    // A literal occurrence is authoritative even if tokenization/BM25 misses it.
    if (hits.length === 0) {
      const lowerQuery = normalizedQuery.toLowerCase();
      const documents = [...this.fileDocMap.values()].sort((left, right) => left.path.localeCompare(right.path));
      for (const document of documents) {
        const searchable = `${document.path}\n${document.filename}\n${document.symbols}\n${document.content}`.toLowerCase();
        if (!searchable.includes(lowerQuery)) continue;
        hits.push(this.toHit(document, normalizedQuery, 0.01, [normalizedQuery]));
        if (hits.length >= limit) break;
      }
    }

    if (hits.length === 0 && this.indexWarnings.length > 0) {
      throw new Error(
        `Code-search index is incomplete, so absence cannot be verified: ${this.indexWarnings.slice(0, 3).join('; ')}`,
      );
    }
    return hits;
  }

  getDiagnostics(): CodeSearchDiagnostics {
    return {
      indexedFiles: this.fileDocMap.size,
      ...(this.builtAt ? { builtAt: this.builtAt } : {}),
      warnings: [...this.indexWarnings],
    };
  }

  private toHit(document: CodeDocument, query: string, score: number, matchTerms: string[]): CodeSearchHit {
    const lines = document.content.split('\n');
    const lowerQuery = query.toLowerCase();
    const lineMatches: Array<{ line: number; text: string }> = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].toLowerCase().includes(lowerQuery)) continue;
      lineMatches.push({ line: index + 1, text: lines[index].trim() });
      if (lineMatches.length >= 5) break;
    }
    return {
      path: document.path,
      score,
      matchTerms,
      snippet: lineMatches.length > 0
        ? lineMatches.map((match) => `L${match.line}: ${match.text}`).join('\n')
        : lines.slice(0, 4).join('\n'),
      lineMatches,
    };
  }
}
