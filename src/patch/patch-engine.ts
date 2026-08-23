import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  rawHunk: string;
}

export interface FilePatch {
  type: 'modify' | 'create' | 'delete';
  oldPath?: string;
  newPath?: string;
  hunks: PatchHunk[];
}

export interface ParsedPatch {
  files: FilePatch[];
  rawPatch: string;
}

export interface HunkApplyResult {
  hunkIndex: number;
  applied: boolean;
  fuzzLevelUsed: number;
  matchedLineIndex?: number;
  error?: string;
  contextExpected?: string[];
  closestMatches?: Array<{ lineIndex: number; similarity: number; preview: string }>;
}

export interface FileApplyResult {
  path: string;
  type: 'modify' | 'create' | 'delete';
  success: boolean;
  hunksTotal: number;
  hunksApplied: number;
  fuzzLevelUsed: number;
  hunkResults: HunkApplyResult[];
  error?: string;
  newContent?: string;
}

export interface PatchEngineResult {
  success: boolean;
  filesModified: string[];
  filesCreated: string[];
  filesDeleted: string[];
  totalHunks: number;
  hunksApplied: number;
  fileResults: FileApplyResult[];
  error?: string;
}

/**
 * PatchEngine - Engine áp dụng Unified Diff Patch với Fuzz Matching thông minh (Codex CLI standard).
 * 
 * Tính năng chính:
 * 1. Hỗ trợ Multi-file Unified Diff, Markdown diff blocks (```diff), và Begin/End Patch tags.
 * 2. 4 cấp độ Fuzz Matching:
 *    - Fuzz 0: Khớp dòng chính xác (có bù trừ dịch chuyển dòng / line offset).
 *    - Fuzz 1: Bỏ qua khác biệt về khoảng trắng đuôi dòng, thụt đầu dòng (indentation tolerance), và LF/CRLF.
 *    - Fuzz 2: Context reduction (giảm 1-2 dòng context trước/sau nếu code xung quanh có thay đổi nhẹ).
 *    - Fuzz 3: Fuzzy similarity matching (tính độ tương đồng chuỗi Levenshtein >= 80%).
 * 3. Atomic Transaction: Thử nghiệm toàn bộ hunks trên bộ nhớ trước khi ghi file xuống đĩa.
 */
export class PatchEngine {
  /**
   * Parse chuỗi patch thành cấu trúc ParsedPatch
   */
  static parsePatch(rawPatchText: string, defaultPath?: string): ParsedPatch {
    let cleanText = rawPatchText.trim();

    // 1. Gỡ bỏ markdown code fences hoặc Begin/End tags
    cleanText = cleanText.replace(/^\s*```(?:diff|patch)?\s*\n?/i, '');
    cleanText = cleanText.replace(/\n?\s*```\s*$/i, '');
    cleanText = cleanText.replace(/^\s*\*\*\*\s*Begin\s+Patch\s*\*\*\*\s*\n?/i, '');
    cleanText = cleanText.replace(/\n?\s*\*\*\*\s*End\s+Patch\s*\*\*\*\s*$/i, '');

    const lines = cleanText.split(/\r?\n/);
    const files: FilePatch[] = [];

    let currentFile: FilePatch | null = null;
    let currentHunk: PatchHunk | null = null;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Bắt đầu header file: --- a/path/to/file hoặc --- path/to/file
      if (line.startsWith('--- ')) {
        const oldPathRaw = line.slice(4).trim();
        const nextLine = lines[i + 1] || '';

        let newPathRaw = '';
        if (nextLine.startsWith('+++ ')) {
          newPathRaw = nextLine.slice(4).trim();
          i++; // Bỏ qua dòng +++
        }

        const oldCleanPath = sanitizeDiffPath(oldPathRaw);
        const newCleanPath = sanitizeDiffPath(newPathRaw);

        let patchType: 'modify' | 'create' | 'delete' = 'modify';
        if (oldCleanPath === '/dev/null' || oldCleanPath === '') {
          patchType = 'create';
        } else if (newCleanPath === '/dev/null' || newCleanPath === '') {
          patchType = 'delete';
        }

        currentFile = {
          type: patchType,
          oldPath: oldCleanPath !== '/dev/null' ? oldCleanPath : undefined,
          newPath: newCleanPath !== '/dev/null' ? newCleanPath : (oldCleanPath !== '/dev/null' ? oldCleanPath : undefined),
          hunks: [],
        };
        files.push(currentFile);
        currentHunk = null;
        i++;
        continue;
      }

      // Bắt đầu Hunk: @@ -start,count +start,count @@ [optional header]
      if (line.startsWith('@@')) {
        if (!currentFile) {
          // Nếu không có header file nhưng có defaultPath
          currentFile = {
            type: 'modify',
            oldPath: defaultPath,
            newPath: defaultPath,
            hunks: [],
          };
          files.push(currentFile);
        }

        const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
        const oldStart = hunkMatch ? parseInt(hunkMatch[1], 10) : 1;
        const oldLines = hunkMatch && hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        const newStart = hunkMatch && hunkMatch[3] ? parseInt(hunkMatch[3], 10) : 1;
        const newLines = hunkMatch && hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
          rawHunk: line,
        };
        currentFile.hunks.push(currentHunk);
        i++;
        continue;
      }

