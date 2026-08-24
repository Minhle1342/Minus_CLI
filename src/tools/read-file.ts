import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
      includeLineNumbers: {
        type: Type.BOOLEAN,
        description: 'Mặc định true. Đặt false khi cần sao chép content nguyên bản vào oldText của replace_text.',
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
      const contentHash = `sha256:${createHash('sha256').update(fileContent, 'utf8').digest('hex')}`;
      const eol = detectEol(fileContent);
      const includeLineNumbers = args.includeLineNumbers !== false;

      // 1. Chế độ Outline Only (AST Semantic Outline)
      if (args.outlineOnly) {
        const outline = SemanticSlicer.extractOutline(rawPath, fileContent);
        return {
          path: rawPath,
          totalLines: outline.totalLines,
          symbolsCount: outline.symbols.length,
          summary: outline.summary,
          symbols: outline.symbols,
          contentHash,
          eol,
        };
      }

      // 2. Chế độ Symbol Extraction (Trích xuất theo tên hàm/lớp)
      if (args.symbol) {
        const sliced = SemanticSlicer.sliceSymbol(fileContent, String(args.symbol).trim());
        if (sliced.found && sliced.code) {
          const lines = sliced.code.split('\n');
          const start = sliced.startLine || 1;
          const content = includeLineNumbers
            ? lines.map((l, i) => `${start + i}: ${l}`).join('\n')
            : sliced.code;
          return {
            path: rawPath,
            symbol: args.symbol,
            startLine: sliced.startLine,
            endLine: sliced.endLine,
            content,
            contentHash,
            eol,
            lineNumbersIncluded: includeLineNumbers,
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
      const content = includeLineNumbers
        ? selectedLines.map((line, idx) => `${startLine + idx}: ${line}`).join('\n')
        : selectedLines.join('\n');

      return {
        path: rawPath,
        content,
        totalLines,
        startLine,
        endLine,
        contentHash,
        eol,
        lineNumbersIncluded: includeLineNumbers,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
        const suggestions = await findSimilarFiles(rawPath, workspace);
        return {
          path: rawPath,
          error: `File "${rawPath}" was not found. (ENOENT: no such file or directory)`,
          errorCode: 'FILE_NOT_FOUND',
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          suggestionText: suggestions.length > 0
            ? `File does not exist. Available files in nearby directory: ${suggestions.join(', ')}`
            : 'File does not exist. Use search_codebase_fast or list_files to locate the correct path.',
        };
      }

      return {
        path: rawPath,
        error: `Could not read file: ${err.message}`,
        errorCode: 'READ_ERROR',
      };
    }
  },
};

async function findSimilarFiles(rawPath: string, workspace: Workspace): Promise<string[]> {
  try {
    const parentDir = path.dirname(rawPath);
    const baseName = path.basename(rawPath).toLowerCase().replace(/\.[^.]+$/, '');
    const safeParent = workspace.resolveSafePath(parentDir || '.');

    const entries = await fs.readdir(safeParent, { withFileTypes: true });
    const candidates: string[] = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        const entryClean = entry.name.toLowerCase().replace(/\.[^.]+$/, '');
        if (
          entryClean.includes(baseName)
          || baseName.includes(entryClean)
          || entry.name.endsWith('.ts')
          || entry.name.endsWith('.js')
        ) {
          candidates.push(path.join(parentDir, entry.name).replace(/\\/g, '/'));
        }
      }
    }
    return candidates.slice(0, 5);
  } catch {
    return [];
  }
}

function detectEol(content: string): 'crlf' | 'lf' | 'mixed' | 'none' {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}
