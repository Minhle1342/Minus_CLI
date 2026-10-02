import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from './workspace.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';

export interface WorkspaceEntryInfo {
  relativePath: string;
  displayPath: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  lineCount?: number;
}

export interface FileMentionSuggestion {
  displayPath: string;
  fullPath: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  lineCount?: number;
  matchedBy: 'exact' | 'prefix' | 'contains' | 'fuzzy';
  score: number;
  mentionPrefix: string;
  mentionStart: number;
  mentionEnd: number;
}

export interface AttachedItemSummary {
  path: string;
  type: 'file' | 'directory';
  sizeBytes: number;
  lineCount?: number;
  fileCount?: number;
  preview?: string;
}

export type RelatedFileReason = 'import' | 'imported-by' | 'same-dir' | 'dir-top-ranked';

export interface RelatedFileInfo {
  path: string;
  hop: 1 | 2;
  reason: RelatedFileReason;
  via?: string;
}

export interface AttachmentResult {
  originalPrompt: string;
  expandedPrompt: string;
  attachments: AttachedItemSummary[];
  hasAttachments: boolean;
  skippedAttachments?: Array<{ path: string; reason: 'attachment_limit' | 'source_byte_limit' | 'context_token_limit' }>;
  /** User @-attached files (anchors). Set even when neighborhood expansion is disabled. */
  anchorPaths?: string[];
  /** 2-hop neighborhood around anchors. Only set when MINUS_ATTACH_EXPAND=on (default). */
  relatedFiles?: RelatedFileInfo[];
  expansionEnabled?: boolean;
}

/**
 * FileMentionEngine - Động cơ tìm kiếm & gợi ý File / Thư mục Real-time theo chuẩn Codex CLI
 */
export class FileMentionEngine {
  private static cache: Map<string, { entries: WorkspaceEntryInfo[]; timestamp: number }> = new Map();
  private static readonly CACHE_TTL_MS = 3000; // 3 giây tự động invalidate cache

  /**
   * Quét và lập danh mục toàn bộ file và thư mục trong Workspace (bỏ qua ignored directories)
   * Sử dụng BFS (Breadth-First Search) để đảm bảo các file/thư mục ở tầng nông (root, src,...) luôn được ưu tiên bắt trọn trước
   */
  static listWorkspaceEntries(workspace: Workspace, maxDepth = 12, maxEntries = 10000): WorkspaceEntryInfo[] {
    const rootDir = workspace.rootDir;
    const cached = this.cache.get(rootDir);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.entries;
    }