      // Nội dung của Hunk (' ', '+', '-')
      if (currentHunk) {
        if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
          currentHunk.lines.push(line);
        } else if (line.startsWith('\\ No newline at end of file')) {
          // Bỏ qua chú thích git diff
        } else if (line.trim() === '' && i === lines.length - 1) {
          // Bỏ qua dòng trống cuối cùng
        } else {
          // Hỗ trợ trường hợp LLM quên dấu cách ở dòng context trống
          currentHunk.lines.push(' ' + line);
        }
      }

      i++;
    }

    // Nếu không có hunk headers @@ mà chỉ có một danh sách các dòng thay đổi với defaultPath
    if (files.length === 0 && defaultPath) {
      const hunkLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
          hunkLines.push(line);
        }
      }
      if (hunkLines.length > 0) {
        files.push({
          type: 'modify',
          oldPath: defaultPath,
          newPath: defaultPath,
          hunks: [{
            oldStart: 1,
            oldLines: hunkLines.filter((l) => !l.startsWith('+')).length,
            newStart: 1,
            newLines: hunkLines.filter((l) => !l.startsWith('-')).length,
            lines: hunkLines,
            rawHunk: '@@ -1,1 +1,1 @@',
          }],
        });
      }
    }

    return {
      files,
      rawPatch: cleanText,
    };
  }

  /**
   * Áp dụng parsed patch vào workspace
   */
  static async applyPatch(
    patchInput: string | ParsedPatch,
    workspace: Workspace,
    options: { defaultPath?: string; maxFuzzLevel?: number; dryRun?: boolean } = {}
  ): Promise<PatchEngineResult> {
    const maxFuzzLevel = options.maxFuzzLevel ?? 2;
    const parsed = typeof patchInput === 'string'
      ? this.parsePatch(patchInput, options.defaultPath)
      : patchInput;

    if (parsed.files.length === 0) {
      return {
        success: false,
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        totalHunks: 0,
        hunksApplied: 0,
        fileResults: [],
        error: 'Không tìm thấy file hoặc hunk hợp lệ nào trong nội dung patch.',
      };
    }

    const fileResults: FileApplyResult[] = [];
    let totalHunks = 0;
    let hunksApplied = 0;
    let allSucceeded = true;

    // 1. Transaction Phase 1: Thử nghiệm (Simulate) áp dụng patch trên bộ nhớ
    for (const filePatch of parsed.files) {
      const targetPath = filePatch.newPath || filePatch.oldPath || options.defaultPath;
      if (!targetPath) {
        allSucceeded = false;
        fileResults.push({
          path: 'unknown',
          type: filePatch.type,
          success: false,
          hunksTotal: filePatch.hunks.length,
          hunksApplied: 0,
          fuzzLevelUsed: 0,
          hunkResults: [],
          error: 'Thiếu đường dẫn file trong patch header.',
        });
        continue;
      }

      totalHunks += filePatch.hunks.length;
      const fileRes = await this.simulateFilePatch(filePatch, targetPath, workspace, maxFuzzLevel);
      fileResults.push(fileRes);

      hunksApplied += fileRes.hunksApplied;
      if (!fileRes.success) {
        allSucceeded = false;
      }
    }

    // 2. Nếu có bất kỳ hunk/file nào thất bại -> Rollback, không chạm vào đĩa
    if (!allSucceeded) {
      const failedFiles = fileResults.filter((f) => !f.success);
      const firstError = failedFiles[0]?.error || 'Một số hunks không thể áp dụng vào tệp tin.';
      return {
        success: false,
        filesModified: [],
        filesCreated: [],
        filesDeleted: [],
        totalHunks,
        hunksApplied,
        fileResults,
        error: `Patch thất bại: ${firstError}`,
      };
    }

    // 3. Transaction Phase 2: Ghi dữ liệu thực tế xuống đĩa
    const filesModified: string[] = [];
    const filesCreated: string[] = [];
    const filesDeleted: string[] = [];

    if (!options.dryRun) {
      for (const res of fileResults) {
        const safePath = workspace.resolveSafePath(res.path);
        if (res.type === 'create') {
          await fs.mkdir(path.dirname(safePath), { recursive: true });
          await fs.writeFile(safePath, res.newContent || '', 'utf-8');
          filesCreated.push(res.path);
        } else if (res.type === 'delete') {
          try {
            await fs.unlink(safePath);
            filesDeleted.push(res.path);
          } catch {}
        } else if (res.type === 'modify') {
          await fs.writeFile(safePath, res.newContent || '', 'utf-8');
          filesModified.push(res.path);
        }
      }
    }

    return {
      success: true,
      filesModified,
      filesCreated,
      filesDeleted,
      totalHunks,
      hunksApplied,
      fileResults,
    };
  }

  /**
   * Thử nghiệm áp dụng patch trên nội dung 1 file
   */
  private static async simulateFilePatch(
    filePatch: FilePatch,
    relPath: string,
    workspace: Workspace,
    maxFuzzLevel: number,
  ): Promise<FileApplyResult> {
    const hunkResults: HunkApplyResult[] = [];

    // Xử lý tạo mới file
    if (filePatch.type === 'create') {
      const createdLines: string[] = [];
      for (const hunk of filePatch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) {
            createdLines.push(line.slice(1));
          } else if (line.startsWith(' ')) {
            createdLines.push(line.slice(1));
          }
        }
      }
      return {
        path: relPath,
        type: 'create',
        success: true,
        hunksTotal: filePatch.hunks.length,
        hunksApplied: filePatch.hunks.length,
        fuzzLevelUsed: 0,
        hunkResults: filePatch.hunks.map((_, i) => ({ hunkIndex: i, applied: true, fuzzLevelUsed: 0 })),
        newContent: createdLines.join('\n'),
      };
    }

    // Đọc file nguồn hiện tại
    let originalContent = '';
    let isCRLF = false;
    try {
      const safePath = workspace.resolveSafePath(relPath);
      originalContent = await fs.readFile(safePath, 'utf-8');
      isCRLF = originalContent.includes('\r\n');
    } catch (err: any) {
      return {
        path: relPath,
        type: filePatch.type,
        success: false,
        hunksTotal: filePatch.hunks.length,
        hunksApplied: 0,
        fuzzLevelUsed: 0,
        hunkResults: [],
        error: `Không thể đọc file "${relPath}": ${err.message}`,
      };
    }

    // Xử lý xóa file
    if (filePatch.type === 'delete') {
      return {
        path: relPath,
        type: 'delete',
        success: true,
        hunksTotal: filePatch.hunks.length,
        hunksApplied: filePatch.hunks.length,
        fuzzLevelUsed: 0,
        hunkResults: filePatch.hunks.map((_, i) => ({ hunkIndex: i, applied: true, fuzzLevelUsed: 0 })),
      };
    }

    // Chuẩn hóa dòng thành LF để xử lý
    let currentLines = originalContent.replace(/\r\n/g, '\n').split('\n');
    let maxFuzzUsed = 0;

    // Áp dụng từng hunk
    for (let hIdx = 0; hIdx < filePatch.hunks.length; hIdx++) {
      const hunk = filePatch.hunks[hIdx];
      const matchRes = this.findHunkMatch(currentLines, hunk, maxFuzzLevel);

      if (!matchRes.found || matchRes.matchLineIndex === undefined) {
        hunkResults.push({
          hunkIndex: hIdx,
          applied: false,
          fuzzLevelUsed: 0,
          error: matchRes.error || `Hunk #${hIdx + 1} (dòng ${hunk.oldStart}) không khớp với nội dung file.`,
          contextExpected: hunk.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1)),
          closestMatches: matchRes.closestMatches,
        });

        return {
          path: relPath,
          type: 'modify',
          success: false,
          hunksTotal: filePatch.hunks.length,
          hunksApplied: hIdx,
          fuzzLevelUsed: maxFuzzUsed,
          hunkResults,
          error: `Hunk #${hIdx + 1} không thể áp dụng vào "${relPath}". ${matchRes.error || ''}`,
        };
      }

      // Áp dụng thay thế hunk tại vị trí matchLineIndex
      const matchedIdx = matchRes.matchLineIndex;
      const expectedLinesCount = matchRes.matchedLinesCount;
      const newReplacementLines = matchRes.replacementLines;

      currentLines.splice(matchedIdx, expectedLinesCount, ...newReplacementLines);

      maxFuzzUsed = Math.max(maxFuzzUsed, matchRes.fuzzLevel);
      hunkResults.push({
        hunkIndex: hIdx,
        applied: true,
        fuzzLevelUsed: matchRes.fuzzLevel,
        matchedLineIndex: matchedIdx,
      });
    }

    // Khôi phục line endings gốc (CRLF nếu có)
    const finalContent = isCRLF ? currentLines.join('\r\n') : currentLines.join('\n');

    return {
      path: relPath,
      type: 'modify',
      success: true,
      hunksTotal: filePatch.hunks.length,
      hunksApplied: filePatch.hunks.length,
      fuzzLevelUsed: maxFuzzUsed,
      hunkResults,
      newContent: finalContent,
    };
  }

  /**
   * Tìm vị trí khớp Hunk với Fuzz Matching (Cấp 0 -> 3)
   */
  private static findHunkMatch(
    targetLines: string[],
    hunk: PatchHunk,
    maxFuzz: number,
  ): {
    found: boolean;
    matchLineIndex?: number;
    matchedLinesCount: number;
    replacementLines: string[];
    fuzzLevel: number;
    error?: string;
    closestMatches?: Array<{ lineIndex: number; similarity: number; preview: string }>;
  } {
    const expectedOldLines: string[] = [];
    const replacementLines: string[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        expectedOldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        replacementLines.push(line.slice(1));
      } else {
        // Context line
        const content = line.startsWith(' ') ? line.slice(1) : line;
        expectedOldLines.push(content);
        replacementLines.push(content);
      }
    }

    if (expectedOldLines.length === 0) {
      // Insertion hunk tại dòng cụ thể
      const targetPos = Math.min(Math.max(0, hunk.oldStart - 1), targetLines.length);
      return {
        found: true,
        matchLineIndex: targetPos,
        matchedLinesCount: 0,
        replacementLines,
        fuzzLevel: 0,
      };
    }

    const expLen = expectedOldLines.length;
    const targetOldStart = Math.max(0, hunk.oldStart - 1);

    // ==============================================================
    // Cấp độ 0: Exact match tại vị trí hoặc quét toàn bộ file (Slide Window)
    // ==============================================================
    // 0a. Thử đúng dòng ghi trên header @@
    if (this.linesMatchExact(targetLines, expectedOldLines, targetOldStart)) {
      return {
        found: true,
        matchLineIndex: targetOldStart,
        matchedLinesCount: expLen,
        replacementLines,
        fuzzLevel: 0,
      };
    }

    // 0b. Trượt tìm vị trí khớp chính xác trên toàn bộ file
    const exactMatches: number[] = [];
    for (let i = 0; i <= targetLines.length - expLen; i++) {
      if (this.linesMatchExact(targetLines, expectedOldLines, i)) {
        exactMatches.push(i);
      }
    }
    if (exactMatches.length === 1) {
      return {
        found: true,
        matchLineIndex: exactMatches[0],
        matchedLinesCount: expLen,
        replacementLines,
        fuzzLevel: 0,
      };
    }
    if (exactMatches.length > 1) {
      // Chọn vị trí gần targetOldStart nhất
      exactMatches.sort((a, b) => Math.abs(a - targetOldStart) - Math.abs(b - targetOldStart));
      return {
        found: true,
        matchLineIndex: exactMatches[0],
        matchedLinesCount: expLen,
        replacementLines,
        fuzzLevel: 0,
      };
    }

    if (maxFuzz < 1) {
      return { found: false, matchedLinesCount: 0, replacementLines: [], fuzzLevel: 0 };
    }

    // ==============================================================
    // Cấp độ 1: Normalized Indentation & Whitespace Tolerance
    // ==============================================================
    const normMatches: number[] = [];
    for (let i = 0; i <= targetLines.length - expLen; i++) {
      if (this.linesMatchNormalized(targetLines, expectedOldLines, i)) {
        normMatches.push(i);
      }
    }
    if (normMatches.length >= 1) {
      normMatches.sort((a, b) => Math.abs(a - targetOldStart) - Math.abs(b - targetOldStart));
      const matchedIdx = normMatches[0];

      // Điều chỉnh indentation của replacementLines theo phong cách của file mục tiêu
      const adaptedReplacement = this.adaptIndentation(targetLines[matchedIdx], expectedOldLines[0], replacementLines);

      return {
        found: true,
        matchLineIndex: matchedIdx,
        matchedLinesCount: expLen,
        replacementLines: adaptedReplacement,
        fuzzLevel: 1,
      };
    }

    if (maxFuzz < 2) {
      return { found: false, matchedLinesCount: 0, replacementLines: [], fuzzLevel: 0 };
    }

    // ==============================================================
    // Cấp độ 2: Context Reduction (Bỏ 1 dòng context trước hoặc sau)
    // ==============================================================
    if (expLen >= 3) {
      // Thử bỏ 1 dòng context đầu và 1 dòng context cuối
      const trimmedExp = expectedOldLines.slice(1, expLen - 1);
      for (let i = 0; i <= targetLines.length - trimmedExp.length; i++) {
        if (this.linesMatchNormalized(targetLines, trimmedExp, i)) {
          const adaptedReplacement = this.adaptIndentation(targetLines[i], trimmedExp[0], replacementLines.slice(1, -1));
          return {
            found: true,
            matchLineIndex: i,
            matchedLinesCount: trimmedExp.length,
            replacementLines: adaptedReplacement,
            fuzzLevel: 2,
          };
        }
      }
    }

    if (maxFuzz < 3) {
      return { found: false, matchedLinesCount: 0, replacementLines: [], fuzzLevel: 0 };
    }

    // ==============================================================
    // Cấp độ 3: Fuzzy Similarity Match (Levenshtein >= 0.82)
    // ==============================================================
    let bestScore = 0;
    let bestIdx = -1;
    const candidates: Array<{ lineIndex: number; similarity: number; preview: string }> = [];

    for (let i = 0; i <= targetLines.length - expLen; i++) {
      const score = this.computeBlockSimilarity(targetLines.slice(i, i + expLen), expectedOldLines);
      if (score >= 0.7) {
        candidates.push({
          lineIndex: i + 1,
          similarity: Number(score.toFixed(3)),
          preview: targetLines[i]?.trim().slice(0, 60) || '',
        });
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity);

    if (bestScore >= 0.82 && bestIdx !== -1) {
      return {
        found: true,
        matchLineIndex: bestIdx,
        matchedLinesCount: expLen,
        replacementLines,
        fuzzLevel: 3,
        closestMatches: candidates.slice(0, 3),
      };
    }

    return {
      found: false,
      matchedLinesCount: 0,
      replacementLines: [],
      fuzzLevel: 0,
      error: `Không tìm thấy đoạn mã khớp (Độ tương đồng cao nhất: ${(bestScore * 100).toFixed(1)}% tại dòng ${bestIdx + 1}).`,
      closestMatches: candidates.slice(0, 3),
    };
  }

  private static linesMatchExact(targetLines: string[], expLines: string[], startIdx: number): boolean {
    if (startIdx + expLines.length > targetLines.length || startIdx < 0) return false;
    for (let j = 0; j < expLines.length; j++) {
      if (targetLines[startIdx + j] !== expLines[j]) {
        return false;
      }
    }
    return true;
  }

  private static linesMatchNormalized(targetLines: string[], expLines: string[], startIdx: number): boolean {
    if (startIdx + expLines.length > targetLines.length || startIdx < 0) return false;
    for (let j = 0; j < expLines.length; j++) {
      const t = targetLines[startIdx + j].trim();
      const e = expLines[j].trim();
      if (t !== e) {
        return false;
      }
    }
    return true;
  }

  private static adaptIndentation(targetSampleLine: string, expSampleLine: string, replacementLines: string[]): string[] {
    const targetIndentMatch = (targetSampleLine || '').match(/^(\s*)/);
    const expIndentMatch = (expSampleLine || '').match(/^(\s*)/);

    const targetIndent = targetIndentMatch ? targetIndentMatch[1] : '';
    const expIndent = expIndentMatch ? expIndentMatch[1] : '';

    if (targetIndent === expIndent) {
      return replacementLines;
    }

    return replacementLines.map((line) => {
      if (line.startsWith(expIndent)) {
        return targetIndent + line.slice(expIndent.length);
      }
      return line;
    });
  }

  private static computeBlockSimilarity(targetBlock: string[], expBlock: string[]): number {
    if (targetBlock.length !== expBlock.length || targetBlock.length === 0) return 0;
    let totalScore = 0;
    for (let i = 0; i < targetBlock.length; i++) {
      totalScore += lineSimilarity(targetBlock[i].trim(), expBlock[i].trim());
    }
    return totalScore / targetBlock.length;
  }
}

/**
 * Trợ giúp sanitize đường dẫn trong header unified diff (loại bỏ a/ hoặc b/)
 */
function sanitizeDiffPath(raw: string): string {
  let clean = raw.trim().replace(/^["']|["']$/g, '');
  if (clean === '/dev/null') return '/dev/null';
  clean = clean.replace(/^[ab]\//, '');
  return clean;
}

/**
 * Tính độ tương đồng giữa 2 dòng ký tự (0 -> 1)
 */
function lineSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;

  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 1.0;

  const editDistance = levenshtein(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshtein(a: string, b: string): number {
  const an = a ? a.length : 0;
  const bn = b ? b.length : 0;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: bn + 1 }, (_, i) => [i]);
  for (let j = 0; j <= an; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= bn; i++) {
    for (let j = 1; j <= an; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          )
        );
      }
    }
  }
  return matrix[bn][an];
}