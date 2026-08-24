import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

type MatchStrategy = 'exact' | 'normalized_eol' | 'normalized_indentation';

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

/**
 * Tool 4: replace_text
 * Thay thế một đoạn văn bản/code chính xác (surgical edit) trong một file.
 * Bắt buộc oldText phải khớp duy nhất 1 lần để tránh sửa nhầm chỗ.
 */
export const replaceTextTool: ToolDefinition = {
  name: 'replace_text',
  description: 'Thay thế duy nhất một đoạn oldText trong file. Chế độ auto khớp an toàn cả LF/CRLF và chênh lệch indentation của block nhiều dòng; không dùng fuzzy semantic matching. Có thể truyền expectedFileHash lấy từ read_file để chặn sửa trên nội dung đã cũ.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file cần sửa (ví dụ: "src/index.ts")',
      },
      oldText: {
        type: Type.STRING,
        description: 'Đoạn văn bản/code gốc cần thay thế (phải trùng khớp chính xác 100%, bao gồm khoảng trắng/xuống dòng)',
      },
      newText: {
        type: Type.STRING,
        description: 'Đoạn văn bản/code mới sẽ thay thế vào',
      },
      matchMode: {
        type: Type.STRING,
        enum: ['auto', 'exact'],
        description: 'auto (mặc định) cho phép tương đương LF/CRLF và indentation; exact chỉ khớp byte-for-byte.',
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

      const stat = await fs.stat(safePath);

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

      const matches = findTextMatches(content, oldText, matchMode);
      if (matches.length === 0) {
        const candidates = findNearbyCandidates(content, oldText);
        const suggestedRead = candidates[0]
          ? { path: rawPath, startLine: Math.max(1, candidates[0].line - 3), endLine: candidates[0].line + 6, includeLineNumbers: false }
          : { path: rawPath, includeLineNumbers: false };
        return {
          success: false,
          path: rawPath,
          error: `Không tìm thấy oldText trong "${rawPath}" sau khi kiểm tra exact, LF/CRLF và indentation an toàn.`,
          errorCode: 'TEXT_NOT_FOUND',
          diagnostic: 'oldText khác nội dung hiện tại; preview có dấu "..." trên CLI chỉ là phần hiển thị bị rút gọn và không nên được sao chép làm source.',
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

      return {
        path: rawPath,
        success: true,
        matchStrategy: match.strategy,
        line: match.line,
        previousContentHash: observedFileHash,
        contentHash: hashContent(updatedContent),
        message: `Đã thay thế thành công 1 vị trí trong "${rawPath}".`,
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
  const exact = findAllRanges(content, oldText).map(({ start, end }) => ({
    start,
    end,
    line: lineNumberAt(content, start),
    strategy: 'exact' as const,
  }));
  if (mode === 'exact') return exact;

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

  return findIndentationEquivalentMatches(content, normalizedContent, normalizedOldText);
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

function prepareReplacement(newText: string, content: string, match: TextMatch): string {
  const eol = detectLocalEol(content.slice(match.start, match.end)) || detectDominantEol(content);
  let normalized = normalizeLineEndingsWithBoundaries(newText).text;
  if (match.strategy === 'normalized_indentation') {
    const hasTrailingEol = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (hasTrailingEol) lines.pop();
    const dedented = canonicalizeIndentedBlock(lines).lines;
    normalized = dedented
      .map((line) => line ? `${match.indentation || ''}${line}` : '')
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
