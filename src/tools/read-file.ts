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
  description: 'Primary workspace file reader, returning a contentHash for safe edits. Choose scope before reading: (1) Known declaration: use symbol; omit line boundaries. (2) Known location from search, a stack trace, or outline: supply both startLine and endLine (or offset and limit), covering only the relevant block and nearby context. (3) Unknown location in a large/unknown file: use outlineOnly or search first; do not read every page to locate code. (4) Omit scope only for a small file whose entire content is needed, a directory listing, or an initial bounded preview. hasMore is availability metadata, not an instruction to read the whole file. Stop once evidence is sufficient; reuse already-read content. Line reads allow up to 800 lines; lines over 2,000 characters are truncated. Unscoped files over 350 lines or 200KB return a 120-line preview plus outline. TS/JS symbol extraction uses the compiler AST; Python uses indentation boundaries.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Workspace-relative path to the file or directory to read (for example, "package.json", "src/index.ts", or "src").',
      },
      startLine: {
        type: Type.INTEGER,
        description: 'Optional 1-based inclusive starting line. For a known code location, pair with endLine to bound the relevant block; prefer a focused range, not startLine=1 by habit. Omit with symbol, outlineOnly, directory listings, or a small file needed in full. Maximum 800 lines per call.',
      },
      endLine: {
        type: Type.INTEGER,
        description: 'Optional 1-based inclusive ending line. Pair with startLine when reading a known location; select only the relevant block and nearby context. startLine alone defaults to 250 lines on files over 350 lines, but may read to EOF on smaller files. Omit with symbol or outlineOnly.',
      },
      offset: {
        type: Type.INTEGER,
        description: 'Compatibility alias for startLine (1-based). Pair with limit for a bounded read; do not mix alias pairs unnecessarily.',
      },
      limit: {
        type: Type.INTEGER,
        description: 'Number of lines to read, paired with offset (or startLine) as an alternative to startLine/endLine. Read only the needed block; maximum 800 lines.',
      },
      outlineOnly: {
        type: Type.BOOLEAN,
        description: 'Use when the target location is unknown: return declarations with line numbers without their bodies. Then choose symbol or a focused startLine/endLine range. Omit startLine and endLine in this mode; works for files larger than 200KB.',
      },
      symbol: {
        type: Type.STRING,
        description: 'Prefer when the declaration name is known: simple name ("runQueryPipeline") or qualified name ("AgentLoop.runInternal"). Omit startLine and endLine in this mode. TS/JS uses the compiler AST; Python uses indentation. Ambiguous names return qualified names for recovery.',
      },
      includeLineNumbers: {
        type: Type.BOOLEAN,
        description: 'Defaults to true. Set to false when copying unmodified content into replace_text oldText.',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    if (!rawPath) {
      return { error: 'The "path" parameter is required.' };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (context?.signal?.aborted) {
        return { path: rawPath, error: 'File read operation cancelled.', errorCode: 'OPERATION_CANCELLED' };
      }

      // 1. Nếu là thư mục, tự động chuyển sang hành vi liệt kê danh sách tệp/thư mục con (Directory Listing Fallback)
      if (stat.isDirectory()) {
        return await listDirectoryFallback(safePath, rawPath);
      }

      if (!stat.isFile()) {
        return { path: rawPath, error: `Path "${rawPath}" is not a valid file.` };
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
          error: `File too large (${Math.round(stat.size / (1024 * 1024))}MB > 10MB). Cannot open directly with read_file.`,
          errorCode: 'FILE_EXCEEDS_SYSTEM_LIMIT',
          fileSizeBytes: stat.size,
          suggestion: 'Use run_command with CLI utilities like ripgrep, head, tail or sed to extract data from this oversized file.',
        };
      }

      // File >200KB đọc unscoped: tự động hạ cấp sang windowed view (120 dòng đầu
      // + AST outline) thay vì báo lỗi cứng — tiết kiệm 1 round-trip retry của model.
      const forceAutoWindow = !hasExplicitScope && stat.size > 200 * 1024;

      let fileContent: string;
      let contentHash: string;

      // Nếu file <= 200KB, ưu tiên đọc siêu tốc qua nativeBatchReadFiles
      const canUseNativeBatch = stat.size <= 200 * 1024;
      const nativeBatch = canUseNativeBatch ? await nativeBatchReadFilesAsync(workspace.rootDir, [rawPath], 200 * 1024, context?.signal) : null;
      if (context?.signal?.aborted) {
        return { path: rawPath, error: 'File read operation cancelled.', errorCode: 'OPERATION_CANCELLED' };
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
            ? `[OUTLINE CAPPED]: File has ${outline.symbols.length} symbols. Display limited to the first ${MAX_OUTLINE_SYMBOLS} symbols to optimize context tokens.`
            : undefined,
          contentHash,
          eol,
          readScopeGuidance: 'Choose a relevant symbol from this outline, or pass both startLine and endLine around the target location. Do not read every declaration or page; stop when evidence is sufficient.',
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
            readScopeGuidance: sliced.complete
              ? 'Complete declaration returned. No additional line range is needed unless relevant surrounding context is missing; reuse this content.'
              : 'Declaration may be incomplete. Read only missing context with both startLine and endLine, or refine the symbol name.',
          };
        } else {
          // Khi không tìm thấy symbol, trích xuất outline để gợi ý các symbol khả dụng cho LLM tự phục hồi (Tool Design Error Recovery)
          const outline = SemanticSlicer.extractOutline(rawPath, fileContent);
          const availableSymbols = outline.symbols.slice(0, 25).map((s) => `${s.kind} ${s.qualifiedName || s.name} (L${s.startLine})`);
          return {
            path: rawPath,
            warning: sliced.ambiguousMatches?.length
              ? `Symbol "${symbolName}" is ambiguous in file "${rawPath}". Use a qualifiedName.`
              : `Symbol "${symbolName}" not found in file "${rawPath}".`,
            parser: sliced.parser,
            extractionConfidence: sliced.confidence,
            ambiguousMatches: sliced.ambiguousMatches,
            totalSymbolsFound: outline.symbols.length,
            availableSymbolsSample: availableSymbols,
            suggestion: sliced.ambiguousMatches?.length
              ? 'Call again with a qualifiedName from ambiguousMatches.'
              : 'Use one of the available symbols above, or use "outlineOnly: true" or "startLine/endLine" to read.',
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
          error: `Start line startLine/offset (${startLine}) exceeds the total line count of the file (${totalLines}).`,
          totalLines,
        };
      }

      // Hỗ trợ limit alias và endLine
      const rawLimit = args.limit !== undefined ? Math.max(1, Number(args.limit)) : undefined;

      // Nếu file lớn (> 350 dòng) và không chỉ định bất kỳ khoảng dòng/symbol/limit nào:
      // Tự động kích hoạt Windowing 120 dòng đầu + AST Outline (SWE-agent & Cursor standard).
      // File >200KB đọc unscoped cũng đi chung đường này (forceAutoWindow) kể cả khi ít dòng.
      const isUnscopedLargeFile = rawStart === undefined && args.endLine === undefined && rawLimit === undefined && !args.symbol && !args.outlineOnly && (totalLines > 350 || forceAutoWindow);

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
          autoWindowNotice = `[MAX_RANGE_CAPPED]: limit parameter (${rawLimit}) exceeds the safe limit (${MAX_LINE_RANGE} lines). Automatically capped to ${MAX_LINE_RANGE} lines.`;
        }
      } else if (args.endLine !== undefined) {
        const requestedEndLine = Math.min(totalLines, Number(args.endLine) || totalLines);
        if (requestedEndLine - startLine + 1 > MAX_LINE_RANGE) {
          endLine = startLine + MAX_LINE_RANGE - 1;
          autoWindowNotice = `[MAX_RANGE_CAPPED]: Requested line range exceeds the safe limit (${MAX_LINE_RANGE} lines). Automatically capped from line ${startLine} to ${endLine} to prevent context-token overflow.`;
        } else {
          endLine = requestedEndLine;
        }
      } else if (totalLines > 350) {
        // Có startLine/offset nhưng không truyền endLine/limit trên file lớn
        endLine = Math.min(totalLines, startLine + 249);
        autoWindowNotice = `[AUTO_WINDOW_APPLIED]: Since endLine or limit was not specified on a large file (${totalLines} lines), the system automatically reads 250 lines (L${startLine}-L${endLine}) to protect the context window.`;
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
        paginationSuggestion = `Only if the next part is needed for the task, call: read_file(path="${rawPath}", startLine=${nextStart}, endLine=${nextEnd}). Otherwise stop or jump directly to the relevant symbol/range; hasMore does not require reading to EOF.`;
      }

      // Carried by the existing harness advisory channel; never rejects a read
      // or changes the model-facing stable system-prompt prefix per step.
      const hasRangeStart = args.startLine !== undefined || args.offset !== undefined;
      const hasRangeEnd = args.endLine !== undefined || args.limit !== undefined;
      const needsScopeAdvisory = isUnscopedLargeFile || hasRangeStart !== hasRangeEnd;
      const scopeAdvisory = '[STRONG ADVISORY — READ SCOPE (non-blocking, tool still executes)]: '
        + (isUnscopedLargeFile ? 'This is a preview, not the full file. ' : 'Only one line-range boundary was supplied. ')
        + 'For a known location, pass both startLine and endLine (or offset and limit) around the relevant block. '
        + 'For a known declaration, use symbol without line boundaries; for an unknown location, use outlineOnly or search first. '
        + 'Omit scope only for a small file needed in full, a directory listing, or an initial bounded preview. '
        + 'Do not read all pages merely because hasMore is true; stop once evidence is sufficient.';

      return {
        path: rawPath,
        content,
        totalLines,
        startLine,
        endLine,
        linesCount: selectedLines.length,
        hasMore,
        nextStartLine: nextPage?.startLine,
        nextPage,
        paginationSuggestion,
        readScopeGuidance: hasMore || hasRangeStart || hasRangeEnd || isUnscopedLargeFile
          ? 'Stop when evidence is sufficient. Read another focused symbol/range only if relevant context is still missing; hasMore does not mean read every page.'
          : 'A small file was returned in full. Omit line boundaries only when the whole file is needed; otherwise prefer symbol or both startLine and endLine.',
        _guardian_warnings: needsScopeAdvisory ? [scopeAdvisory] : undefined,
        hasTruncatedLines: rangeTruncatedCount > 0,
        truncatedLinesCount: rangeTruncatedCount > 0 ? rangeTruncatedCount : undefined,
        contentHash,
        eol,
        lineNumbersIncluded: includeLineNumbers,
        isTruncated: isUnscopedLargeFile || hasMore,
        symbolsCount: outline?.symbols?.length,
        outline: outline?.symbols?.slice(0, 30),
        notice: isUnscopedLargeFile
          ? (forceAutoWindow && totalLines <= 350
            ? `[AUTO_DEGRADED VIEW]: File "${rawPath}" is ${Math.round(stat.size / 1024)}KB (> 200KB full-read budget). Showing the first ${endLine} lines and AST Symbol Outline instead of full content to protect the context window. To read other sections, pass startLine/endLine, symbol, or outlineOnly.`
            : `[WINDOWED FILE VIEW]: File "${rawPath}" has ${totalLines} lines (> 350). The first 120 lines and AST Symbol Outline are shown to protect the context window. To read other sections, pass startLine/endLine or symbol.`)
          : autoWindowNotice,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT' || String(err.message).includes('ENOENT')) {
        const nearbySuggestions = await findSimilarFiles(rawPath, workspace);
        const workspaceSuggestions = await workspace.findSimilarWorkspaceFiles(rawPath, 5);
        const suggestions = Array.from(new Set([...nearbySuggestions, ...workspaceSuggestions]));
        return {
          path: rawPath,
          error: `File "${rawPath}" was not found. (ENOENT: no such file or directory)`,
          errorCode: 'FILE_NOT_FOUND',
          suggestions: suggestions.length > 0 ? suggestions : undefined,
          suggestionText: suggestions.length > 0
            ? `File does not exist. Available files in workspace: ${suggestions.join(', ')}`
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
      content: `Directory listing for "${cleanPath}":\n${formattedList}${isCapped ? `\n\n... and ${sorted.length - MAX_DIR_ENTRIES} more entries. Specify a concrete subdirectory path.` : ''}`,
      notice: `[DIRECTORY_FALLBACK]: "${cleanPath}" is a directory, not a file. The tool automatically switched to listing child files to help you locate the file to read.`,
      suggestion: `Pick a file from the list above and call read_file again with path="${cleanPath.replace(/\/$/, '')}/<file_name>".`,
    };
  } catch (err: any) {
    return {
      path: rawPath,
      isDirectory: true,
      error: `Failed to read directory contents of "${rawPath}": ${err.message}`,
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
