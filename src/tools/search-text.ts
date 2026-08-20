import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

interface MatchItem {
  file: string;
  line: number;
  text: string;
}

/**
 * Tool 3: search_text
 * Tìm kiếm chuỗi văn bản trong các file text của workspace.
 */
export const searchTextTool: ToolDefinition = {
  name: 'search_text',
  description: 'Tìm kiếm chuỗi văn bản trong các file của một thư mục. Trả về danh sách file, số dòng và nội dung khớp.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Chuỗi văn bản cần tìm kiếm (không phân biệt hoa/thường)',
      },
      path: {
        type: Type.STRING,
        description: 'Thư mục bắt đầu tìm kiếm (mặc định là ".")',
      },
    },
    required: ['query'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const query = String(args.query || '').toLowerCase();
    const rawPath = String(args.path || '.');

    if (!query) {
      return { error: 'Tham số "query" không được để trống.' };
    }

    try {
      const safeRoot = workspace.resolveSafePath(rawPath);
      const matches: MatchItem[] = [];
      const maxMatches = 50;
      let truncated = false;

      async function walk(currentDir: string) {
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }

        const entries = await fs.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (matches.length >= maxMatches) {
            truncated = true;
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
                if (matches.length >= maxMatches) {
                  truncated = true;
                  break;
                }

                const line = lines[i];
                if (line.toLowerCase().includes(query)) {
                  const relativeFilePath = workspace.toRelativePath(fullPath);
                  matches.push({
                    file: relativeFilePath,
                    line: i + 1,
                    text: line.trim(),
                  });
                }
              }
            } catch {
              // Bỏ qua nếu file không đọc được dạng utf-8
            }
          }
        }
      }

      await walk(safeRoot);

      return {
        query: args.query,
        matches,
        totalMatches: matches.length,
        truncated,
      };
    } catch (err: any) {
      return {
        error: `Tìm kiếm thất bại: ${err.message}`,
      };
    }
  },
};