    const results: WorkspaceEntryInfo[] = [];
    const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: rootDir, depth: 0 }];

    while (queue.length > 0 && results.length < maxEntries) {
      const { dirPath: currentDir, depth } = queue.shift()!;
      if (depth > maxDepth) continue;

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const dirItems: fs.Dirent[] = [];
      const fileItems: fs.Dirent[] = [];

      for (const item of items) {
        if (item.isDirectory()) {
          if (!workspace.isIgnoredDirectory(item.name)) {
            dirItems.push(item);
          }
        } else if (item.isFile()) {
          fileItems.push(item);
        }
      }

      dirItems.sort((a, b) => a.name.localeCompare(b.name));
      fileItems.sort((a, b) => a.name.localeCompare(b.name));

      for (const item of dirItems) {
        if (results.length >= maxEntries) break;
        const fullPath = path.join(currentDir, item.name);
        const relPath = workspace.toRelativePath(fullPath);

        results.push({
          relativePath: relPath,
          displayPath: `${relPath}/`,
          type: 'directory',
          sizeBytes: 0,
        });

        if (depth + 1 <= maxDepth) {
          queue.push({ dirPath: fullPath, depth: depth + 1 });
        }
      }

      for (const item of fileItems) {
        if (results.length >= maxEntries) break;
        const fullPath = path.join(currentDir, item.name);
        const relPath = workspace.toRelativePath(fullPath);

        let sizeBytes = 0;
        try {
          const stat = fs.statSync(fullPath);
          sizeBytes = stat.size;
        } catch {}

        results.push({
          relativePath: relPath,
          displayPath: relPath,
          type: 'file',
          sizeBytes,
        });
      }
    }

    this.cache.set(rootDir, { entries: results, timestamp: now });
    return results;
  }

  /**
   * Trích xuất token mention (@path) đang được gõ tại vị trí con trỏ
   * Hỗ trợ đường dẫn có khoảng trắng nếu bao trong ngoặc kép @"path with spaces"
   * Hỗ trợ Unicode (Tiếng Việt), Next.js route symbols (), [], @, +, #,...
   */
  static extractActiveMention(line: string, cursorColumn = line.length): { query: string; start: number; end: number } | null {
    const textBeforeCursor = line.slice(0, cursorColumn);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex === -1) return null;

    // Kiểm tra ký tự trước '@' (phải là đầu dòng hoặc khoảng trắng hoặc dấu mở ngoặc hoặc dấu nháy)
    if (atIndex > 0 && !/[\s(=,;:[{"'`]/.test(textBeforeCursor[atIndex - 1])) {
      return null;
    }

    const rawQuery = textBeforeCursor.slice(atIndex + 1);

    // Nếu query bắt đầu bằng dấu ngoặc kép @"...", bóc tách tới con trỏ
    if (rawQuery.startsWith('"') || rawQuery.startsWith("'")) {
      const quoteChar = rawQuery[0];
      const queryInside = rawQuery.slice(1);
      if (queryInside.includes(quoteChar)) {
        return null;
      }
      return {
        query: queryInside,
        start: atIndex,
        end: cursorColumn,
      };
    }

    // Nếu không có dấu ngoặc kép, không cho phép khoảng trắng trong query
    if (/\s/.test(rawQuery)) {
      return null;
    }

    return {
      query: rawQuery,
      start: atIndex,
      end: cursorColumn,
    };
  }

  /**
   * Tìm kiếm gợi ý File / Thư mục theo thời gian thực khi người dùng gõ `@<query>`
   */
  static getFileSuggestions(
    line: string,
    workspace: Workspace,
    cursorColumn = line.length,
    limit = 6,
  ): FileMentionSuggestion[] {
    const mention = this.extractActiveMention(line, cursorColumn);
    if (!mention) return [];

    let rawQuery = mention.query.toLowerCase().replace(/\\/g, '/');
    if (rawQuery.startsWith('./')) {
      rawQuery = rawQuery.slice(2);
    }

    const entries = this.listWorkspaceEntries(workspace);

    if (rawQuery === '') {
      // Khi vừa gõ '@', cân bằng gợi ý: ưu tiên các thư mục và file cấp cao nhất (root)
      const topDirectories = entries.filter((e) => e.type === 'directory' && !e.relativePath.includes('/')).slice(0, Math.ceil(limit / 2));
      const topFiles = entries.filter((e) => e.type === 'file' && !e.relativePath.includes('/')).slice(0, limit - topDirectories.length);
      const balanced = [...topDirectories, ...topFiles];
      const fallbackList = balanced.length > 0 ? balanced : entries.slice(0, limit);

      return fallbackList.map((e, idx) => ({
        displayPath: e.displayPath,
        fullPath: e.relativePath,
        type: e.type,
        sizeBytes: e.sizeBytes,
        lineCount: e.lineCount,
        matchedBy: 'prefix',
        score: idx,
        mentionPrefix: `@${mention.query}`,
        mentionStart: mention.start,
        mentionEnd: mention.end,
      }));
    }

    const isFolderQuery = rawQuery.endsWith('/');
    const trimmedQuery = isFolderQuery ? rawQuery.slice(0, -1) : rawQuery;

    const matched: FileMentionSuggestion[] = [];

    for (const entry of entries) {
      const target = entry.relativePath.toLowerCase();
      const baseName = path.basename(entry.relativePath).toLowerCase();

      let matchedBy: 'exact' | 'prefix' | 'contains' | 'fuzzy' | null = null;
      let score = 100;

      if (isFolderQuery) {
        if (target.startsWith(rawQuery)) {
          matchedBy = 'prefix';
          const subPath = target.slice(rawQuery.length);
          const depthPenalty = (subPath.match(/\//g) || []).length * 10;
          score = 5 + depthPenalty + subPath.length;
        } else if (target === trimmedQuery) {
          matchedBy = 'exact';
          score = 0;
        }
      } else {
        if (target === rawQuery || baseName === rawQuery) {
          matchedBy = 'exact';
          score = 0;
        } else if (target.startsWith(rawQuery) || baseName.startsWith(rawQuery)) {
          matchedBy = 'prefix';
          score = 10 + target.length - rawQuery.length;
        } else if (target.includes(rawQuery) || baseName.includes(rawQuery)) {
          matchedBy = 'contains';
          score = 30 + target.indexOf(rawQuery);
        } else if (rawQuery.length >= 3) {
          const dist = this.levenshtein(rawQuery, baseName.slice(0, rawQuery.length + 2));
          if (dist <= 2) {
            matchedBy = 'fuzzy';
            score = 50 + dist * 5;
          }
        }
      }

      if (matchedBy) {
        matched.push({
          displayPath: entry.displayPath,
          fullPath: entry.relativePath,
          type: entry.type,
          sizeBytes: entry.sizeBytes,
          lineCount: entry.lineCount,
          matchedBy,
          score,
          mentionPrefix: `@${mention.query}`,
          mentionStart: mention.start,
          mentionEnd: mention.end,
        });
      }
    }

    matched.sort((a, b) => a.score - b.score);
    return matched.slice(0, limit);
  }

  /**
   * Hỗ trợ Tab-completion cho readline khi người dùng gõ @path
   * Bảo toàn phần văn bản phía sau con trỏ (không nuốt mất text sau Tab)
   */
  static completeMention(line: string, workspace: Workspace, cursorColumn = line.length): [string[], string] {
    const mention = this.extractActiveMention(line, cursorColumn);
    if (!mention) return [[], line];

    const suggestions = this.getFileSuggestions(line, workspace, cursorColumn, 10);
    if (suggestions.length === 0) return [[], line];

    const prefixBeforeAt = line.slice(0, mention.start);
    const suffixAfterMention = line.slice(mention.end);

    const completions = suggestions.map((s) => {
      const formattedPath = s.displayPath.includes(' ') ? `"${s.displayPath}"` : s.displayPath;
      return `${prefixBeforeAt}@${formattedPath}${suffixAfterMention}`;
    });

    return [completions.slice(0, 1), line];
  }

  private static levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }
}

/**
 * Attachment neighborhood budgets (2-hop investigation scope).
 * Related files are rendered as signature outlines only, never full content,
 * so the neighborhood stays within ~2k tokens on top of anchor attachments.
 */
const ATTACH_CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.swift', '.kt', '.kts',
]);
const MAX_RELATED_HOP1 = 8;
const MAX_RELATED_HOP2 = 12;
const MAX_DIR_ANCHOR_FILES = 10;
const MAX_DIR_SCAN_DEPTH = 3;
const MAX_IMPORTER_SCAN_FILES = 300;
const MAX_SCAN_FILE_BYTES = 64 * 1024;
const MAX_RELATED_OUTLINE_SYMBOLS = 12;
const MAX_NEIGHBORHOOD_CHARS = 8000;

/**
 * PromptAttachmentProcessor - Tự động bóc tách các file/thư mục được @mention và đính kèm vào context
 *
 * Quy ước anchor: file được @mention là ĐIỂM NEO (anchor), không phải toàn bộ sự thật.
 * Khi MINUS_ATTACH_EXPAND=on (mặc định), processor tự động mở rộng vùng điều tra 2-hop:
 * hop-1 = file anchor import + file import anchor + sibling cùng thư mục (+ top-ranked files nếu anchor là thư mục),
 * hop-2 = file mà hop-1 import. LLM bị bắt buộc kiểm tra neighborhood trước khi kết luận/sửa code.
 */
export class PromptAttachmentProcessor {
  private static readonly MAX_ATTACHMENTS = 8;
  private static readonly MAX_SOURCE_BYTES = 64 * 1024;
  private static readonly MAX_CONTEXT_TOKENS = 12_000;

  /**
   * Regex phát hiện các @mention file/thư mục hoặc lệnh /add, /attach
   * Hỗ trợ Unicode (Tiếng Việt), đường dẫn trong ngoặc kép @"...", ký tự định tuyến Next.js (), [], @, +, #,...
   */
  private static readonly MENTION_REGEX = /(?:@(?:"([^"]+)"|'([^']+)'|([^\s"'`]+))|(?:^|\s)\/(?:add|attach)\s+(?:"([^"]+)"|'([^']+)'|([^\s]+)))/gu;

  private static readonly INVESTIGATION_SCOPE_DIRECTIVE = [
    '[INVESTIGATION SCOPE - ATTACHMENT ANCHOR RULE]',
    'User @-attached file(s) are INVESTIGATION ANCHORS, not the whole truth.',
    'MANDATORY expansion before concluding root cause or editing code:',
    '1. Read the anchor file(s).',
    '2. Inspect HOP-1 files (direct imports, importers, same-dir siblings, dir top-ranked files).',
    '3. Inspect HOP-2 files (files related to hop-1) with read_file / grep_search / analyze_impact.',
    'FORBIDDEN: concluding root cause or applying fixes based on anchor content alone without checking callers/dependencies.',
  ].join('\n');

  /**
   * Neighborhood expansion switch. Defaults to ON per directive
   * (lấy top-ranked files trong dir làm anchor, luôn mở rộng 2-hop).
   * Set MINUS_ATTACH_EXPAND=off|0|false|no|disabled to disable.
   */
  static isAttachmentExpansionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.MINUS_ATTACH_EXPAND?.trim().toLowerCase();
    if (!raw) return true;
    return !['off', '0', 'false', 'no', 'disabled'].includes(raw);
  }

  /**
   * Bóc tách các đường dẫn được đề cập trong prompt
   */
  static extractMentionedPaths(text: string): string[] {
    const paths = new Set<string>();
    let match: RegExpExecArray | null;

    const regex = new RegExp(this.MENTION_REGEX.source, 'gu');
    while ((match = regex.exec(text)) !== null) {
      const isQuoted = Boolean(match[1] || match[2] || match[4] || match[5]);
      let candidate = (match[1] || match[2] || match[3] || match[4] || match[5] || match[6] || '').trim();
      if (candidate && !candidate.startsWith('http://') && !candidate.startsWith('https://')) {
        if (!isQuoted) {
          // 1. Loại bỏ các dấu câu thông thường ở đuôi
          candidate = candidate.replace(/[,;:\?!]+$/, '');

          // 2. Cân bằng dấu đóng mở ngoặc ), ], }, > ở đuôi
          while (candidate.endsWith(')') && (candidate.match(/\)/g) || []).length > (candidate.match(/\(/g) || []).length) {
            candidate = candidate.slice(0, -1);
          }
          while (candidate.endsWith(']') && (candidate.match(/\]/g) || []).length > (candidate.match(/\[/g) || []).length) {
            candidate = candidate.slice(0, -1);
          }
          while (candidate.endsWith('}') && (candidate.match(/\}/g) || []).length > (candidate.match(/\{/g) || []).length) {
            candidate = candidate.slice(0, -1);
          }
          while (candidate.endsWith('>') && (candidate.match(/>/g) || []).length > (candidate.match(/</g) || []).length) {
            candidate = candidate.slice(0, -1);
          }
        }

        // 3. Loại bỏ dấu gạch chéo thừa ở đuôi
        candidate = candidate.replace(/[\/\\]+$/, '');

        // 4. Loại bỏ tiền tố ./ hoặc .\ nếu có
        if (candidate.startsWith('./') || candidate.startsWith('.\\')) {
          candidate = candidate.slice(2);
        }

        if (candidate && candidate !== '.' && candidate !== '..') {
          paths.add(candidate);
        }
      }
    }

    return Array.from(paths);
  }

  private static extractRelativeImports(content: string): string[] {
    const specifiers: string[] = [];
    const pattern = /(?:import|export\s+(?:\{|\*))\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1] || match[2];
      if (specifier?.startsWith('.')) specifiers.push(specifier);
    }
    return [...new Set(specifiers)];
  }

  private static resolveRelativeImport(fromRelPath: string, specifier: string, workspace: Workspace): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const fromPosix = fromRelPath.split(path.sep).join('/');
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPosix), specifier));
    const ext = path.posix.extname(base).toLowerCase();
    const noExt = ATTACH_CODE_EXTENSIONS.has(ext) ? base.slice(0, -ext.length) : base;
    const candidates = [
      base,
      ...[...ATTACH_CODE_EXTENSIONS].map((e) => `${noExt}${e}`),
      ...[...ATTACH_CODE_EXTENSIONS].map((e) => `${noExt}/index${e}`),
    ];
    for (const candidate of candidates) {
      try {
        const safe = workspace.resolveSafePath(candidate);
        if (fs.existsSync(safe) && fs.statSync(safe).isFile()) {
          return workspace.toRelativePath(safe);
        }
      } catch {
        // Unsafe or missing candidate — try next.
      }
    }
    return undefined;
  }

  /**
   * Xếp hạng file trong thư mục được @attach để lấy top-ranked làm anchor bổ sung.
   * Ưu tiên file code, kích thước vừa phải (dễ đọc toàn bộ), sắp xếp ổn định theo tên.
   */
  private static async collectTopRankedFilesInDir(safeDirAbs: string, workspace: Workspace, limit = MAX_DIR_ANCHOR_FILES): Promise<string[]> {
    const scored: Array<{ rel: string; score: number }> = [];
    const visit = async (dirAbs: string, depth: number): Promise<void> => {
      if (depth > MAX_DIR_SCAN_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of files) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ATTACH_CODE_EXTENSIONS.has(ext)) continue;
        try {
          const abs = path.join(dirAbs, entry.name);
          const stat = await fsp.stat(abs);
          if (stat.size > MAX_SCAN_FILE_BYTES) continue;
          // File code nhỏ được ưu tiên (đọc trọn vẹn trong 1 lần), cộng depth penalty.
          const score = stat.size + depth * 4096;
          scored.push({ rel: workspace.toRelativePath(abs), score });
        } catch {
          // Bỏ qua file không đọc được.
        }
      }
      const dirs = entries.filter((e) => e.isDirectory() && !workspace.isIgnoredDirectory(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirs) {
        await visit(path.join(dirAbs, entry.name), depth + 1);
      }
    };
    await visit(safeDirAbs, 0);
    scored.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
    return scored.slice(0, Math.max(1, limit)).map((item) => item.rel);
  }

  /** Tìm file import anchor (importers) bằng quét giới hạn toàn workspace. */
  private static async findImporters(anchorRel: string, workspace: Workspace): Promise<string[]> {
    const base = path.basename(anchorRel).replace(/\.[^.]+$/, '');
    if (!base || base.length < 2) return [];
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importLine = new RegExp(`(?:import|require|from)\\s*[^\\n]*?${escaped}`, 'i');
    let entries: WorkspaceEntryInfo[];
    try {
      entries = FileMentionEngine.listWorkspaceEntries(workspace);
    } catch {
      return [];
    }
    const candidates = entries
      .filter((e) => e.type === 'file'
        && e.relativePath !== anchorRel
        && e.sizeBytes > 0
        && e.sizeBytes <= MAX_SCAN_FILE_BYTES
        && ATTACH_CODE_EXTENSIONS.has(path.extname(e.relativePath).toLowerCase()))
      .slice(0, MAX_IMPORTER_SCAN_FILES);
    const found: string[] = [];
    await Promise.all(candidates.map(async (entry) => {
      try {
        const safe = workspace.resolveSafePath(entry.relativePath);
        const content = await fsp.readFile(safe, 'utf8');
        if (importLine.test(content)) found.push(entry.relativePath);
      } catch {
        // Bỏ qua file không đọc được.
      }
    }));
    found.sort();
    return found.slice(0, 4);
  }

  /**
   * Mở rộng vùng điều tra 2-hop quanh anchor files.
   * Không bao giờ throw — thất bại thì degrade về danh sách seed (dir top-ranked).
   */
  private static async expandNeighborhood(
    anchors: string[],
    workspace: Workspace,
    seed: RelatedFileInfo[] = [],
  ): Promise<RelatedFileInfo[]> {
    const related = new Map<string, RelatedFileInfo>();
    for (const item of seed) related.set(item.path, item);
    const isAnchor = new Set(anchors);
    const hop1Paths: string[] = [];
    let hop1Count = 0;

    const addRelated = (relPath: string, hop: 1 | 2, reason: RelatedFileReason, via?: string): boolean => {
      if (!relPath || isAnchor.has(relPath) || related.has(relPath)) return false;
      related.set(relPath, { path: relPath, hop, reason, via });
      return true;
    };

    const readSource = async (relPath: string): Promise<string | undefined> => {
      try {
        const safe = workspace.resolveSafePath(relPath);
        const stat = await fsp.stat(safe);
        if (stat.size > MAX_SCAN_FILE_BYTES || workspace.isBinaryFile(relPath)) return undefined;
        return await fsp.readFile(safe, 'utf8');
      } catch {
        return undefined;
      }
    };

    for (const anchor of anchors.slice(0, 8)) {
      // Hop-1a: file mà anchor import trực tiếp.
      const content = await readSource(anchor);
      if (content !== undefined) {
        for (const spec of this.extractRelativeImports(content)) {
          if (hop1Count >= MAX_RELATED_HOP1) break;
          const target = this.resolveRelativeImport(anchor, spec, workspace);
          if (target && addRelated(target, 1, 'import', anchor)) {
            hop1Paths.push(target);
            hop1Count++;
          }
        }
      }
      // Hop-1b: sibling cùng thư mục (tối đa 3 file code).
      try {
        const dirAbs = path.dirname(workspace.resolveSafePath(anchor));
        const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
        const siblings = entries
          .filter((e) => e.isFile() && ATTACH_CODE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
          .map((e) => e.name)
          .sort()
          .slice(0, 3);
        for (const name of siblings) {
          if (hop1Count >= MAX_RELATED_HOP1) break;
          const rel = workspace.toRelativePath(path.join(dirAbs, name));
          if (rel !== anchor && addRelated(rel, 1, 'same-dir', anchor)) {
            hop1Paths.push(rel);
            hop1Count++;
          }
        }
      } catch {
        // Bỏ qua khi không đọc được thư mục chứa anchor.
      }
      // Hop-1c: file import anchor (callers ngược).
      if (hop1Count < MAX_RELATED_HOP1) {
        const importers = await this.findImporters(anchor, workspace).catch((): string[] => []);
        for (const importer of importers.slice(0, 4)) {
          if (hop1Count >= MAX_RELATED_HOP1) break;
          if (addRelated(importer, 1, 'imported-by', anchor)) {
            hop1Paths.push(importer);
            hop1Count++;
          }
        }
      }
    }

    // Hop-2: file mà hop-1 import (liên hệ của file có liên hệ với anchor).
    let hop2Count = 0;
    for (const hop1Path of hop1Paths.slice(0, 8)) {
      if (hop2Count >= MAX_RELATED_HOP2) break;
      const content = await readSource(hop1Path);
      if (content === undefined) continue;
      for (const spec of this.extractRelativeImports(content)) {
        if (hop2Count >= MAX_RELATED_HOP2) break;
        const target = this.resolveRelativeImport(hop1Path, spec, workspace);
        if (target && addRelated(target, 2, 'import', hop1Path)) hop2Count++;
      }
    }

    return [...related.values()];
  }

  private static renderCompactNeighborhoodBlock(anchors: string[], related: RelatedFileInfo[]): string {
    const format = (item: RelatedFileInfo): string =>
      `- ${item.path} (hop-${item.hop} • ${item.reason}${item.via ? ` via ${item.via}` : ''})`;
    const hop1 = related.filter((item) => item.hop === 1);
    const hop2 = related.filter((item) => item.hop === 2);
    return [
      '[Attachment Neighborhood - 2-hop Investigation Scope (compact)]',
      `Anchors (user @-attached, NOT the whole truth): ${anchors.join(', ')}`,
      hop1.length > 0 ? `Hop-1:\n${hop1.map(format).join('\n')}` : 'Hop-1: (none found)',
      hop2.length > 0 ? `Hop-2:\n${hop2.map(format).join('\n')}` : 'Hop-2: (none found)',
      this.INVESTIGATION_SCOPE_DIRECTIVE,
    ].join('\n');
  }

  private static async renderNeighborhoodBlock(
    anchors: string[],
    related: RelatedFileInfo[],
    workspace: Workspace,
  ): Promise<string> {
    const format = (item: RelatedFileInfo): string =>
      `- ${item.path} (hop-${item.hop} • ${item.reason}${item.via ? ` via ${item.via}` : ''})`;
    const hop1 = related.filter((item) => item.hop === 1);
    const hop2 = related.filter((item) => item.hop === 2);
    const lines = [
      '[Attachment Neighborhood - 2-hop Investigation Scope]',
      `Anchors (user @-attached, ground truth but NOT the whole truth): ${anchors.join(', ')}`,
      hop1.length > 0 ? `Hop-1 (directly related):\n${hop1.map(format).join('\n')}` : 'Hop-1 (directly related): (none found)',
      hop2.length > 0 ? `Hop-2 (related to hop-1):\n${hop2.map(format).join('\n')}` : 'Hop-2 (related to hop-1): (none found)',
    ];

    const outlineLines: string[] = [];
    for (const item of related) {
      const usedChars = lines.join('\n').length + outlineLines.join('\n').length;
      if (usedChars > MAX_NEIGHBORHOOD_CHARS - 1500) break;
      try {
        if (workspace.isBinaryFile(item.path)) continue;
        const safe = workspace.resolveSafePath(item.path);
        const stat = await fsp.stat(safe);
        if (stat.size > MAX_SCAN_FILE_BYTES) continue;
        const content = await fsp.readFile(safe, 'utf8');
        const outline = SemanticSlicer.extractOutline(item.path, content);
        if (outline.symbols.length === 0) continue;
        outlineLines.push(
          `### ${item.path} (hop-${item.hop} • ${item.reason})\n`
          + outline.symbols.slice(0, MAX_RELATED_OUTLINE_SYMBOLS)
            .map((s) => `  - [${s.kind}] ${s.name} (Lines ${s.startLine}-${s.endLine}): ${s.signature}`)
            .join('\n'),
        );
      } catch {
        // Bỏ qua file liên quan không đọc được — danh sách path phía trên vẫn đủ để LLM tự inspect.
      }
    }
    if (outlineLines.length > 0) {
      lines.push(`Related-file outlines (signatures only; use read_file with startLine/endLine for full code):\n${outlineLines.join('\n')}`);
    }
    lines.push(this.INVESTIGATION_SCOPE_DIRECTIVE);

    const block = lines.join('\n');
    return block.length > MAX_NEIGHBORHOOD_CHARS
      ? this.renderCompactNeighborhoodBlock(anchors, related)
      : block;
  }

  /**
   * Đọc và đính kèm nội dung của tất cả các file / thư mục được nhắc tới vào user prompt
   */
  static async resolveAndAttach(
    userPrompt: string,
    workspace: Workspace,
    options?: { expansionEnabled?: boolean },
  ): Promise<AttachmentResult> {
    const mentionedPaths = this.extractMentionedPaths(userPrompt);
    const expansionEnabled = options?.expansionEnabled ?? this.isAttachmentExpansionEnabled();

    if (mentionedPaths.length === 0) {
      return {
        originalPrompt: userPrompt,
        expandedPrompt: userPrompt,
        attachments: [],
        hasAttachments: false,
        expansionEnabled,
      };
    }

    const attachments: AttachedItemSummary[] = [];
    const attachedContextBlocks: string[] = [];
    const skippedAttachments: NonNullable<AttachmentResult['skippedAttachments']> = [];
    const anchorFiles: string[] = [];
    const attachedDirs: string[] = [];
    const dirTopRanked: RelatedFileInfo[] = [];
    let attachedSourceBytes = 0;
    let attachedContextTokens = 0;

    for (const relPath of mentionedPaths) {
      try {
        if (attachments.length >= this.MAX_ATTACHMENTS) {
          skippedAttachments.push({ path: relPath, reason: 'attachment_limit' });
          continue;
        }

        const safePath = workspace.resolveSafePath(relPath);
        if (!fs.existsSync(safePath)) {
          continue;
        }

        const stat = await fsp.stat(safePath);
        if (attachedSourceBytes + stat.size > this.MAX_SOURCE_BYTES) {
          skippedAttachments.push({ path: relPath, reason: 'source_byte_limit' });
          continue;
        }

        let attachment: AttachedItemSummary;
        let contextBlock: string;

        if (stat.isFile()) {
          const isBinary = workspace.isBinaryFile(relPath);
          if (!isBinary && !anchorFiles.includes(relPath)) anchorFiles.push(relPath);
          if (isBinary) {
            attachment = {
              path: relPath,
              type: 'file',
              sizeBytes: stat.size,
              preview: '[Binary File]',
            };
            contextBlock = `\n---\n[Attached Binary File: ${relPath} (${(stat.size / 1024).toFixed(1)} KB)]\n---`;
          } else {
            const content = await fsp.readFile(safePath, 'utf8');
            const lines = content.split(/\r?\n/);
            const lineCount = lines.length;
            const ext = path.extname(relPath).replace(/^\./, '') || 'text';

            let renderedContent = content;
            let isSliced = false;

            // Nếu file quá dài (> 350 dòng hoặc > 14KB), tự động áp dụng Semantic AST Slicing (Cursor Standard)
            if (lineCount > 350 || stat.size > 14000) {
              const outline = SemanticSlicer.extractOutline(relPath, content);
              if (outline.symbols.length > 0) {
                isSliced = true;
                const headLines = lines.slice(0, 45).join('\n');
                const topSymbols = outline.symbols.slice(0, 25);
                let symbolOutlineLines = topSymbols
                  .map((s) => `  - [${s.kind}] ${s.name} (Lines ${s.startLine}-${s.endLine}): ${s.signature}`)
                  .join('\n');
                if (outline.symbols.length > 25) {
                  symbolOutlineLines += `\n  - ... (+${outline.symbols.length - 25} other symbols in this file)`;
                }

                renderedContent = `${headLines}\n\n// ... [SEMANTIC AST SLICE: File is large (${lineCount} lines • ${(stat.size / 1024).toFixed(1)} KB)] ...\n// Structural symbols index (showing ${topSymbols.length}/${outline.symbols.length}):\n${symbolOutlineLines}\n\n// [NOTE]: Use tool read_file with startLine/endLine if a specific function implementation is required.`;
              }
            }

            attachment = {
              path: relPath,
              type: 'file',
              sizeBytes: stat.size,
              lineCount,
              preview: isSliced ? `[AST Sliced: ${lineCount} lines]` : undefined,
            };
            contextBlock = `\n---\n[Attached File: ${relPath} (${lineCount} lines • ${(stat.size / 1024).toFixed(1)} KB${isSliced ? ' • Semantic AST Sliced' : ''})]\n\`\`\`${ext}\n${renderedContent}\n\`\`\`\n---`;
          }
        } else if (stat.isDirectory()) {
          // Nếu là thư mục, tạo sơ đồ cây thư mục (Directory Tree)
          const treeListing = await this.renderDirectoryTree(safePath, workspace, 3);
          const entries = await fsp.readdir(safePath);
          const fileCount = entries.length;

          attachment = {
            path: relPath,
            type: 'directory',
            sizeBytes: stat.size,
            fileCount,
          };
          contextBlock = `\n---\n[Attached Directory: ${relPath}/ (${fileCount} entries)]\n\`\`\`\n${treeListing}\n\`\`\`\n---`;
          if (!attachedDirs.includes(relPath)) attachedDirs.push(relPath);
          if (expansionEnabled) {
            const topRanked = await this.collectTopRankedFilesInDir(safePath, workspace).catch((): string[] => []);
            for (const topRel of topRanked) {
              if (!dirTopRanked.some((item) => item.path === topRel)) {
                dirTopRanked.push({ path: topRel, hop: 1, reason: 'dir-top-ranked', via: relPath });
              }
            }
          }
        } else {
          continue;
        }

        const estimatedTokens = Math.ceil(Buffer.byteLength(contextBlock, 'utf8') / 4);
        if (attachedContextTokens + estimatedTokens > this.MAX_CONTEXT_TOKENS) {
          skippedAttachments.push({ path: relPath, reason: 'context_token_limit' });
          continue;
        }

        attachments.push(attachment);
        attachedContextBlocks.push(contextBlock);
        attachedSourceBytes += stat.size;
        attachedContextTokens += estimatedTokens;
      } catch {
        // Bỏ qua nếu có lỗi bảo mật hoặc không truy cập được
        continue;
      }
    }

    if (attachments.length === 0 && skippedAttachments.length === 0) {
      return {
        originalPrompt: userPrompt,
        expandedPrompt: userPrompt,
        attachments: [],
        hasAttachments: false,
        expansionEnabled,
      };
    }

    if (skippedAttachments.length > 0) {
      const skippedSummary = skippedAttachments.map(({ path: skippedPath, reason }) => `- ${skippedPath}: ${reason}`).join('\n');
      attachedContextBlocks.push(`\n[Attachment limits] The following user-mentioned paths were not attached:\n${skippedSummary}`);
    }

    // Mở rộng vùng điều tra 2-hop quanh anchor (mặc định ON qua MINUS_ATTACH_EXPAND).
    // Dir attach không có file anchor: lấy top-ranked files trong dir làm anchor mở rộng.
    let relatedFiles: RelatedFileInfo[] = [...dirTopRanked];
    const expansionAnchors = anchorFiles.length > 0
      ? anchorFiles
      : dirTopRanked.map((item) => item.path);
    const blockAnchors = anchorFiles.length > 0
      ? anchorFiles
      : attachedDirs.map((dir) => `${dir}/`);
    if (expansionEnabled && blockAnchors.length > 0) {
      try {
        if (expansionAnchors.length > 0) {
          relatedFiles = await this.expandNeighborhood(expansionAnchors, workspace, dirTopRanked);
        }
        const neighborhoodBlock = await this.renderNeighborhoodBlock(blockAnchors, relatedFiles, workspace);
        if (neighborhoodBlock) {
          const estimatedTokens = Math.ceil(Buffer.byteLength(neighborhoodBlock, 'utf8') / 4);
          if (attachedContextTokens + estimatedTokens <= this.MAX_CONTEXT_TOKENS) {
            attachedContextBlocks.push(neighborhoodBlock);
            attachedContextTokens += estimatedTokens;
          } else {
            const compactBlock = this.renderCompactNeighborhoodBlock(blockAnchors, relatedFiles);
            const compactTokens = Math.ceil(Buffer.byteLength(compactBlock, 'utf8') / 4);
            if (attachedContextTokens + compactTokens <= this.MAX_CONTEXT_TOKENS) {
              attachedContextBlocks.push(compactBlock);
              attachedContextTokens += compactTokens;
            }
          }
        }
      } catch {
        // Degrade gracefully: anchor attachments phía trên vẫn đầy đủ giá trị.
      }
    }

    // Gắn phần attachments vào đuôi user prompt
    const expandedPrompt = `${userPrompt.trim()}\n\n[User Attached Workspace Context]\n${attachedContextBlocks.join('\n')}`;

    return {
      originalPrompt: userPrompt,
      expandedPrompt,
      attachments,
      hasAttachments: attachments.length > 0,
      skippedAttachments: skippedAttachments.length > 0 ? skippedAttachments : undefined,
      anchorPaths: anchorFiles.length > 0 ? anchorFiles : undefined,
      relatedFiles: relatedFiles.length > 0 ? relatedFiles : undefined,
      expansionEnabled,
    };
  }

  /**
   * Tạo sơ đồ cây thư mục trực quan cho thư mục được đính kèm (giới hạn an toàn chống tràn buffer)
   */
  private static async renderDirectoryTree(
    dirPath: string,
    workspace: Workspace,
    maxDepth = 3,
    currentDepth = 0,
    maxEntriesPerDir = 40,
  ): Promise<string> {
    if (currentDepth > maxDepth) return '';

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return '';
    }

    const dirEntries: fs.Dirent[] = [];
    const fileEntries: fs.Dirent[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!workspace.isIgnoredDirectory(entry.name)) {
          dirEntries.push(entry);
        }
      } else if (entry.isFile()) {
        fileEntries.push(entry);
      }
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));

    const lines: string[] = [];
    const indent = '  '.repeat(currentDepth);

    let count = 0;
    for (const entry of dirEntries) {
      if (count >= maxEntriesPerDir) {
        lines.push(`${indent}... (+${dirEntries.length - count} more directories)`);
        break;
      }
      lines.push(`${indent}📁 ${entry.name}/`);
      const subTree = await this.renderDirectoryTree(
        path.join(dirPath, entry.name),
        workspace,
        maxDepth,
        currentDepth + 1,
        maxEntriesPerDir,
      );
      if (subTree) lines.push(subTree);
      count++;
    }

    let fileCount = 0;
    for (const entry of fileEntries) {
      if (fileCount >= maxEntriesPerDir) {
        lines.push(`${indent}... (+${fileEntries.length - fileCount} more files)`);
        break;
      }
      lines.push(`${indent}📄 ${entry.name}`);
      fileCount++;
    }

    return lines.join('\n');
  }
}
