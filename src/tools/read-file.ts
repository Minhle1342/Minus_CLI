import fs from 'node:fs/promises';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';

/**
 * Tool 1: read_file (Phase 3 - AST Semantic Slicing Ready)
 * Đọc nội dung văn bản của một file trong workspace.
 * Hỗ trợ:
 * 1. Đọc toàn bộ hoặc theo khoảng dòng startLine/endLine.
 * 2. Đọc lướt Outline ngữ nghĩa (outlineOnly: true) để trích xuất hàm/lớp mà không tốn token.
 * 3. Trích xuất chính xác theo tên symbol (hàm/lớp/interface).
 */
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Đọc nội dung văn bản của một file trong workspace. Hỗ trợ đọc theo khoảng dòng, trích xuất Outline ngữ nghĩa (outlineOnly: true), hoặc trích xuất theo tên hàm/lớp (symbol).',
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
      outlineOnly: {
        type: Type.BOOLEAN,
        description: 'Nếu true, chỉ trả về sơ đồ Outline các hàm, lớp, interface kèm số dòng để tiết kiệm token.',
      },
      symbol: {
        type: Type.STRING,
        description: 'Tên hàm, lớp, hoặc interface cụ thể muốn đọc phần thân (ví dụ: "AgentLoop" hoặc "createPlan")',
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

      // Giới hạn kích thước file đọc để tránh tràn context LLM (tối đa 200KB)
      if (stat.size > 200 * 1024) {
        return { path: rawPath, error: `File quá lớn (${stat.size} bytes). Giới hạn tối đa là 200KB.` };
      }

      const fileContent = await fs.readFile(safePath, 'utf-8');

      // 1. Chế độ Outline Only (AST Semantic Outline)
      if (args.outlineOnly) {
        const outline = SemanticSlicer.extractOutline(rawPath, fileContent);
        return {
          path: rawPath,
          totalLines: outline.totalLines,
          symbolsCount: outline.symbols.length,
          summary: outline.summary,
          symbols: outline.symbols,
        };
      }

      // 2. Chế độ Symbol Extraction (Trích xuất theo tên hàm/lớp)
      if (args.symbol) {
        const sliced = SemanticSlicer.sliceSymbol(fileContent, String(args.symbol).trim());
        if (sliced.found && sliced.code) {
          const lines = sliced.code.split('\n');
          const start = sliced.startLine || 1;
          const numbered = lines.map((l, i) => `${start + i}: ${l}`).join('\n');
          return {
            path: rawPath,
            symbol: args.symbol,
            startLine: sliced.startLine,
            endLine: sliced.endLine,
            content: numbered,
          };
        } else {
          return {
            path: rawPath,
            warning: `Không tìm thấy symbol "${args.symbol}" trong file. Đang trả về theo khoảng dòng bình thường.`,
          };
        }
      }

      // 3. Chế độ đọc thông thường theo khoảng dòng
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
