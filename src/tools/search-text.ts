import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Type } from "@google/genai";
import { ToolDefinition } from "./types.js";
import { Workspace } from "../workspace/workspace.js";
import {
  executeRipgrepEmulation,
  type RgParsedOptions,
} from "./rg-emulator.js";

const execFileAsync = promisify(execFile);

export interface MatchItem {
  file: string;
  line: number;
  text: string;
}

export interface FileMatchSummary {
  file: string;
  matchCount: number;
}

// Cache kiểm tra sự tồn tại của tiện ích Ripgrep (rg) trên môi trường
let isRgAvailableCache: boolean | null = null;

async function checkRipgrepAvailable(): Promise<boolean> {
  if (isRgAvailableCache !== null) {
    return isRgAvailableCache;
  }
  try {
    await execFileAsync("rg", ["--version"], { timeout: 2000 });
    isRgAvailableCache = true;
  } catch {
    isRgAvailableCache = false;
  }
  return isRgAvailableCache;
}

/**
 * Tool: search_text (Grep & Regex Hybrid Search Tool)
 *
 * Tìm kiếm nội dung bên trong các tệp tin bằng Biểu thức chính quy (Regex) hoặc chuỗi văn bản.
 * Hoạt động theo cơ chế Hybrid 3 tầng:
 * 1. Ưu tiên Ripgrep (rg) nếu có sẵn trên hệ điều hành (siêu nhanh, tôn trọng .gitignore).
 * 2. Rust Native Ripgrep Core (nếu có native addon).
 * 3. Pure-TypeScript Fallback (chạy đệ quy thuần Node.js, bỏ qua thư mục rác, không sợ thiếu binary).
 *
 * Hỗ trợ:
 * - Regex pattern hoặc plain string
 * - Glob filter (ví dụ: *.ts, *.py)
 * - Output mode: 'content' (dòng chi tiết path:line:text), 'files_with_matches', 'count'
 * - Giới hạn an toàn maxMatches (mặc định 50, trần 200) chống ngộ độc context window.
 */
