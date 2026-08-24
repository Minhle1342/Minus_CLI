import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from './workspace.js';

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

export interface AttachmentResult {
  originalPrompt: string;
  expandedPrompt: string;
  attachments: AttachedItemSummary[];
  hasAttachments: boolean;
}

/**
 * FileMentionEngine - Động cơ tìm kiếm & gợi ý File / Thư mục Real-time theo chuẩn Codex CLI
 */
export class FileMentionEngine {
  private static cache: Map<string, { entries: WorkspaceEntryInfo[]; timestamp: number }> = new Map();
  private static readonly CACHE_TTL_MS = 3000; // 3 giây tự động invalidate cache

  /**
   * Quét và lập danh mục toàn bộ file và thư mục trong Workspace (bỏ qua ignored directories)
   */
  static listWorkspaceEntries(workspace: Workspace, maxDepth = 5, maxEntries = 1000): WorkspaceEntryInfo[] {
    const rootDir = workspace.rootDir;
    const cached = this.cache.get(rootDir);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.entries;
    }

    const results: WorkspaceEntryInfo[] = [];

    const traverse = (currentDir: string, depth: number) => {
      if (depth > maxDepth || results.length >= maxEntries) return;

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const item of items) {
        if (results.length >= maxEntries) break;

        const fullPath = path.join(currentDir, item.name);
        const relPath = workspace.toRelativePath(fullPath);

        if (item.isDirectory()) {
          if (workspace.isIgnoredDirectory(item.name)) continue;

          results.push({
            relativePath: relPath,
            displayPath: `${relPath}/`,
            type: 'directory',
            sizeBytes: 0,
          });

          traverse(fullPath, depth + 1);
        } else if (item.isFile()) {
          if (workspace.isBinaryFile(item.name)) continue;

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
    };

    traverse(rootDir, 0);

    // Sắp xếp ưu tiên: thư mục ở trên, sau đó theo alphabet
    results.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });

    this.cache.set(rootDir, { entries: results, timestamp: now });
    return results;
  }

  /**
   * Trích xuất token mention (@path) đang được gõ tại vị trí con trỏ
   */
  static extractActiveMention(line: string, cursorColumn = line.length): { query: string; start: number; end: number } | null {
    const textBeforeCursor = line.slice(0, cursorColumn);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex === -1) return null;

    // Kiểm tra ký tự trước '@' (phải là đầu dòng hoặc khoảng trắng hoặc dấu mở ngoặc)
    if (atIndex > 0 && !/[\s(=,;:[{]/.test(textBeforeCursor[atIndex - 1])) {
      return null;
    }

    const query = textBeforeCursor.slice(atIndex + 1);
    // Không chứa khoảng trắng trong mention query
    if (/\s/.test(query)) {
      return null;
    }

    return {
      query,
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

    const rawQuery = mention.query.toLowerCase().replace(/\\/g, '/');
    const entries = this.listWorkspaceEntries(workspace);

    if (rawQuery === '') {
      // Khi vừa gõ '@', gợi ý các thư mục và file gốc hàng đầu
      return entries.slice(0, limit).map((e, idx) => ({
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

    const matched: FileMentionSuggestion[] = [];

    for (const entry of entries) {
      const target = entry.relativePath.toLowerCase();
      const baseName = path.basename(entry.relativePath).toLowerCase();

      let matchedBy: 'exact' | 'prefix' | 'contains' | 'fuzzy' | null = null;
      let score = 100;

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
   */
  static completeMention(line: string, workspace: Workspace): [string[], string] {
    const mention = this.extractActiveMention(line);
    if (!mention) return [[], line];

    const suggestions = this.getFileSuggestions(line, workspace, line.length, 10);
    if (suggestions.length === 0) return [[], line];

    // Thay thế phần `@query` bằng `@displayPath`
    const prefixBeforeAt = line.slice(0, mention.start);
    const completions = suggestions.map((s) => `${prefixBeforeAt}@${s.displayPath}`);

    return [completions, line];
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
 * PromptAttachmentProcessor - Tự động bóc tách các file/thư mục được @mention và đính kèm vào context
 */
export class PromptAttachmentProcessor {
  /**
   * Regex phát hiện các @mention file/thư mục hoặc lệnh /add, /attach
   */
  private static readonly MENTION_REGEX = /(?:@([a-zA-Z0-9_.\-\/\\]+)|(?:^|\s)\/(?:add|attach)\s+([^\s]+))/g;

  /**
   * Bóc tách các đường dẫn được đề cập trong prompt
   */
  static extractMentionedPaths(text: string): string[] {
    const paths = new Set<string>();
    let match: RegExpExecArray | null;

    const regex = new RegExp(this.MENTION_REGEX.source, 'g');
    while ((match = regex.exec(text)) !== null) {
      const candidate = (match[1] || match[2] || '').trim();
      if (candidate && !candidate.startsWith('http://') && !candidate.startsWith('https://')) {
        // Loại bỏ dấu nháy, dấu chấm câu hoặc dấu gạch chéo ở đuôi
        const cleaned = candidate.replace(/[,;:)\]}]+$/, '').replace(/[\/\\]+$/, '');
        if (cleaned) {
          paths.add(cleaned);
        }
      }
    }

    return Array.from(paths);
  }

  /**
   * Đọc và đính kèm nội dung của tất cả các file / thư mục được nhắc tới vào user prompt
   */
  static async resolveAndAttach(userPrompt: string, workspace: Workspace): Promise<AttachmentResult> {
    const mentionedPaths = this.extractMentionedPaths(userPrompt);

    if (mentionedPaths.length === 0) {
      return {
        originalPrompt: userPrompt,
        expandedPrompt: userPrompt,
        attachments: [],
        hasAttachments: false,
      };
    }

    const attachments: AttachedItemSummary[] = [];
    const attachedContextBlocks: string[] = [];

    for (const relPath of mentionedPaths) {
      try {
        const safePath = workspace.resolveSafePath(relPath);
        if (!fs.existsSync(safePath)) {
          continue;
        }

        const stat = await fsp.stat(safePath);

        if (stat.isFile()) {
          if (workspace.isBinaryFile(relPath)) {
            attachments.push({
              path: relPath,
              type: 'file',
              sizeBytes: stat.size,
              preview: '[Binary File]',
            });
            attachedContextBlocks.push(
              `\n---\n[Attached Binary File: ${relPath} (${(stat.size / 1024).toFixed(1)} KB)]\n---`
            );
            continue;
          }

          const content = await fsp.readFile(safePath, 'utf8');
          const lines = content.split(/\r?\n/);
          const lineCount = lines.length;
          const ext = path.extname(relPath).replace(/^\./, '') || 'text';

          attachments.push({
            path: relPath,
            type: 'file',
            sizeBytes: stat.size,
            lineCount,
          });

          // Định dạng theo chuẩn Markdown Code Block rõ ràng cho LLM
          attachedContextBlocks.push(
            `\n---\n[Attached File: ${relPath} (${lineCount} lines • ${(stat.size / 1024).toFixed(1)} KB)]\n\`\`\`${ext}\n${content}\n\`\`\`\n---`
          );
        } else if (stat.isDirectory()) {
          // Nếu là thư mục, tạo sơ đồ cây thư mục (Directory Tree)
          const treeListing = await this.renderDirectoryTree(safePath, workspace, 3);
          const entries = await fsp.readdir(safePath);
          const fileCount = entries.length;

          attachments.push({
            path: relPath,
            type: 'directory',
            sizeBytes: stat.size,
            fileCount,
          });

          attachedContextBlocks.push(
            `\n---\n[Attached Directory: ${relPath}/ (${fileCount} entries)]\n\`\`\`\n${treeListing}\n\`\`\`\n---`
          );
        }
      } catch {
        // Bỏ qua nếu có lỗi bảo mật hoặc không truy cập được
        continue;
      }
    }

    if (attachments.length === 0) {
      return {
        originalPrompt: userPrompt,
        expandedPrompt: userPrompt,
        attachments: [],
        hasAttachments: false,
      };
    }

    // Gắn phần attachments vào đuôi user prompt
    const expandedPrompt = `${userPrompt.trim()}\n\n[User Attached Workspace Context]\n${attachedContextBlocks.join('\n')}`;

    return {
      originalPrompt: userPrompt,
      expandedPrompt,
      attachments,
      hasAttachments: true,
    };
  }

  /**
   * Tạo sơ đồ cây thư mục trực quan cho thư mục được đính kèm
   */
  private static async renderDirectoryTree(dirPath: string, workspace: Workspace, maxDepth = 3, currentDepth = 0): Promise<string> {
    if (currentDepth > maxDepth) return '';

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return '';
    }

    const lines: string[] = [];
    const indent = '  '.repeat(currentDepth);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (workspace.isIgnoredDirectory(entry.name)) continue;
        lines.push(`${indent}📁 ${entry.name}/`);
        const subTree = await this.renderDirectoryTree(path.join(dirPath, entry.name), workspace, maxDepth, currentDepth + 1);
        if (subTree) lines.push(subTree);
      } else if (entry.isFile()) {
        lines.push(`${indent}📄 ${entry.name}`);
      }
    }

    return lines.join('\n');
  }
}
