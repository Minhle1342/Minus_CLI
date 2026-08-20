import fs from 'node:fs/promises';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * Tool 1: read_file
 * Đọc nội dung văn bản của một file trong workspace (hỗ trợ đọc theo khoảng dòng startLine/endLine).
 */
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Đọc nội dung văn bản của một file trong workspace. Hỗ trợ đọc toàn bộ hoặc theo khoảng dòng chỉ định (1-indexed).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file cần đọc (ví dụ: "package.json" hoặc "src/index.ts")',
      },
      startLine: {
        type: Type.INTEGER,
        description: 'Dòng bắt đầu đọc (1-indexed, tuỳ chọn)',
      },
      endLine: {
        type: Type.INTEGER,
        description: 'Dòng kết thúc đọc (1-indexed, tuỳ chọn)',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '');
    if (!rawPath) {
      return { error: 'Tham số "path" là bắt buộc.' };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (!stat.isFile()) {
        return { path: rawPath, error: `Đường dẫn "${rawPath}" là thư mục, không phải file.` };
      }

      // Giới hạn kích thước file đọc để tránh tràn context LLM (tối đa 100KB)
      if (stat.size > 100 * 1024) {
        return { path: rawPath, error: `File quá lớn (${stat.size} bytes). Giới hạn tối đa là 100KB.` };
      }

      const fileContent = await fs.readFile(safePath, 'utf-8');
      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      const startLine = Math.max(1, Number(args.startLine) || 1);
      const endLine = Math.min(totalLines, Number(args.endLine) || totalLines);

      if (startLine > totalLines) {
        return {
          path: rawPath,
          error: `startLine (${startLine}) vượt quá tổng số dòng của file (${totalLines}).`,
        };
      }

      const selectedLines = lines.slice(startLine - 1, endLine);
      const numberedContent = selectedLines
        .map((line, idx) => `${startLine + idx}: ${line}`)
        .join('\n');

      return {
        path: rawPath,
        content: numberedContent,
        totalLines,
        startLine,
        endLine,
      };
    } catch (err: any) {
      return {
        path: rawPath,
        error: `Không thể đọc file: ${err.message}`,
      };
    }
  },
};