export const searchTextTool: ToolDefinition = {
  name: "search_text",
  description:
    "Search file contents with Regular Expressions (Regex) or plain text via a Hybrid engine (native Ripgrep + TypeScript fallback). Automatically skips junk directories (node_modules, .git, dist) and caps GLOBAL results to protect context tokens.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          'Regular Expression (Regex) or plain text to search for. Examples: "function\\s+\\w+", "TODO:", "export\\s+class".',
      },
      path: {
        type: Type.STRING,
        description:
          'Specific directory or file to search (default: "." scans the whole workspace).',
      },
      isRegex: {
        type: Type.BOOLEAN,
        description:
          "If true (default), treat the query as a Regular Expression. If false, search for the exact literal string.",
      },
      include: {
        type: Type.STRING,
        description:
          'Glob file-format filter (e.g. "*.ts", "*.py", "*.json").',
      },
      caseSensitive: {
        type: Type.BOOLEAN,
        description:
          "If true, match case-sensitively. Default false (case-insensitive).",
      },
      wordMatch: {
        type: Type.BOOLEAN,
        description:
          "If true, match whole words only (equivalent to \\b...\\b or the -w flag in ripgrep). Default false.",
      },
      outputMode: {
        type: Type.STRING,
        enum: ["content", "files_with_matches", "count"],
        description:
          'Return mode: "content" (detailed matching lines path:line:text), "files_with_matches" (file list only), or "count" (match count). Default: "content".',
      },
      maxMatches: {
        type: Type.INTEGER,
        description:
          "Maximum number of TOTAL results returned in one page (default: 50, max: 200).",
      },
      offset: {
        type: Type.INTEGER,
        description:
          "Pagination offset (0-indexed). Use with maxMatches to page through results when truncated=true or hasMore=true without missing matches. Default: 0.",
      },
      perFileLimit: {
        type: Type.INTEGER,
        description:
          "Diversity budget: maximum matches to return from any single file in this page. When total matches exceed maxMatches, prevents test or mock files from crowding out production code. Default: 3 when totalMatches > maxMatches, or 0 for unlimited.",
      },
    },
    required: ["query"],
  },
  async execute(
    args: Record<string, any>,
    workspace: Workspace,
  ): Promise<Record<string, any>> {
    const rawQuery = String(args.query || "").trim();
    const rawPath = String(args.path || ".").trim();
    const isRegex = args.isRegex !== false;
    const includeGlob = args.include ? String(args.include).trim() : undefined;
    const caseSensitive = args.caseSensitive === true;
    const wordMatch = args.wordMatch === true;
    const outputMode = args.outputMode || "content";
    const HARD_LIMIT = 200;
    const maxMatches = Math.min(
      HARD_LIMIT,
      Math.max(1, Number(args.maxMatches) || 50),
    );
    const offset = Math.max(0, Number(args.offset) || 0);
    const perFileLimit = args.perFileLimit !== undefined
      ? Math.max(0, Number(args.perFileLimit) || 0)
      : undefined;

    if (!rawQuery) {
      return {
        error: 'The "query" parameter must not be empty.',
        errorCode: "INVALID_ARGS",
      };
    }

    // Kiểm tra đường dẫn tồn tại trước khi tìm
    try {
      workspace.resolveSafePath(rawPath);
    } catch (err: any) {
      return {
        error: `Path "${rawPath}" is outside the valid workspace scope.`,
        errorCode: "PATH_OUT_OF_BOUNDS",
      };
    }

    // Xác định trần --max-count cho từng file để tối ưu I/O đĩa
    // Nếu caller chỉ định perFileLimit > 0: dùng trực tiếp perFileLimit
    // Nếu outputMode === 'content': giới hạn tối đa an toàn để tránh file khổng lồ làm nghẽn tiến trình rg
    const effectivePerFileMaxCount = perFileLimit !== undefined && perFileLimit > 0
      ? perFileLimit
      : (outputMode === "content" ? Math.max(100, (offset + maxMatches) * 2) : undefined);

    const options: RgParsedOptions = {
      query: rawQuery,
      isRegex,
      ignoreCase: !caseSensitive,
      invertMatch: false,
      wordRegexp: wordMatch,
      filesWithMatchesOnly: outputMode === "files_with_matches",
      countOnly: outputMode === "count",
      showLineNumbers: true,
      maxCountPerFile: effectivePerFileMaxCount,
      maxTotalMatches: Math.max(2000, (offset + maxMatches) * 4),
      globFilter: includeGlob ? [includeGlob] : undefined,
      targetPaths: [rawPath],
    };

    let engineUsed: "ripgrep-binary" | "typescript-emulator" =
      "typescript-emulator";
    let rawStdout = "";
    let totalMatchCount = 0;

    // 1. Thử nghiệm chạy với Ripgrep CLI native trên hệ thống nếu khả dụng
    const rgAvailable = await checkRipgrepAvailable();
    if (rgAvailable) {
      try {
        const rgArgs: string[] = [
          "--line-number",
          "--with-filename",
          "--no-heading",
          "--color",
          "never",
        ];
        if (!caseSensitive) rgArgs.push("--ignore-case");
        if (wordMatch) rgArgs.push("--word-regexp");
        if (!isRegex) rgArgs.push("--fixed-strings");
        if (includeGlob) rgArgs.push("--glob", includeGlob);
        if (outputMode === "files_with_matches")
          rgArgs.push("--files-with-matches");
        if (outputMode === "count") rgArgs.push("--count");
        if (effectivePerFileMaxCount !== undefined)
          rgArgs.push("--max-count", String(effectivePerFileMaxCount));
        rgArgs.push(rawQuery);
        rgArgs.push(rawPath);

        const { stdout } = await execFileAsync("rg", rgArgs, {
          cwd: workspace.rootDir,
          timeout: 8000,
          maxBuffer: 5 * 1024 * 1024,
        });

        rawStdout = stdout.trim();
        engineUsed = "ripgrep-binary";
      } catch (err: any) {
        // Exit code 1 của ripgrep đơn giản là không tìm thấy kết quả (No matches found)
        if (err.code === 1) {
          rawStdout = "";
          engineUsed = "ripgrep-binary";
        } else {
          // Lỗi cú pháp regex hoặc lỗi khác -> Tự động fallback sang TypeScript Emulator
          rawStdout = "";
        }
      }
    }

    // 2. Fallback sang Pure-TypeScript Emulator nếu Ripgrep CLI không có hoặc gặp lỗi
    if (engineUsed === "typescript-emulator") {
      const emulated = await executeRipgrepEmulation(options, workspace);
      rawStdout = emulated.stdout.trim();
      totalMatchCount = emulated.matchCount;
    }

    // 3. Xử lý kết quả theo từng outputMode
    const lines = rawStdout ? rawStdout.split(/\r?\n/).filter(Boolean) : [];

    // Chế độ 1: 'count'
    if (outputMode === "count") {
      let count = totalMatchCount;
      if (engineUsed === "ripgrep-binary") {
        count = lines.reduce((acc, l) => {
          const parts = l.split(":");
          const last = parseInt(parts[parts.length - 1], 10);
          return acc + (Number.isFinite(last) ? last : 0);
        }, 0);
      }
      return {
        query: rawQuery,
        path: rawPath,
        engine: engineUsed,
        outputMode: "count",
        totalMatches: count,
      };
    }

    // Chế độ 2: 'files_with_matches'
    if (outputMode === "files_with_matches") {
      const files = lines.map((f) => f.replace(/\\/g, "/"));
      return {
        query: rawQuery,
        path: rawPath,
        engine: engineUsed,
        outputMode: "files_with_matches",
        totalFiles: files.length,
        files,
        guidance:
          "List of files containing results. Use read_file or search_text with a specific path to view details.",
      };
    }

    // Chế độ 3: 'content' (Mặc định)
    const allMatches: MatchItem[] = [];
    const fileSummaryMap = new Map<string, number>();

    for (const line of lines) {
      // Định dạng chuẩn của ripgrep / emulator: path:line:text
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);

      if (firstColon !== -1 && secondColon !== -1) {
        const file = line.slice(0, firstColon).replace(/\\/g, "/");
        const lineNumStr = line.slice(firstColon + 1, secondColon);
        const lineNum = parseInt(lineNumStr, 10);
        const text = line.slice(secondColon + 1);

        // Guard against NaN/Infinity from malformed line numbers
        const safeLine = Number.isFinite(lineNum) ? lineNum : 1;

        allMatches.push({ file, line: safeLine, text });
        fileSummaryMap.set(file, (fileSummaryMap.get(file) || 0) + 1);
      } else {
        // Fallback nếu định dạng chỉ có file:text hoặc đơn dòng
        allMatches.push({ file: rawPath, line: 1, text: line });
      }
    }

    const fileSummary: FileMatchSummary[] = Array.from(
      fileSummaryMap.entries(),
    ).map(([file, matchCount]) => ({ file, matchCount }));

    // Saliency Scoring: ưu tiên tệp mã nguồn chính và các khai báo định nghĩa
    function scoreMatch(m: MatchItem): number {
      let score = 0;
      const lowerFile = m.file.toLowerCase();
      const isTestOrMock = /(?:^|\/)(?:tests?|__tests__|mocks?|fixtures?|temp|scratch|dist|build|docs?)\//i.test(lowerFile)
        || /\.(?:test|spec)\.[a-z0-9]+$/i.test(lowerFile);
      const isSource = /(?:^|\/)(?:src|lib|packages|core|app)\//i.test(lowerFile);

      if (isSource && !isTestOrMock) score += 25;
      else if (isTestOrMock) score -= 30;

      const trimmed = m.text.trim();
      if (/^(?:export\s+|pub\s+)?(?:class|interface|type|function|def|fn|enum|struct|trait|const\s+[A-Z_0-9]+)\b/.test(trimmed)) {
        score += 15;
      } else if (/^(?:import|require|from|\/\/|\/\*|\*|#\s*include)\b/.test(trimmed)) {
        score -= 5;
      }
      return score;
    }

    const totalMatches = allMatches.length;
    const effectivePerFileLimit = perFileLimit !== undefined
      ? perFileLimit
      : (totalMatches > maxMatches && fileSummaryMap.size > 1 ? 3 : 0);

    let orderedMatches = allMatches;
    let diversityApplied = false;

    if (effectivePerFileLimit > 0 && fileSummaryMap.size > 1 && totalMatches > maxMatches) {
      diversityApplied = true;
      // Giai đoạn 1: Chấm điểm saliency cho tất cả matches
      const scored = allMatches.map((m, originalIdx) => ({
        match: m,
        score: scoreMatch(m),
        originalIdx,
      }));

      // Sắp xếp theo score giảm dần (ưu tiên source code & declaration)
      scored.sort((a, b) => b.score - a.score || a.match.file.localeCompare(b.match.file) || a.match.line - b.match.line);

      // Giai đoạn 2: Phân bổ diversity quota
      const primaryBucket: MatchItem[] = [];
      const remainderBucket: MatchItem[] = [];
      const fileCountMap = new Map<string, number>();

      for (const item of scored) {
        const count = fileCountMap.get(item.match.file) || 0;
        if (count < effectivePerFileLimit) {
          primaryBucket.push(item.match);
          fileCountMap.set(item.match.file, count + 1);
        } else {
          remainderBucket.push(item.match);
        }
      }

      orderedMatches = [...primaryBucket, ...remainderBucket];
    }

    // Giai đoạn 3: Phân trang (Pagination)
    const pageMatches = orderedMatches.slice(offset, offset + maxMatches);
    const returned = pageMatches.length;
    const hasMore = (offset + returned) < totalMatches;
    const nextOffset = hasMore ? offset + returned : undefined;
    const isTruncated = hasMore || totalMatches > maxMatches;
    const isCapped = isTruncated;

    const formattedContent = pageMatches
      .map((m) => `${m.file}:${m.line}: ${m.text}`)
      .join("\n");

    return {
      query: rawQuery,
      path: rawPath,
      engine: engineUsed,
      isRegex,
      include: includeGlob,
      offset,
      totalMatches,
      returned,
      truncated: isTruncated,
      hasMore,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(diversityApplied ? { diversityApplied: true, perFileLimit: effectivePerFileLimit } : {}),
      totalFiles: fileSummary.length,
      content:
        formattedContent || "No results matched the request.",
      matches: pageMatches,
      fileSummary,
      isCapped,
      warning: isCapped
        ? `[SEARCH_CAPPED]: Showing ${returned} of ${totalMatches} total matches across ${fileSummary.length} files (offset: ${offset}${diversityApplied ? `, diversity limit: ${effectivePerFileLimit}/file` : ""}). More results are available.`
        : undefined,
      suggestion: hasMore
        ? `To inspect subsequent matches without missing code, call search_text with offset: ${nextOffset} (auto-compact will preserve context tokens).`
        : isCapped
        ? 'Narrow the regex, or specify the "include" parameter (e.g. "*.ts") or a more specific "path".'
        : undefined,
    };
  },
};
