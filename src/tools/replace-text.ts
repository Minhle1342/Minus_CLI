import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';

type MatchStrategy =
  | 'exact'
  | 'normalized_eol'
  | 'normalized_indentation'
  | 'fuzzy_whitespace'
  | 'quote_normalized'
  | 'context_reduction'
  | 'ellipsis_anchor'
  | 'fuzzy_similarity';

interface TextMatch {
  start: number;
  end: number;
  line: number;
  strategy: MatchStrategy;
  indentation?: string;
}

interface NormalizedText {
  text: string;
  /** boundaries[n] is the original offset after n normalized characters. */
  boundaries: number[];
}

const ELLIPSIS_LINE_REGEX = /^\s*(?:\/\/|#|\/\*|<!--)?\s*\.{3,}(?:[^\n*<]*)(?:\.{3,})?\s*(?:\*\/|-->)?\s*$/i;

/**
 * Tool 4: replace_text
 * Thay thế một đoạn văn bản/code chính xác (surgical edit) trong một file.
 * Bắt buộc oldText phải khớp duy nhất 1 lần để tránh sửa nhầm chỗ.
 */
export const replaceTextTool: ToolDefinition = {
  name: 'replace_text',
  description: 'Thay thế duy nhất một đoạn oldText trong file với cơ chế Hardened Multi-tier Matching (exact, LF/CRLF, indentation, whitespace normalization, quote-agnostic, context reduction, ellipsis anchor, fuzzy similarity).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file cần sửa (ví dụ: "src/index.ts")',
      },
      oldText: {
        type: Type.STRING,
        description: 'Đoạn văn bản/code gốc cần thay thế (khớp chính xác hoặc khớp tương đương cấu trúc)',
      },
      newText: {
        type: Type.STRING,
        description: 'Đoạn văn bản/code mới sẽ thay thế vào',
      },
      matchMode: {
        type: Type.STRING,
        enum: ['auto', 'exact'],
        description: 'auto (mặc định) áp dụng toàn bộ chuỗi chiến lược so khớp thông minh; exact chỉ khớp byte-for-byte.',
      },
      expectedFileHash: {
        type: Type.STRING,
        description: 'Tuỳ chọn: contentHash do read_file trả về. Tool từ chối ghi nếu file đã thay đổi sau lần đọc.',
      },
      expectedOccurrences: {
        type: Type.INTEGER,
        description: 'Số lượng vị trí oldText dự kiến xuất hiện (mặc định: 1).',
      },
    },
    required: ['path', 'oldText', 'newText'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '');
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');
    const matchMode = args.matchMode === 'exact' ? 'exact' : 'auto';
    const expectedOccurrences = typeof args.expectedOccurrences === 'number' ? args.expectedOccurrences : 1;
    const expectedFileHash = args.expectedFileHash === undefined
      ? undefined
      : String(args.expectedFileHash).trim();

    if (!rawPath) {
      return { success: false, error: 'Tham số "path" là bắt buộc.', errorCode: 'INVALID_ARGS' };
    }
    if (!oldText) {
      return { success: false, error: 'Tham số "oldText" không được để trống.', errorCode: 'INVALID_ARGS' };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return {
          success: false,
          path: rawPath,
          error: `Bảo mật: Không được phép chỉnh sửa hoặc ghi đè file cấu hình nhạy cảm "${rawPath}".`,
          errorCode: 'SECURITY_VIOLATION',
        };
      }

      let stat;
      try {
        stat = await fs.stat(safePath);
      } catch (statErr: any) {
        if (statErr.code === 'ENOENT' || String(statErr.message).includes('ENOENT')) {
          return {
            success: false,
            path: rawPath,
            error: `File "${rawPath}" không tồn tại (ENOENT: no such file or directory).`,
            errorCode: 'FILE_NOT_FOUND',
            suggestion: 'Hãy kiểm tra lại đường dẫn tệp tin bằng list_files hoặc search_codebase_fast.',
          };
        }
        throw statErr;
      }

      if (!stat.isFile()) {
        return { success: false, path: rawPath, error: `"${rawPath}" không phải là file.`, errorCode: 'NOT_A_FILE' };
      }

      const content = await fs.readFile(safePath, 'utf-8');
      const observedFileHash = hashContent(content);
      if (expectedFileHash && expectedFileHash !== observedFileHash) {
        return {
          success: false,
          path: rawPath,
          error: `File "${rawPath}" đã thay đổi sau lần đọc gần nhất; thao tác thay thế đã bị chặn để tránh ghi đè nội dung mới.`,
          errorCode: 'FILE_CONTENT_CHANGED',
          expectedFileHash,
          observedFileHash,
          suggestion: `Gọi read_file với path="${rawPath}" và includeLineNumbers=false, sau đó dùng contentHash mới.`,
        };
      }

      let effectiveOldText = oldText;
      let matches = findTextMatches(content, effectiveOldText, matchMode);
      let autoStrippedLineNumbers = false;

      // Fallback 1: Nếu LLM vô tình copy tiền tố số dòng (ví dụ "12: const x = 1;" hoặc "12 | const x = 1;"), tự động làm sạch
      if (matches.length === 0 && /^\s*\d+[:|]\s+/m.test(oldText)) {
        const sanitizedOldText = oldText
          .split('\n')
          .map((line) => line.replace(/^\s*\d+[:|]\s?/, ''))
          .join('\n');
        const fallbackMatches = findTextMatches(content, sanitizedOldText, matchMode);
        if (fallbackMatches.length > 0) {
          effectiveOldText = sanitizedOldText;
          matches = fallbackMatches;
          autoStrippedLineNumbers = true;
        }
      }

      if (matches.length === 0) {
        const candidates = findNearbyCandidates(content, oldText);
        const suggestedRead = candidates[0]
          ? { path: rawPath, startLine: Math.max(1, candidates[0].line - 3), endLine: candidates[0].line + 6, includeLineNumbers: false }
          : { path: rawPath, includeLineNumbers: false };
        return {
          success: false,
          path: rawPath,
          error: `Không tìm thấy oldText trong "${rawPath}" sau khi kiểm tra exact, LF/CRLF, indentation, whitespace normalization, quote-agnostic, context reduction và fuzzy similarity.`,
          errorCode: 'TEXT_NOT_FOUND',
          diagnostic: 'oldText khác nội dung hiện tại; hãy dùng read_file với includeLineNumbers=false để lấy chính xác khối mã.',
          observedFileHash,
          oldTextLength: oldText.length,
          candidates,
          suggestedRead,
          suggestion: `Gọi read_file với ${JSON.stringify(suggestedRead)}, lấy content nguyên bản (không có số dòng), rồi gọi lại replace_text với contentHash mới.`,
        };
      }

      if (matches.length !== expectedOccurrences) {
        return {
          success: false,
          path: rawPath,
          error: `oldText khớp ${matches.length} vị trí trong "${rawPath}" (kỳ vọng: ${expectedOccurrences}); thao tác đã bị chặn để tránh sửa nhầm.`,
          errorCode: 'TEXT_NOT_UNIQUE',
          occurrences: matches.length,
          actualOccurrences: matches.length,
          expectedOccurrences,
          candidateLines: matches.slice(0, 10).map((match) => match.line),
          observedFileHash,
          suggestion: 'Đọc lại một khoảng dòng hẹp và thêm ngữ cảnh duy nhất vào oldText.',
        };
      }

      const match = matches[0];
      const replacement = prepareReplacement(newText, content, match);
      const updatedContent = content.slice(0, match.start) + replacement + content.slice(match.end);

      // Detect a concurrent/stale edit between the initial read and the write.
      const latestContent = await fs.readFile(safePath, 'utf-8');
      if (latestContent !== content) {
        return {
          success: false,
          path: rawPath,
          error: `File "${rawPath}" thay đổi trong lúc replace_text đang xử lý; không có dữ liệu nào bị ghi đè.`,
          errorCode: 'FILE_CHANGED_DURING_EDIT',
          expectedFileHash: observedFileHash,
          observedFileHash: hashContent(latestContent),
          suggestion: `Đọc lại "${rawPath}" rồi áp dụng thay đổi trên phiên bản mới nhất.`,
        };
      }

      await fs.writeFile(safePath, updatedContent, 'utf-8');

      let diagnosticWarning: string | undefined;
      let syntaxErrors: any[] | undefined;
      try {
        const diags = await CodeSyntaxValidator.validateFile(rawPath, workspace);
        if (diags.length > 0) {
          syntaxErrors = diags;
          diagnosticWarning = `⚠️ LINTER ALERT (${diags.length} unresolved syntax / missing import issue(s)):\n` +
            diags.map((d) => `  • Line ${d.line}: ${d.message}`).join('\n') +
            `\n👉 ACTION REQUIRED: Add the missing import statement at the top of "${rawPath}" or fix the syntax error now.`;
        }
      } catch {}

      return {
        path: rawPath,
        success: true,
        matchStrategy: match.strategy,
        line: match.line,
        previousContentHash: observedFileHash,
        contentHash: hashContent(updatedContent),
        message: `Đã thay thế thành công 1 vị trí trong "${rawPath}" (chiến lược: ${match.strategy}).`,
        ...(autoStrippedLineNumbers ? { note: 'Tự động làm sạch tiền tố số dòng trong oldText (Line Number Sanitization).' } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      };
    } catch (err: any) {
      return {
        success: false,
        path: rawPath,
        error: `Không thể thay thế nội dung file: ${err.message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  },
};

function findTextMatches(content: string, oldText: string, mode: 'auto' | 'exact'): TextMatch[] {
  // 1. Exact byte-for-byte match
  const exact = findAllRanges(content, oldText).map(({ start, end }) => ({
    start,
    end,
    line: lineNumberAt(content, start),
    strategy: 'exact' as const,
  }));
  if (mode === 'exact') return exact;

  // 2. Normalized EOL (LF vs CRLF)
  const normalizedContent = normalizeLineEndingsWithBoundaries(content);
  const normalizedOldText = normalizeLineEndingsWithBoundaries(oldText).text;
  const eolEquivalent = findAllRanges(normalizedContent.text, normalizedOldText).map(({ start, end }) => ({
    start: normalizedContent.boundaries[start],
    end: normalizedContent.boundaries[end],
    line: lineNumberAt(normalizedContent.text, start),
    strategy: content.slice(normalizedContent.boundaries[start], normalizedContent.boundaries[end]) === oldText
      ? 'exact' as const
      : 'normalized_eol' as const,
  }));
  if (eolEquivalent.length > 0) return eolEquivalent;

  // 3. Indentation Equivalence
  const indentMatches = findIndentationEquivalentMatches(content, normalizedContent, normalizedOldText);
  if (indentMatches.length > 0) return indentMatches;

  // 4. Fuzzy Whitespace Normalization (Tab vs 2/4 spaces, trailing whitespace, intra-line space)
  const wsMatches = findFuzzyWhitespaceMatches(content, normalizedContent, normalizedOldText);
  if (wsMatches.length > 0) return wsMatches;

  // 5. Quote-Agnostic Normalization (single vs double vs backtick quotes)
  const quoteMatches = findQuoteNormalizedMatches(content, normalizedContent, normalizedOldText);
  if (quoteMatches.length > 0) return quoteMatches;

  // 6. Ellipsis Anchor Matching (// ... existing code ...)
  const anchorMatches = findEllipsisAnchorMatches(content, normalizedContent, normalizedOldText);
  if (anchorMatches.length > 0) return anchorMatches;

  // 7. Context Reduction Cascade (Trimming 1 leading/trailing context line if >= 3 lines)
  const contextMatches = findContextReductionMatches(content, normalizedContent, normalizedOldText);
  if (contextMatches.length > 0) return contextMatches;

  // 8. Fuzzy Similarity Matching (Levenshtein / Token Dice >= 0.88 with uniqueness constraint)
  return findFuzzySimilarityMatches(content, normalizedContent, normalizedOldText);
}

function normalizeTextTokens(line: string): string {
  return (line || '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\t/g, '  ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuotes(str: string): string {
  return str.replace(/["'`]/g, '"');
}

function findIndentationEquivalentMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldHasTrailingEol = normalizedOldText.endsWith('\n');
  const oldLines = normalizedOldText.split('\n');
  if (oldHasTrailingEol) oldLines.pop();
  if (oldLines.length < 2 || oldLines.filter((line) => line.trim().length > 0).length < 2) return [];

  const contentLines = splitLines(normalizedContent.text);
  const expected = canonicalizeIndentedBlock(oldLines).canonical;
  const matches: TextMatch[] = [];
  for (let index = 0; index + oldLines.length <= contentLines.length; index++) {
    const window = contentLines.slice(index, index + oldLines.length);
    const canonical = canonicalizeIndentedBlock(window.map((line) => line.text));
    if (canonical.canonical !== expected) continue;
    const first = window[0];
    const last = window[window.length - 1];
    const normalizedEnd = oldHasTrailingEol && last.hasEol ? last.end + 1 : last.end;
    matches.push({
      start: normalizedContent.boundaries[first.start],
      end: normalizedContent.boundaries[normalizedEnd],
      line: index + 1,
      strategy: 'normalized_indentation',
      indentation: canonical.indentation,
    });
  }
  return matches.filter((match) => match.start <= match.end && match.end <= originalContent.length);
}

function findFuzzyWhitespaceMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldHasTrailingEol = normalizedOldText.endsWith('\n');
  const oldLines = normalizedOldText.split('\n');
  if (oldHasTrailingEol) oldLines.pop();
  if (oldLines.length === 0) return [];

  const expectedLines = oldLines.map(normalizeTextTokens);
  if (!expectedLines.some(Boolean)) return [];

  const contentLines = splitLines(normalizedContent.text);
  const matches: TextMatch[] = [];

  for (let index = 0; index + oldLines.length <= contentLines.length; index++) {
    const window = contentLines.slice(index, index + oldLines.length);
    let matched = true;
    for (let i = 0; i < oldLines.length; i++) {
      if (normalizeTextTokens(window[i].text) !== expectedLines[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const first = window[0];
    const last = window[window.length - 1];
    const normalizedEnd = oldHasTrailingEol && last.hasEol ? last.end + 1 : last.end;
    matches.push({
      start: normalizedContent.boundaries[first.start],
      end: normalizedContent.boundaries[normalizedEnd],
      line: index + 1,
      strategy: 'fuzzy_whitespace',
      indentation: window[0].text.match(/^[ \t]*/)?.[0] || '',
    });
  }

  return matches.filter((match) => match.start <= match.end && match.end <= originalContent.length);
}

function findQuoteNormalizedMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldHasTrailingEol = normalizedOldText.endsWith('\n');
  const oldLines = normalizedOldText.split('\n');
  if (oldHasTrailingEol) oldLines.pop();
  if (oldLines.length === 0) return [];

  const expectedLines = oldLines.map((l) => normalizeQuotes(normalizeTextTokens(l)));
  if (!expectedLines.some(Boolean)) return [];

  const contentLines = splitLines(normalizedContent.text);
  const matches: TextMatch[] = [];

  for (let index = 0; index + oldLines.length <= contentLines.length; index++) {
    const window = contentLines.slice(index, index + oldLines.length);
    let matched = true;
    for (let i = 0; i < oldLines.length; i++) {
      if (normalizeQuotes(normalizeTextTokens(window[i].text)) !== expectedLines[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const first = window[0];
    const last = window[window.length - 1];
    const normalizedEnd = oldHasTrailingEol && last.hasEol ? last.end + 1 : last.end;
    matches.push({
      start: normalizedContent.boundaries[first.start],
      end: normalizedContent.boundaries[normalizedEnd],
      line: index + 1,
      strategy: 'quote_normalized',
      indentation: window[0].text.match(/^[ \t]*/)?.[0] || '',
    });
  }

  return matches.filter((match) => match.start <= match.end && match.end <= originalContent.length);
}

function findEllipsisAnchorMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const lines = normalizedOldText.split('\n');
  const ellipsisIdx = lines.findIndex((l) => ELLIPSIS_LINE_REGEX.test(l));
  if (ellipsisIdx <= 0 || ellipsisIdx >= lines.length - 1) return [];

  const headLines = lines.slice(0, ellipsisIdx).join('\n');
  const tailLines = lines.slice(ellipsisIdx + 1).join('\n');
  if (!headLines.trim() || !tailLines.trim()) return [];

  const headMatches = findTextMatches(originalContent, headLines, 'auto');
  const tailMatches = findTextMatches(originalContent, tailLines, 'auto');

  if (headMatches.length === 1 && tailMatches.length === 1) {
    const head = headMatches[0];
    const tail = tailMatches[0];
    if (head.start < tail.end && head.end <= tail.start) {
      return [{
        start: head.start,
        end: tail.end,
        line: head.line,
        strategy: 'ellipsis_anchor',
        indentation: head.indentation,
      }];
    }
  }

  return [];
}

function findContextReductionMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldLines = normalizedOldText.split('\n');
  if (oldLines.length < 3) return [];

  const contentLines = splitLines(normalizedContent.text);
  const candidates: Array<{ trimmedOld: string[]; label: string }> = [
    { trimmedOld: oldLines.slice(0, oldLines.length - 1), label: 'trailing-trimmed-1' },
    { trimmedOld: oldLines.slice(1), label: 'leading-trimmed-1' },
    { trimmedOld: oldLines.slice(1, oldLines.length - 1), label: 'both-trimmed-1' },
  ];

  for (const cand of candidates) {
    if (cand.trimmedOld.length < 2) continue;
    const expLines = cand.trimmedOld.map(normalizeTextTokens);
    const matches: TextMatch[] = [];

    for (let index = 0; index + cand.trimmedOld.length <= contentLines.length; index++) {
      const window = contentLines.slice(index, index + cand.trimmedOld.length);
      let matched = true;
      for (let i = 0; i < cand.trimmedOld.length; i++) {
        if (normalizeTextTokens(window[i].text) !== expLines[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const first = window[0];
      const last = window[window.length - 1];
      matches.push({
        start: normalizedContent.boundaries[first.start],
        end: normalizedContent.boundaries[last.end],
        line: index + 1,
        strategy: 'context_reduction',
        indentation: window[0].text.match(/^[ \t]*/)?.[0] || '',
      });
    }

    if (matches.length === 1) {
      return matches;
    }
  }

  return [];
}

function findFuzzySimilarityMatches(
  originalContent: string,
  normalizedContent: NormalizedText,
  normalizedOldText: string,
): TextMatch[] {
  const oldLines = normalizedOldText.split(/\r?\n/).map(normalizeTextTokens).filter(Boolean);
  if (oldLines.length < 2) return [];

  const contentLines = splitLines(normalizedContent.text);
  const oldLen = oldLines.length;

  let bestScore = 0;
  let secondBestScore = 0;
  let bestMatch: TextMatch | null = null;

  for (let index = 0; index + oldLen <= contentLines.length; index++) {
    const window = contentLines.slice(index, index + oldLen);
    const windowLines = window.map((w) => normalizeTextTokens(w.text));

    let totalSim = 0;
    for (let i = 0; i < oldLen; i++) {
      totalSim += lineSimilarity(oldLines[i], windowLines[i]);
    }
    const avgSim = totalSim / oldLen;

    if (avgSim > bestScore) {
      secondBestScore = bestScore;
      bestScore = avgSim;
      const first = window[0];
      const last = window[window.length - 1];
      bestMatch = {
        start: normalizedContent.boundaries[first.start],
        end: normalizedContent.boundaries[last.end],
        line: index + 1,
        strategy: 'fuzzy_similarity',
        indentation: window[0].text.match(/^[ \t]*/)?.[0] || '',
      };
    } else if (avgSim > secondBestScore) {
      secondBestScore = avgSim;
    }
  }

  // Safety invariant: Match only if bestScore >= 0.88 and clearly unique
  if (bestScore >= 0.88 && (bestScore - secondBestScore >= 0.15 || secondBestScore < 0.65) && bestMatch) {
    return [bestMatch];
  }

  return [];
}

function prepareReplacement(newText: string, content: string, match: TextMatch): string {
  const eol = detectLocalEol(content.slice(match.start, match.end)) || detectDominantEol(content);
  let normalized = normalizeLineEndingsWithBoundaries(newText).text;

  if (
    match.strategy === 'normalized_indentation' ||
    match.strategy === 'fuzzy_whitespace' ||
    match.strategy === 'quote_normalized' ||
    match.strategy === 'context_reduction' ||
    match.strategy === 'fuzzy_similarity'
  ) {
    const hasTrailingEol = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (hasTrailingEol) lines.pop();
    const dedented = canonicalizeIndentedBlock(lines).lines;
    const targetBlock = content.slice(match.start, match.end);
    const usesTabs = targetBlock.includes('\t');
    const indentPrefix = match.indentation || '';

    normalized = dedented
      .map((line) => {
        if (!line) return '';
        if (usesTabs && line.startsWith('  ')) {
          const tabIndent = line.match(/^[ ]*/)?.[0].replace(/  /g, '\t') || '';
          return `${indentPrefix}${tabIndent}${line.trimStart()}`;
        }
        return `${indentPrefix}${line}`;
      })
      .join('\n') + (hasTrailingEol ? '\n' : '');
  }
  return normalized.replace(/\n/g, eol);
}

function normalizeLineEndingsWithBoundaries(value: string): NormalizedText {
  let text = '';
  const boundaries = [0];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\r') {
      if (value[index + 1] === '\n') index++;
      text += '\n';
    } else {
      text += value[index];
    }
    boundaries.push(index + 1);
  }
  return { text, boundaries };
}

function findAllRanges(content: string, needle: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= content.length - needle.length) {
    const start = content.indexOf(needle, cursor);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    cursor = start + Math.max(1, needle.length);
  }
  return ranges;
}

function splitLines(content: string): Array<{ text: string; start: number; end: number; hasEol: boolean }> {
  const lines: Array<{ text: string; start: number; end: number; hasEol: boolean }> = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '\n') continue;
    lines.push({ text: content.slice(start, index), start, end: index, hasEol: true });
    start = index + 1;
  }
  lines.push({ text: content.slice(start), start, end: content.length, hasEol: false });
  return lines;
}

