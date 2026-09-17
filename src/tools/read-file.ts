import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from '@google/genai';
import { ToolDefinition, ToolExecutionContext } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SemanticSlicer } from '../agent/semantic-slicer.js';
import { nativeBatchReadFilesAsync } from '../native/index.js';

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
  description: 'Công cụ đọc file & mã nguồn chính trong workspace, kèm contentHash để sửa code an toàn. Nếu đường dẫn là thư mục, tự động liệt kê danh sách tệp/thư mục con. Ưu tiên "symbol" để lấy đúng declaration trong 1 lượt: TypeScript/JavaScript dùng compiler AST, Python dùng ranh giới indentation. Cũng hỗ trợ startLine/endLine (hoặc offset/limit, tối đa 800 dòng), outlineOnly, và tự động cắt dòng siêu dài (>2000 ký tự) để bảo vệ context window.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file hoặc thư mục cần đọc (ví dụ: "package.json", "src/index.ts", "src")',
      },
      startLine: {
        type: Type.INTEGER,
        description: 'Dòng bắt đầu đọc (1-indexed, tuỳ chọn). Khuyến nghị đọc khoảng 150-300 dòng mỗi lần. Tối đa 800 dòng/lần gọi.',
      },
      endLine: {
        type: Type.INTEGER,
        description: 'Dòng kết thúc đọc (1-indexed, tuỳ chọn). Nếu bỏ trống trên file lớn (>350 dòng), mặc định đọc 250 dòng tiếp theo.',
      },
      offset: {
        type: Type.INTEGER,
        description: 'Alias tương thích cho startLine (1-indexed, mặc định 1).',
      },
      limit: {
        type: Type.INTEGER,
        description: 'Alias tương thích: số dòng tối đa cần đọc (mặc định 250 dòng trên file lớn, tối đa 800 dòng).',
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
  async execute(args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    if (!rawPath) {
      return { error: 'Tham số "path" là bắt buộc.' };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (context?.signal?.aborted) {
        return { path: rawPath, error: 'Đã huỷ thao tác đọc file.', errorCode: 'OPERATION_CANCELLED' };
      }

      // 1. Nếu là thư mục, tự động chuyển sang hành vi liệt kê danh sách tệp/thư mục con (Directory Listing Fallback)
      if (stat.isDirectory()) {
        return await listDirectoryFallback(safePath, rawPath);
      }

      if (!stat.isFile()) {
        return { path: rawPath, error: `Đường dẫn "${rawPath}" không phải là tệp tin hợp lệ.` };
      }

      // Kiểm tra xem LLM có truyền phạm vi cụ thể (scoped read) hay không
      const hasExplicitScope = args.startLine !== undefined
        || args.endLine !== undefined
        || args.offset !== undefined
        || args.limit !== undefined
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
          suggestion: `Hãy đọc từng phần bằng tham số "startLine" và "endLine" (hoặc "offset" và "limit"), hoặc sử dụng "outlineOnly: true" để xem cấu trúc hàm/lớp, hoặc dùng "symbol: <tên_symbol>" để chỉ trích xuất phần thân hàm/lớp bạn cần.`,
        };
      }

      let fileContent: string;
      let contentHash: string;

      // Nếu file <= 200KB, ưu tiên đọc siêu tốc qua nativeBatchReadFiles
      const canUseNativeBatch = stat.size <= 200 * 1024;
      const nativeBatch = canUseNativeBatch ? await nativeBatchReadFilesAsync(workspace.rootDir, [rawPath], 200 * 1024, context?.signal) : null;
      if (context?.signal?.aborted) {
        return { path: rawPath, error: 'Đã huỷ thao tác đọc file.', errorCode: 'OPERATION_CANCELLED' };
      }

      if (nativeBatch && nativeBatch[0] && nativeBatch[0].content !== null && nativeBatch[0].content !== undefined) {
        fileContent = nativeBatch[0].content;
        contentHash = nativeBatch[0].hash || `sha256:${createHash('sha256').update(fileContent, 'utf8').digest('hex')}`;
      } else {
        const fileBuffer = await fs.readFile(safePath);
        // Giải mã UTF-8 an toàn: tự động thay thế byte hỏng bằng \uFFFD thay vì văng lỗi crash
        const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
        fileContent = utf8Decoder.decode(fileBuffer);
        contentHash = `sha256:${createHash('sha256').update(fileBuffer).digest('hex')}`;
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
          const rawSymbolLines = sliced.code.split('\n');
          const start = sliced.startLine || 1;
          let symbolTruncatedCount = 0;
          const processedLines = rawSymbolLines.map((line) => {
            const truncated = truncateLine(line);
            if (truncated.truncated) symbolTruncatedCount++;
            return truncated.text;
          });

          const content = includeLineNumbers
            ? processedLines.map((l, i) => `${start + i}: ${l}`).join('\n')
            : processedLines.join('\n');

          return {
            path: rawPath,
            symbol: symbolName,
            startLine: sliced.startLine,
            endLine: sliced.endLine,
            linesCount: rawSymbolLines.length,
            qualifiedName: sliced.symbol?.qualifiedName,
            symbolKind: sliced.symbol?.kind,
            parser: sliced.parser,
            extractionConfidence: sliced.confidence,
            completeDeclaration: sliced.complete,
            content,
            contentHash,
            eol,
            lineNumbersIncluded: includeLineNumbers,
            hasTruncatedLines: symbolTruncatedCount > 0,
            truncatedLinesCount: symbolTruncatedCount > 0 ? symbolTruncatedCount : undefined,
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

      // 3. Chế độ đọc thông thường theo khoảng dòng (hoặc offset/limit)
      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // Hỗ trợ startLine và offset alias (1-indexed)
      const rawOffset = args.offset !== undefined ? Number(args.offset) : undefined;
      const rawStart = args.startLine !== undefined ? Number(args.startLine) : rawOffset;
      const startLine = Math.max(1, rawStart || 1);

      if (startLine > totalLines) {
        return {
          path: rawPath,
          error: `Dòng bắt đầu startLine/offset (${startLine}) vượt quá tổng số dòng của file (${totalLines}).`,
          totalLines,
        };
      }

      // Hỗ trợ limit alias và endLine
      const rawLimit = args.limit !== undefined ? Math.max(1, Number(args.limit)) : undefined;

      // Nếu file lớn (> 350 dòng) và không chỉ định bất kỳ khoảng dòng/symbol/limit nào:
      // Tự động kích hoạt Windowing 120 dòng đầu + AST Outline (SWE-agent & Cursor standard)
      const isUnscopedLargeFile = rawStart === undefined && args.endLine === undefined && rawLimit === undefined && !args.symbol && !args.outlineOnly && totalLines > 350;

      const MAX_LINE_RANGE = 800;
      let endLine: number;
      let autoWindowNotice: string | undefined;

      if (isUnscopedLargeFile) {
        endLine = Math.min(120, totalLines);
      } else if (rawLimit !== undefined) {
        const requestedLimit = Math.min(MAX_LINE_RANGE, rawLimit);
        if (args.endLine !== undefined) {
          endLine = Math.min(Number(args.endLine), startLine + requestedLimit - 1);
        } else {
          endLine = Math.min(totalLines, startLine + requestedLimit - 1);
        }
        if (rawLimit > MAX_LINE_RANGE) {
          autoWindowNotice = `[MAX_RANGE_CAPPED]: Tham số limit (${rawLimit}) vượt quá giới hạn an toàn (${MAX_LINE_RANGE} dòng). Đã tự động giới hạn xuống ${MAX_LINE_RANGE} dòng.`;
        }
      } else if (args.endLine !== undefined) {
        const requestedEndLine = Math.min(totalLines, Number(args.endLine) || totalLines);
        if (requestedEndLine - startLine + 1 > MAX_LINE_RANGE) {
          endLine = startLine + MAX_LINE_RANGE - 1;
          autoWindowNotice = `[MAX_RANGE_CAPPED]: Khoảng dòng yêu cầu vượt quá giới hạn an toàn (${MAX_LINE_RANGE} dòng). Đã tự động giới hạn từ dòng ${startLine} đến ${endLine} để chống tràn context token.`;
        } else {
          endLine = requestedEndLine;
        }
      } else if (totalLines > 350) {
        // Có startLine/offset nhưng không truyền endLine/limit trên file lớn
        endLine = Math.min(totalLines, startLine + 249);
        autoWindowNotice = `[AUTO_WINDOW_APPLIED]: Do không chỉ định endLine hoặc limit trên file lớn (${totalLines} dòng), hệ thống tự động đọc 250 dòng (L${startLine}-L${endLine}) để bảo vệ context window.`;
      } else {
        endLine = totalLines;
      }

      const selectedLines = lines.slice(startLine - 1, endLine);
      let rangeTruncatedCount = 0;
      const processedLines = selectedLines.map((line) => {
        const truncated = truncateLine(line);
        if (truncated.truncated) rangeTruncatedCount++;
        return truncated.text;
      });

      const content = includeLineNumbers
        ? processedLines.map((line, idx) => `${startLine + idx}: ${line}`).join('\n')
        : processedLines.join('\n');

      const outline = isUnscopedLargeFile
        ? SemanticSlicer.extractOutline(rawPath, fileContent)
        : undefined;

      const hasMore = endLine < totalLines;
      let nextPage: { startLine: number; endLine: number; offset: number; limit: number } | undefined;
      let paginationSuggestion: string | undefined;

      if (hasMore) {
        const nextStart = endLine + 1;
        const pageSize = Math.min(MAX_LINE_RANGE, endLine - startLine + 1);
        const nextEnd = Math.min(totalLines, nextStart + pageSize - 1);
        nextPage = {
          startLine: nextStart,
          endLine: nextEnd,
          offset: nextStart,
          limit: nextEnd - nextStart + 1,
        };
        paginationSuggestion = `Để đọc tiếp phần kế tiếp (từ dòng ${nextStart} đến ${nextEnd}), hãy gọi: read_file(path="${rawPath}", startLine=${nextStart}, endLine=${nextEnd})`;
      }

      return {
        path: rawPath,
        content,
        totalLines,
        startLine,
        endLine,
        linesCount: selectedLines.length,
        hasMore,
        nextPage,
        paginationSuggestion,
        hasTruncatedLines: rangeTruncatedCount > 0,
        truncatedLinesCount: rangeTruncatedCount > 0 ? rangeTruncatedCount : undefined,
        contentHash,
        eol,
        lineNumbersIncluded: includeLineNumbers,
        isTruncated: isUnscopedLargeFile || hasMore,
        symbolsCount: outline?.symbols?.length,
        outline: outline?.symbols?.slice(0, 30),
        notice: isUnscopedLargeFile
          ? `[WINDOWED FILE VIEW]: File "${rawPath}" có ${totalLines} dòng (> 350). 120 dòng đầu tiên và AST Symbol Outline được hiển thị để bảo vệ context window. Để đọc các đoạn khác, hãy truyền startLine/endLine hoặc symbol.`
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

/**
 * Ngưỡng độ dài tối đa cho mỗi dòng đơn lẻ (2000 ký tự).
 * Ngăn chặn tình trạng 1 dòng nén (minified code, base64, SVG) làm nổ context window của LLM.
 */
const MAX_LINE_CHARS = 2000;

function truncateLine(line: string, maxChars = MAX_LINE_CHARS): { text: string; truncated: boolean; originalLength: number } {
  if (line.length <= maxChars) {
    return { text: line, truncated: false, originalLength: line.length };
  }
  const truncatedChars = line.length - maxChars;
  return {
    text: `${line.slice(0, maxChars)}... [truncated ${truncatedChars} chars]`,
    truncated: true,
    originalLength: line.length,
  };
}

/**
 * Directory Listing Fallback:
 * Khi người dùng hoặc LLM gọi nhầm read_file vào một thư mục thay vì tệp tin,
 * tool tự động hiển thị danh sách các tệp và thư mục con thay vì báo lỗi cứng.
 */
async function listDirectoryFallback(safePath: string, rawPath: string): Promise<Record<string, any>> {
  try {
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    // Sắp xếp: Thư mục lên trước, theo thứ tự bảng chữ cái
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const MAX_DIR_ENTRIES = 100;
    const isCapped = sorted.length > MAX_DIR_ENTRIES;
    const displayEntries = isCapped ? sorted.slice(0, MAX_DIR_ENTRIES) : sorted;

    const formattedList = displayEntries
      .map((e) => {
        const prefix = e.isDirectory() ? '[DIR] ' : '[FILE]';
        return `${prefix} ${e.name}`;
      })
      .join('\n');

    const cleanPath = rawPath.replace(/\\/g, '/');
    return {
      path: cleanPath,
      isDirectory: true,
      totalEntries: sorted.length,
      displayedEntries: displayEntries.length,
      entries: displayEntries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      })),
      content: `Directory listing for "${cleanPath}":\n${formattedList}${isCapped ? `\n\n... và ${sorted.length - MAX_DIR_ENTRIES} mục khác. Hãy chỉ định đường dẫn thư mục con cụ thể.` : ''}`,
      notice: `[DIRECTORY_FALLBACK]: "${cleanPath}" là thư mục, không phải tệp tin. Tool đã tự động chuyển sang liệt kê danh sách tệp con để bạn dễ dàng định hướng tệp cần đọc.`,
      suggestion: `Hãy chọn một tệp từ danh sách trên và gọi lại read_file với path="${cleanPath.replace(/\/$/, '')}/<tên_tệp>".`,
    };
  } catch (err: any) {
    return {
      path: rawPath,
      isDirectory: true,
      error: `Không thể đọc nội dung thư mục "${rawPath}": ${err.message}`,
      errorCode: 'DIR_READ_ERROR',
    };
  }
}

async function findSimilarFiles(rawPath: string, workspace: Workspace): Promise<string[]> {
  try {
    const parentDir = path.dirname(rawPath);
    const baseName = path.basename(rawPath).toLowerCase().replace(/\.[^.]+$/, '');
    const ext = path.extname(rawPath).toLowerCase();
    const safeParent = workspace.resolveSafePath(parentDir || '.');

    const entries = await fs.readdir(safeParent, { withFileTypes: true });
    const nameMatches: string[] = [];
    const extMatches: string[] = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        const entryClean = entry.name.toLowerCase().replace(/\.[^.]+$/, '');
        const entryExt = path.extname(entry.name).toLowerCase();
        const formattedCandidate = path.join(parentDir, entry.name).replace(/\\/g, '/');

        if (entryClean.includes(baseName) || baseName.includes(entryClean)) {
          nameMatches.push(formattedCandidate);
        } else if (ext && entryExt === ext) {
          extMatches.push(formattedCandidate);
        }
      }
    }

    // Ưu tiên ứng viên khớp mờ tên file lên đầu, sau đó mới bổ sung file cùng extension
    const combined = [...nameMatches, ...extMatches];
    return combined.slice(0, 5);
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
