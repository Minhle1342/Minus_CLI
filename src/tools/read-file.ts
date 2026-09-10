import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';
import { nativeBatchReadFiles } from '../native/index.js';

/**
 * Tool 1: read_file (Phase 3 - parser-aware semantic slicing)
 * Đọc nội dung văn bản của một file trong workspace.
 * Hỗ trợ:
 * 1. Đọc toàn bộ hoặc theo khoảng dòng startLine/endLine.
 * 2. Đọc lướt Outline ngữ nghĩa (outlineOnly: true) để trích xuất hàm/lớp mà không tốn token.
 * 3. Trích xuất chính xác theo tên symbol (hàm/lớp/interface).
 */
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Công cụ đọc file & mã nguồn chính trong workspace, kèm contentHash để sửa code an toàn. Ưu tiên "symbol" để lấy đúng declaration trong 1 lượt: TypeScript/JavaScript dùng compiler AST, Python dùng ranh giới indentation; định dạng khác trả parser/confidence để nhận diện fallback heuristic. Cũng hỗ trợ startLine/endLine (tối đa 800 dòng) và outlineOnly để bảo vệ context window.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file cần đọc (ví dụ: "package.json", "src/index.ts", "src/test-suite.ts")',
      },
      startLine: {
        type: Type.INTEGER,
        description: 'Dòng bắt đầu đọc (1-indexed, tuỳ chọn). Khuyến nghị đọc khoảng 150-300 dòng mỗi lần. Tối đa 800 dòng/lần gọi để bảo vệ context token.',
      },
      endLine: {
        type: Type.INTEGER,
        description: 'Dòng kết thúc đọc (1-indexed, tuỳ chọn). Nếu bỏ trống trên file lớn (>350 dòng), mặc định đọc 250 dòng tiếp theo.',
      },
      outlineOnly: {
        type: Type.BOOLEAN,
        description: 'Nếu true, chỉ trả về sơ đồ Outline các hàm, lớp, interface kèm số dòng để tiết kiệm token (hoạt động tốt trên cả file lớn > 200KB).',
      },
      symbol: {
        type: Type.STRING,
        description: 'ƯU TIÊN DÙNG khi đã biết symbol: tên đơn ("runQueryPipeline") hoặc tên định danh ("AgentLoop.runInternal"). TS/JS dùng compiler AST; Python dùng indentation parser. Nếu tên đơn trùng nhau, tool trả danh sách qualifiedName để tự phục hồi.',
      },
      includeLineNumbers: {
        type: Type.BOOLEAN,
        description: 'Mặc định true. Đặt false khi cần sao chép content nguyên bản vào oldText của replace_text.',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    if (!rawPath) {
      return { error: 'Tham số "path" là bắt buộc.' };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (!stat.isFile()) {
        return { path: rawPath, error: `Đường dẫn "${rawPath}" là thư mục, không phải file.` };
      }

      // Kiểm tra xem LLM có truyền phạm vi cụ thể (scoped read) hay không
      const hasExplicitScope = args.startLine !== undefined
        || args.endLine !== undefined
        || Boolean(args.symbol)
        || Boolean(args.outlineOnly);

      // Ngưỡng cứng tuyệt đối 10MB để bảo vệ bộ nhớ hệ thống (tránh OOM đối với file nhị phân / log khổng lồ)
      const MAX_SYSTEM_FILE_SIZE = 10 * 1024 * 1024;
      if (stat.size > MAX_SYSTEM_FILE_SIZE) {
        return {
          path: rawPath,
          error: `File quá lớn (${Math.round(stat.size / (1024 * 1024))}MB > 10MB). Không thể mở trực tiếp bằng read_file.`,
          errorCode: 'FILE_EXCEEDS_SYSTEM_LIMIT',
          fileSizeBytes: stat.size,
          suggestion: 'Hãy sử dụng run_command với các tiện ích CLI như ripgrep, head, tail hoặc sed để trích xuất dữ liệu từ file ngoại cỡ này.',
        };
      }

      // Giới hạn kích thước khi đọc TOÀN BỘ file mà không chỉ định phạm vi (unscoped read) để chống tràn context token LLM (tối đa 200KB)
      if (!hasExplicitScope && stat.size > 200 * 1024) {
        return {
          path: rawPath,
          error: `File quá lớn (${Math.round(stat.size / 1024)}KB). Giới hạn tối đa mỗi lần đọc toàn bộ là 200KB để chống tràn context token.`,
          errorCode: 'FILE_TOO_LARGE',
          fileSizeBytes: stat.size,
          suggestion: `Hãy đọc từng phần bằng tham số "startLine" và "endLine" (ví dụ: startLine: 1, endLine: 200), hoặc sử dụng "outlineOnly: true" để xem cấu trúc hàm/lớp, hoặc dùng "symbol: <tên_symbol>" để chỉ trích xuất phần thân hàm/lớp bạn cần.`,
        };
      }

      let fileContent: string;
      let contentHash: string;

      // Nếu file <= 200KB, ưu tiên đọc siêu tốc qua nativeBatchReadFiles
      const canUseNativeBatch = stat.size <= 200 * 1024;
      const nativeBatch = canUseNativeBatch ? nativeBatchReadFiles(workspace.rootDir, [rawPath], 200 * 1024) : null;
      if (nativeBatch && nativeBatch[0] && nativeBatch[0].content !== null && nativeBatch[0].content !== undefined) {
        fileContent = nativeBatch[0].content;
        contentHash = nativeBatch[0].hash || `sha256:${createHash('sha256').update(fileContent, 'utf8').digest('hex')}`;
      } else {
        fileContent = await fs.readFile(safePath, 'utf-8');
        contentHash = `sha256:${createHash('sha256').update(fileContent, 'utf8').digest('hex')}`;
      }
      const eol = detectEol(fileContent);
      const includeLineNumbers = args.includeLineNumbers !== false;

      // 1. Chế độ Outline Only (AST Semantic Outline)
      if (args.outlineOnly) {
        const outline = SemanticSlicer.extractOutline(rawPath, fileContent);
        const MAX_OUTLINE_SYMBOLS = 100;
        const isCapped = outline.symbols.length > MAX_OUTLINE_SYMBOLS;
        const symbols = isCapped ? outline.symbols.slice(0, MAX_OUTLINE_SYMBOLS) : outline.symbols;
        return {
          path: rawPath,
          totalLines: outline.totalLines,
          symbolsCount: outline.symbols.length,
          summary: outline.summary,
          symbols,
          parser: outline.parser,
          extractionConfidence: outline.confidence,
          notice: isCapped
            ? `[OUTLINE CAPPED]: File có ${outline.symbols.length} symbols. Đã giới hạn hiển thị ${MAX_OUTLINE_SYMBOLS} symbols đầu tiên để tối ưu context token.`
            : undefined,
          contentHash,
          eol,
        };
      }

      // 2. Chế độ Symbol Extraction (Trích xuất theo tên hàm/lớp)
      if (args.symbol) {
        const symbolName = String(args.symbol).trim();
        const sliced = SemanticSlicer.sliceSymbol(fileContent, symbolName, rawPath);
        if (sliced.found && sliced.code) {
          const lines = sliced.code.split('\n');
          const start = sliced.startLine || 1;
          const content = includeLineNumbers
            ? lines.map((l, i) => `${start + i}: ${l}`).join('\n')
            : sliced.code;
          return {
            path: rawPath,
            symbol: symbolName,
            startLine: sliced.startLine,
            endLine: sliced.endLine,
            qualifiedName: sliced.symbol?.qualifiedName,
            symbolKind: sliced.symbol?.kind,
            parser: sliced.parser,
            extractionConfidence: sliced.confidence,
            completeDeclaration: sliced.complete,
            content,
            contentHash,
            eol,
            lineNumbersIncluded: includeLineNumbers,
          };
        } else {
          // Khi không tìm thấy symbol, trích xuất outline để gợi ý các symbol khả dụng cho LLM tự phục hồi (Tool Design Error Recovery)
          const outline = SemanticSlicer.extractOutline(rawPath, fileContent);
          const availableSymbols = outline.symbols.slice(0, 25).map((s) => `${s.kind} ${s.qualifiedName || s.name} (L${s.startLine})`);
          return {
            path: rawPath,
            warning: sliced.ambiguousMatches?.length
              ? `Symbol "${symbolName}" không duy nhất trong file "${rawPath}". Hãy dùng qualifiedName.`
              : `Không tìm thấy symbol "${symbolName}" trong file "${rawPath}".`,
            parser: sliced.parser,
            extractionConfidence: sliced.confidence,
            ambiguousMatches: sliced.ambiguousMatches,
            totalSymbolsFound: outline.symbols.length,
            availableSymbolsSample: availableSymbols,
            suggestion: sliced.ambiguousMatches?.length
              ? 'Gọi lại bằng một qualifiedName trong ambiguousMatches.'
              : 'Hãy sử dụng một trong các symbols khả dụng bên trên, hoặc sử dụng "outlineOnly: true" hoặc "startLine/endLine" để đọc.',
          };
        }
      }

      // 3. Chế độ đọc thông thường theo khoảng dòng
      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // Nếu file lớn (> 350 dòng) và không chỉ định khoảng dòng/symbol, tự động kích hoạt Windowing + AST Outline (SWE-agent & Cursor standard)
      const isUnscopedLargeFile = args.startLine === undefined && args.endLine === undefined && !args.symbol && !args.outlineOnly && totalLines > 350;
      const startLine = Math.max(1, Number(args.startLine) || 1);

      if (startLine > totalLines) {
        return {
          path: rawPath,
          error: `startLine (${startLine}) vượt quá tổng số dòng của file (${totalLines}).`,
        };
      }

      // Xác định endLine với các Guardrail bảo vệ context:
      // - Nếu unscoped large file: lấy 120 dòng đầu
      // - Nếu có startLine nhưng không có endLine trên file lớn (>350 dòng): tự động gán cửa sổ 250 dòng
      // - Nếu dải dòng > 800: giới hạn tối đa 800 dòng/lần gọi
      const MAX_LINE_RANGE = 800;
      let endLine: number;
      let autoWindowNotice: string | undefined;

      if (isUnscopedLargeFile) {
        endLine = Math.min(120, totalLines);
      } else if (args.endLine !== undefined) {
        const requestedEndLine = Math.min(totalLines, Number(args.endLine) || totalLines);
        if (requestedEndLine - startLine + 1 > MAX_LINE_RANGE) {
          endLine = startLine + MAX_LINE_RANGE - 1;
          autoWindowNotice = `[MAX_RANGE_CAPPED]: Khoảng dòng yêu cầu vượt quá giới hạn an toàn (${MAX_LINE_RANGE} dòng). Đã tự động giới hạn từ dòng ${startLine} đến ${endLine} để chống tràn context token.`;
        } else {
          endLine = requestedEndLine;
        }
      } else if (totalLines > 350) {
        // Có startLine nhưng không truyền endLine trên file lớn
        endLine = Math.min(totalLines, startLine + 249);
        autoWindowNotice = `[AUTO_WINDOW_APPLIED]: Do không chỉ định endLine trên file lớn (${totalLines} dòng), hệ thống tự động đọc 250 dòng (L${startLine}-L${endLine}) để bảo vệ context window.`;
      } else {
        endLine = totalLines;
      }

      const selectedLines = lines.slice(startLine - 1, endLine);
      const content = includeLineNumbers
        ? selectedLines.map((line, idx) => `${startLine + idx}: ${line}`).join('\n')
        : selectedLines.join('\n');

      const outline = isUnscopedLargeFile
        ? SemanticSlicer.extractOutline(rawPath, fileContent)
        : undefined;

      return {
        path: rawPath,
        content,
        totalLines,
        startLine,
        endLine,
        contentHash,
        eol,
        lineNumbersIncluded: includeLineNumbers,
        isTruncated: isUnscopedLargeFile,
        symbolsCount: outline?.symbols?.length,
        outline: outline?.symbols?.slice(0, 30),
        notice: isUnscopedLargeFile
          ? `[WINDOWED FILE VIEW]: File "${rawPath}" has ${totalLines} lines (> 350). Lines 1-120 and AST Symbol Outline are shown above to protect context window. To read other sections, pass startLine/endLine or symbol parameter.`
          : autoWindowNotice,
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
