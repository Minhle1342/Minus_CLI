import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

export interface MatchItem {
  file: string;
  line: number;
  text: string;
}

export interface FileMatchSummary {
  file: string;
  matchCount: number;
}

/**
 * Tool 3: search_text (Two-Stage Output Capping & Context Protection Ready)
 * Tìm kiếm chuỗi văn bản trong các file text của workspace.
 * Hỗ trợ các outputMode: 'content' (mặc định), 'files_with_matches', 'count'
 * Tự động kích hoạt Two-Stage Capping khi có quá nhiều kết quả để bảo vệ Context Window.
 */
export const searchTextTool: ToolDefinition = {
  name: 'search_text',
  description: 'Tìm kiếm chuỗi văn bản trong các file của một thư mục. Hỗ trợ outputMode ("content", "files_with_matches", "count") và cơ chế Two-Stage Capping chống ngộ độc context.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Chuỗi văn bản cần tìm kiếm',
      },
      path: {
        type: Type.STRING,
        description: 'Thư mục bắt đầu tìm kiếm (mặc định là ".")',
      },
      outputMode: {
        type: Type.STRING,
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Chế độ hiển thị: "content" (dòng khớp chi tiết), "files_with_matches" (chỉ danh sách file + số lượng khớp để tiết kiệm token), hoặc "count" (chỉ đếm số lượng). Mặc định là "content".',
      },
      caseSensitive: {
        type: Type.BOOLEAN,
        description: 'Nếu true, tìm kiếm phân biệt chữ hoa/thường. Mặc định false.',
      },
      maxMatches: {
        type: Type.INTEGER,
        description: 'Giới hạn số lượng kết quả chi tiết trả về (mặc định: 30, tối đa: 100).',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawQuery = String(args.query || '');
    const rawPath = String(args.path || '.');
    const outputMode = args.outputMode || 'content';
    const caseSensitive = args.caseSensitive === true;
    const maxMatches = Math.min(100, Math.max(1, Number(args.maxMatches) || 30));

    if (!rawQuery.trim()) {
      return { error: 'Tham số "query" không được để trống.', errorCode: 'INVALID_ARGS' };
    }

    const searchQuery = caseSensitive ? rawQuery : rawQuery.toLowerCase();

    try {
      const safeRoot = workspace.resolveSafePath(rawPath);
      const allMatches: MatchItem[] = [];
      const fileSummaryMap = new Map<string, number>();
      const hardMaxMatches = 200; // Cắt cứng quét để tránh treo I/O
      let isScanCapped = false;

      async function walk(currentDir: string) {
        if (allMatches.length >= hardMaxMatches) {
          isScanCapped = true;
          return;
        }

        const entries = await fs.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (allMatches.length >= hardMaxMatches) {
            isScanCapped = true;
            break;
          }

          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            if (workspace.isIgnoredDirectory(entry.name)) {
              continue;
            }
            await walk(fullPath);
          } else if (entry.isFile()) {
            if (workspace.isBinaryFile(entry.name)) {
              continue;
            }

            try {
              const fileContent = await fs.readFile(fullPath, 'utf-8');
              const lines = fileContent.split('\n');

              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const matched = caseSensitive
                  ? line.includes(searchQuery)
                  : line.toLowerCase().includes(searchQuery);

                if (matched) {
                  const relativeFilePath = workspace.toRelativePath(fullPath);
                  fileSummaryMap.set(relativeFilePath, (fileSummaryMap.get(relativeFilePath) || 0) + 1);

                  allMatches.push({
                    file: relativeFilePath,
                    line: i + 1,
                    text: line.trim(),
                  });

                  if (allMatches.length >= hardMaxMatches) {
                    isScanCapped = true;
                    break;
                  }
                }
              }
            } catch {
              // Bỏ qua nếu file không đọc được dạng utf-8
            }
          }
        }
      }

      await walk(safeRoot);

      const fileSummaries: FileMatchSummary[] = Array.from(fileSummaryMap.entries()).map(
        ([file, matchCount]) => ({ file, matchCount }),
      );

      // 1. Chế độ 'count': Chỉ trả về thống kê
      if (outputMode === 'count') {
        return {
          query: rawQuery,
          totalMatches: allMatches.length,
          totalFiles: fileSummaries.length,
          isScanCapped,
        };
      }

      // 2. Chế độ 'files_with_matches' (SWE-agent Stage 1 Overview Standard)
      if (outputMode === 'files_with_matches') {
        return {
          query: rawQuery,
          totalMatches: allMatches.length,
          totalFiles: fileSummaries.length,
          files: fileSummaries,
          isScanCapped,
          guidance: 'Danh sách các file chứa từ khóa. Để xem chi tiết từng file, gọi read_file hoặc search_text với path cụ thể.',
        };
      }

      // 3. Chế độ 'content' mặc định kèm Two-Stage Capping khi nhiều kết quả
      const isTwoStageCapped = allMatches.length > 20 || fileSummaries.length > 3;
      const returnedMatches = isTwoStageCapped
        ? allMatches.slice(0, Math.min(15, maxMatches))
        : allMatches.slice(0, maxMatches);

      return {
        query: rawQuery,
        outputMode: 'content',
        totalMatches: allMatches.length,
        totalFiles: fileSummaries.length,
        fileSummary: fileSummaries,
        matches: returnedMatches,
        isCapped: isTwoStageCapped || allMatches.length > returnedMatches.length,
        isScanCapped,
        notice: isTwoStageCapped
          ? `[TWO-STAGE SEARCH CAPPED]: Tìm thấy ${allMatches.length} vị trí khớp trong ${fileSummaries.length} files. Hiển thị tổng hợp file và ${returnedMatches.length} dòng mẫu để chống loãng context. Hãy dùng outputMode="files_with_matches" hoặc chỉ định path="<file>" để lọc chính xác.`
          : undefined,
      };
    } catch (err: any) {
      return {
        error: `Tìm kiếm thất bại: ${err.message}`,
        errorCode: 'SEARCH_ERROR',
      };
    }
  },
};
