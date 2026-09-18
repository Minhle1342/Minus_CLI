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
    "Tìm kiếm nội dung tệp tin bằng Biểu thức chính quy (Regex) hoặc chuỗi văn bản theo cơ chế Hybrid (Ripgrep native + TypeScript fallback). Tự động bỏ qua thư mục rác (node_modules, .git, dist) và giới hạn kết quả TOÀN CỤC để bảo vệ context token.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          'Biểu thức chính quy (Regex) hoặc chuỗi văn bản cần tìm kiếm. Ví dụ: "function\\s+\\w+", "TODO:", "export\\s+class".',
      },
      path: {
        type: Type.STRING,
        description:
          'Thư mục hoặc tệp tin cụ thể để tìm kiếm (mặc định: "." quét toàn bộ workspace).',
      },
      isRegex: {
        type: Type.BOOLEAN,
        description:
          "Nếu true (mặc định), xử lý query như Regular Expression. Nếu false, tìm kiếm chuỗi ký tự chính xác (literal string).",
      },
      include: {
        type: Type.STRING,
        description:
          'Bộ lọc định dạng tệp tin theo mẫu glob (ví dụ: "*.ts", "*.py", "*.json").',
      },
      caseSensitive: {
        type: Type.BOOLEAN,
        description:
          "Nếu true, tìm kiếm phân biệt chữ hoa/thường. Mặc định false (không phân biệt).",
      },
      wordMatch: {
        type: Type.BOOLEAN,
        description:
          "Nếu true, chỉ khớp các từ hoàn chỉnh (tương đương \\b...\\b hoặc cờ -w trong ripgrep). Mặc định false.",
      },
      outputMode: {
        type: Type.STRING,
        enum: ["content", "files_with_matches", "count"],
        description:
          'Chế độ trả về: "content" (dòng khớp chi tiết path:line:text), "files_with_matches" (chỉ danh sách file), hoặc "count" (đếm số lượng). Mặc định: "content".',
      },
      maxMatches: {
        type: Type.INTEGER,
        description:
          "Giới hạn số lượng kết quả TỔNG CỤC trả về tối đa (mặc định: 50, tối đa: 200). Đây là hard cap toàn repo, không phải per-file.",
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

    if (!rawQuery) {
      return {
        error: 'Tham số "query" không được để trống.',
        errorCode: "INVALID_ARGS",
      };
    }

    // Kiểm tra đường dẫn tồn tại trước khi tìm
    try {
      workspace.resolveSafePath(rawPath);
    } catch (err: any) {
      return {
        error: `Đường dẫn "${rawPath}" nằm ngoài phạm vi workspace hợp lệ.`,
        errorCode: "PATH_OUT_OF_BOUNDS",
      };
    }

    const options: RgParsedOptions = {
      query: rawQuery,
      isRegex,
      ignoreCase: !caseSensitive,
      invertMatch: false,
      wordRegexp: wordMatch,
      filesWithMatchesOnly: outputMode === "files_with_matches",
      countOnly: outputMode === "count",
      showLineNumbers: true,
      maxTotalMatches: maxMatches,
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
        // NOTE: --max-count is per-file in rg; we enforce global cap post-process
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
          return acc + (isNaN(last) ? 0 : last);
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
          "Danh sách các file chứa kết quả. Hãy dùng read_file hoặc search_text với path cụ thể để xem chi tiết.",
      };
    }

    // Chế độ 3: 'content' (Mặc định)
    const matches: MatchItem[] = [];
    const fileSummaryMap = new Map<string, number>();

    for (const line of lines) {
      // Định dạng chuẩn của ripgrep / emulator: path:line:text
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);

      if (firstColon !== -1 && secondColon !== -1) {
        const file = line.slice(0, firstColon).replace(/\\/g, "/");
        const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
        const text = line.slice(secondColon + 1);

        matches.push({ file, line: lineNum, text });
        fileSummaryMap.set(file, (fileSummaryMap.get(file) || 0) + 1);
      } else {
        // Fallback nếu định dạng chỉ có file:text hoặc đơn dòng
        matches.push({ file: rawPath, line: 1, text: line });
      }
    }

    const fileSummary: FileMatchSummary[] = Array.from(
      fileSummaryMap.entries(),
    ).map(([file, matchCount]) => ({ file, matchCount }));

    const isCapped = matches.length >= maxMatches;
    const totalMatches = matches.length;
    const returned = Math.min(totalMatches, maxMatches);
    const isTruncated = totalMatches > maxMatches;
    const truncatedMatches = isTruncated
      ? matches.slice(0, maxMatches)
      : matches;

    const formattedContent = truncatedMatches
      .map((m) => `${m.file}:${m.line}: ${m.text}`)
      .join("\n");

    return {
      query: rawQuery,
      path: rawPath,
      engine: engineUsed,
      isRegex,
      include: includeGlob,
      totalMatches,
      returned,
      truncated: isTruncated,
      totalFiles: fileSummary.length,
      content:
        formattedContent || "Không tìm thấy kết quả nào khớp với yêu cầu.",
      matches: truncatedMatches,
      fileSummary,
      isCapped,
      warning: isCapped
        ? `[SEARCH_CAPPED]: Đã đạt giới hạn tối đa ${maxMatches} kết quả (tổng cộng ${totalMatches} khớp). Còn nhiều kết quả khác chưa được hiển thị.`
        : undefined,
      suggestion: isCapped
        ? 'Hãy thu hẹp biểu thức chính quy (regex), hoặc chỉ định tham số "include" (ví dụ: "*.ts") hoặc "path" cụ thể hơn.'
        : undefined,
    };
  },
};
