import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * Tool 2: list_files
 * Liệt kê danh sách các file và thư mục bên trong một đường dẫn, tự động lọc các thư mục nội bộ.
 */
export const listFilesTool: ToolDefinition = {
  name: 'list_files',
  description: 'Liệt kê danh sách các tệp tin và thư mục con trong một thư mục thuộc workspace. Hỗ trợ tự động phân trang và cắt bớt thư mục khổng lồ để bảo vệ Context Window.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới thư mục cần xem (ví dụ: "." hoặc "src")',
      },
      maxEntries: {
        type: Type.INTEGER,
        description: 'Số lượng phần tử tối đa trả về (mặc định: 60, tối đa: 200).',
      },
      offset: {
        type: Type.INTEGER,
        description: 'Vị trí bắt đầu lấy kết quả để phân trang (mặc định: 0).',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '.');
    const maxEntries = Math.min(200, Math.max(1, Number(args.maxEntries) || 60));
    const offset = Math.max(0, Number(args.offset) || 0);

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      let stat;
      try {
        stat = await fs.stat(safePath);
      } catch (statErr: any) {
        if (statErr.code === 'ENOENT' || String(statErr.message).includes('ENOENT')) {
          return {
            path: rawPath,
            error: `Thư mục "${rawPath}" không tồn tại (ENOENT: no such file or directory).`,
            errorCode: 'PATH_NOT_FOUND',
            suggestion: 'Dùng list_files với path="." để xem cấu trúc thư mục gốc.',
          };
        }
        throw statErr;
      }

      if (!stat.isDirectory()) {
        return {
          path: rawPath,
          error: `Đường dẫn "${rawPath}" là tệp tin, không phải thư mục.`,
          errorCode: 'NOT_A_DIRECTORY',
          suggestion: `Dùng read_file với path="${rawPath}" để xem nội dung tệp tin này.`,
        };
      }

      const entries = await fs.readdir(safePath, { withFileTypes: true });
      
      const filteredEntries: Array<{ name: string; type: 'file' | 'directory' }> = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!workspace.isIgnoredDirectory(entry.name)) {
            filteredEntries.push({ name: entry.name, type: 'directory' });
          }
        } else if (entry.isFile()) {
          filteredEntries.push({ name: entry.name, type: 'file' });
        }
      }

      const totalEntries = filteredEntries.length;
      const isTruncated = totalEntries > offset + maxEntries;
      const pagedEntries = filteredEntries.slice(offset, offset + maxEntries);

      return {
        path: rawPath,
        entries: pagedEntries,
        totalEntries,
        returnedEntries: pagedEntries.length,
        offset,
        isTruncated,
        notice: isTruncated
          ? `[DIRECTORY LISTING CAPPED]: Thư mục "${rawPath}" có ${totalEntries} mục. Đang hiển thị ${pagedEntries.length} mục (từ vị trí ${offset}). Truyền thêm offset=${offset + maxEntries} để xem các mục tiếp theo.`
          : undefined,
      };
    } catch (err: any) {
      return {
        path: rawPath,
        error: `Không thể liệt kê thư mục: ${err.message}`,
        errorCode: 'LIST_FILES_ERROR',
      };
    }
  },
};
