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
  description: 'Liệt kê danh sách các tệp tin và thư mục con trong một thư mục thuộc workspace.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới thư mục cần xem (ví dụ: "." hoặc "src")',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '.');

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (!stat.isDirectory()) {
        return { path: rawPath, error: `Đường dẫn "${rawPath}" không phải là thư mục.` };
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

      return {
        path: rawPath,
        entries: filteredEntries,
      };
    } catch (err: any) {
      return {
        path: rawPath,
        error: `Không thể liệt kê thư mục: ${err.message}`,
      };
    }
  },
};
