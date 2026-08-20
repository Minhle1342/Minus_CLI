import MiniSearch, { SearchResult } from 'minisearch';
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

const DEFAULT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.sh', '.yaml', '.yml', '.toml'
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.codingagent', '.next', '.cache', 'coverage', 'out'
]);

/**
 * CodeSearchEngine - Bộ máy tìm kiếm toàn văn mã nguồn cục bộ (BM25 Local Search)
 * Tận dụng MiniSearch để đánh chỉ mục in-memory và tìm kiếm chính xác mà không tốn Token LLM.
 */
export class CodeSearchEngine {
  private workspaceDir: string;
  private miniSearch: MiniSearch<CodeDocument>;
  private indexed = false;
  private fileDocMap = new Map<string, CodeDocument>();

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.miniSearch = new MiniSearch({
      fields: ['path', 'filename', 'symbols', 'content'],
      storeFields: ['path', 'filename', 'extension', 'symbols', 'content'],
      searchOptions: {
        boost: { symbols: 3, filename: 2, path: 1.5, content: 1 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /**
   * Quét và lập chỉ mục toàn bộ các file code trong workspace
   */
  async buildIndex(): Promise<number> {
    this.miniSearch.removeAll();
    this.fileDocMap.clear();

    const docs: CodeDocument[] = [];
    await this.scanDirectory(this.workspaceDir, docs);

    if (docs.length > 0) {
      this.miniSearch.addAll(docs);
      for (const d of docs) {
        this.fileDocMap.set(d.path, d);
      }
    }

    this.indexed = true;
    return docs.length;
  }

  private async scanDirectory(dir: string, docs: CodeDocument[]): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;

      const fullPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await this.scanDirectory(fullPath, docs);
        } else if (stat.isFile()) {
          const ext = path.extname(entry).toLowerCase();
          if (DEFAULT_EXTENSIONS.has(ext) && stat.size < 500 * 1024) {
            // Đọc file < 500KB để đánh index
            const content = await fs.readFile(fullPath, 'utf-8');
            const relativePath = path.relative(this.workspaceDir, fullPath).replace(/\\/g, '/');
            const symbols = this.extractSymbols(content);

            docs.push({
              id: relativePath,
              path: relativePath,
              filename: entry,
              extension: ext,
              symbols,
              content,
            });
          }
        }
      } catch {}
    }
  }

  /**
   * Trích xuất các biểu tượng code cơ bản (Function, Class, Interface, Type, Export, Const)
   */
  private extractSymbols(content: string): string {
    const symbols: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/(?:export\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z0-9_$]+)/);
      if (match && match[1]) {
        symbols.push(match[1]);
      }
    }

    return symbols.join(' ');
  }

  /**
   * Tìm kiếm mã nguồn bằng BM25 & Fuzzy
   */
  async search(query: string, options: { limit?: number; fuzzy?: boolean } = {}): Promise<CodeSearchHit[]> {
    if (!this.indexed) {
      await this.buildIndex();
    }

    const limit = options.limit ?? 10;
    const isFuzzy = options.fuzzy !== false;

    const results = this.miniSearch.search(query, {
      fuzzy: isFuzzy ? 0.2 : false,
      prefix: true,
      boost: { symbols: 3, filename: 2, path: 1.5, content: 1 },
    });

    const hits: CodeSearchHit[] = [];

    for (const res of results.slice(0, limit)) {
      const doc = this.fileDocMap.get(res.id);
      if (!doc) continue;

      const lines = doc.content.split('\n');
      const lowerQuery = query.toLowerCase();
      const lineMatches: Array<{ line: number; text: string }> = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          lineMatches.push({
            line: i + 1,
            text: lines[i].trim(),
          });
          if (lineMatches.length >= 5) break;
        }
      }

      // Tạo snippet tóm tắt từ các dòng khớp hoặc 5 dòng đầu
      let snippet = '';
      if (lineMatches.length > 0) {
        snippet = lineMatches.map((m) => `L${m.line}: ${m.text}`).join('\n');
      } else {
        snippet = lines.slice(0, 4).join('\n');
      }

      hits.push({
        path: doc.path,
        score: Math.round(res.score * 100) / 100,
        matchTerms: res.terms,
        snippet,
        lineMatches,
      });
    }

    return hits;
  }
}
