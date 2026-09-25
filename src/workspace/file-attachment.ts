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

export interface AttachmentResult {
  originalPrompt: string;
  expandedPrompt: string;
  attachments: AttachedItemSummary[];
  hasAttachments: boolean;
  skippedAttachments?: Array<{ path: string; reason: 'attachment_limit' | 'source_byte_limit' | 'context_token_limit' }>;
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
 * PromptAttachmentProcessor - Tự động bóc tách các file/thư mục được @mention và đính kèm vào context
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
    const skippedAttachments: NonNullable<AttachmentResult['skippedAttachments']> = [];
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
          if (workspace.isBinaryFile(relPath)) {
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
      };
    }

    if (skippedAttachments.length > 0) {
      const skippedSummary = skippedAttachments.map(({ path: skippedPath, reason }) => `- ${skippedPath}: ${reason}`).join('\n');
      attachedContextBlocks.push(`\n[Attachment limits] The following user-mentioned paths were not attached:\n${skippedSummary}`);
    }

    // Gắn phần attachments vào đuôi user prompt
    const expandedPrompt = `${userPrompt.trim()}\n\n[User Attached Workspace Context]\n${attachedContextBlocks.join('\n')}`;

    return {
      originalPrompt: userPrompt,
      expandedPrompt,
      attachments,
      hasAttachments: attachments.length > 0,
      skippedAttachments: skippedAttachments.length > 0 ? skippedAttachments : undefined,
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
        lines.push(`${indent}... (+${dirEntries.length - count} thư mục khác)`);
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
        lines.push(`${indent}... (+${fileEntries.length - fileCount} tệp tin khác)`);
        break;
      }
      lines.push(`${indent}📄 ${entry.name}`);
      fileCount++;
    }

    return lines.join('\n');
  }
}