function canonicalizeIndentedBlock(lines: string[]): { canonical: string; lines: string[]; indentation: string } {
  const trimmedRight = lines.map((line) => line.replace(/[ \t]+$/g, ''));
  const nonEmpty = trimmedRight.filter((line) => line.trim().length > 0);
  const indentationLength = nonEmpty.length === 0
    ? 0
    : Math.min(...nonEmpty.map((line) => line.match(/^[ \t]*/)?.[0].length || 0));
  const indentation = nonEmpty[0]?.slice(0, indentationLength) || '';
  const dedented = trimmedRight.map((line) => line.trim() ? line.slice(indentationLength) : '');
  return { canonical: dedented.join('\n'), lines: dedented, indentation };
}

function findNearbyCandidates(content: string, oldText: string): Array<{ line: number; preview: string; score: number }> {
  const anchor = normalizeLineEndingsWithBoundaries(oldText).text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  if (!anchor) return [];
  return normalizeLineEndingsWithBoundaries(content).text
    .split('\n')
    .map((line, index) => ({ line: index + 1, preview: line.trim().slice(0, 240), score: diceSimilarity(anchor, line.trim()) }))
    .filter((candidate) => candidate.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, 3);
}

function diceSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const pairs = (value: string) => {
    const result = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index++) {
      const pair = value.slice(index, index + 2);
      result.set(pair, (result.get(pair) || 0) + 1);
    }
    return result;
  };
  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  let overlap = 0;
  for (const [pair, count] of leftPairs) overlap += Math.min(count, rightPairs.get(pair) || 0);
  return (2 * overlap) / Math.max(1, left.length + right.length - 2);
}

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
  for (let j = 0; j <= an; j++) matrix[0][j] = j;
  for (let i = 1; i <= bn; i++) {
    for (let j = 1; j <= an; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[bn][an];
}

function detectDominantEol(content: string): '\r\n' | '\n' {
  return detectLocalEol(content) || '\n';
}

function detectLocalEol(content: string): '\r\n' | '\n' | undefined {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  if (crlf === 0 && lf === 0) return undefined;
  return crlf >= lf ? '\r\n' : '\n';
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}
