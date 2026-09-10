import fs from 'node:fs/promises';
import path from 'node:path';

export interface TerminalTruncationOptions {
  maxLength?: number;
  maxLines?: number;
  preserveHeadLines?: number;
  preserveTailLines?: number;
  logFilePath?: string;
  exitCode?: number;
}

export interface TerminalTruncationResult {
  text: string;
  truncated: boolean;
  originalLength: number;
  truncatedLength: number;
  savedChars: number;
  savedTokensEstimate: number;
}

/**
 * Loại bỏ toàn bộ mã điều khiển ANSI escape codes (màu sắc, điều hướng con trỏ, xóa màn hình)
 * Tuân thủ chuẩn ECMA-48 / ANSI X3.64.
 */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Nén các dòng tiến trình (Progress Bars) sử dụng ký tự Carriage Return (\r).
 * Khi một công cụ ghi đè cùng một dòng liên tục (như npm, pip, curl, docker),
 * chỉ giữ lại trạng thái hoàn thành cuối cùng của dòng đó thay vì dồn tích hàng nghìn ký tự rác.
 */
export function collapseCarriageReturns(text: string): string {
  if (!text || !text.includes('\r')) return text || '';
  
  const lines = text.split(/\r?\n/);
  const collapsedLines: string[] = [];

  for (const line of lines) {
    if (!line.includes('\r')) {
      collapsedLines.push(line);
      continue;
    }
    const parts = line.split('\r').map((p) => p.trimEnd()).filter(Boolean);
    if (parts.length > 0) {
      collapsedLines.push(parts[parts.length - 1]);
    }
  }

  return collapsedLines.join('\n');
}

/**
 * Làm sạch toàn diện output terminal:
 * 1. Strip ANSI escape sequences
 * 2. Collapse carriage return progress bars
 * 3. Chuẩn hóa khoảng trắng đầu/cuối dòng
 */
export function sanitizeTerminalOutput(raw: string): string {
  if (!raw) return '';
  const noAnsi = stripAnsi(raw);
  const collapsed = collapseCarriageReturns(noAnsi);
  return collapsed.trim();
}

/**
 * Bóc tách và cô đọng lỗi kiểm thử từ các test framework phổ biến (Jest, Vitest, Mocha, Pytest, Go test, Cargo test).
 * Khi log quá dài, loại bỏ các dòng thông báo PASS lặp lại và giữ lại toàn bộ khối FAIL/Error stack trace.
 */
export function distillTestOutput(text: string, exitCode?: number): string {
  if (!text) return '';
  if (exitCode === 0) return text;

  const lines = text.split(/\r?\n/);
  if (lines.length <= 80) return text;

  const isPassingTestPattern = (line: string): boolean => {
    return /^(?:PASS|✓|SUCCESS|ok)\s+/i.test(line.trim());
  };

  const distilled: string[] = [];
  let skippedPassCount = 0;

  for (const line of lines) {
    if (isPassingTestPattern(line)) {
      skippedPassCount++;
      continue;
    }
    distilled.push(line);
  }

  if (skippedPassCount > 0) {
    distilled.unshift(`[INFO: Đã rút gọn ${skippedPassCount} dòng PASS thành công của test suites]`);
  }

  return distilled.join('\n');
}

/**
 * Lưu toàn bộ Raw Output ra đĩa trong thư mục .minus/logs/command_outputs/ khi vượt ngưỡng hiển thị.
 * Trả về đường dẫn tương đối từ workspace root.
 */
export async function offloadLargeLogToDisk(
  workspaceRoot: string,
  fullRawOutput: string,
  commandName: string = 'cmd',
): Promise<string | undefined> {
  if (!workspaceRoot || !fullRawOutput) return undefined;

  try {
    const logsDir = path.resolve(workspaceRoot, '.minus', 'logs', 'command_outputs');
    await fs.mkdir(logsDir, { recursive: true });

    const safeCmdSlug = commandName
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 30);
    const fileName = `${Date.now()}_${safeCmdSlug}_${Math.random().toString(36).slice(2, 6)}.log`;
    const fullLogPath = path.join(logsDir, fileName);

    await fs.writeFile(fullLogPath, fullRawOutput, 'utf-8');
    return path.relative(workspaceRoot, fullLogPath).replace(/\\/g, '/');
  } catch {
    return undefined;
  }
}

/**
 * Thu gọn thông minh output terminal (SWE-agent & RTK Head-Tail Truncation).
 * Ưu tiên:
 * - Giữ phần đầu (preserveHeadLines: ngữ cảnh khởi động / lệnh thực thi)
 * - Giữ phần cuối (preserveTailLines: kết quả cuối, stack trace, mã thoát)
 * - Cắt bớt phần giữa kèm thông báo và đường dẫn file log đầy đủ (nếu có offload).
 */
export function truncateTerminalOutput(
  text: string,
  options?: TerminalTruncationOptions,
): TerminalTruncationResult {
  const originalLength = text ? text.length : 0;
  if (!text || originalLength === 0) {
    return {
      text: '',
      truncated: false,
      originalLength: 0,
      truncatedLength: 0,
      savedChars: 0,
      savedTokensEstimate: 0,
    };
  }

  const configuredMaxLength = Number(process.env.MINUS_TERMINAL_MAX_OUTPUT_CHARS);
  const maxLength = options?.maxLength ?? (Number.isFinite(configuredMaxLength) && configuredMaxLength > 0 ? configuredMaxLength : 8000);
  const maxLines = options?.maxLines ?? 120;
  const headLinesCount = options?.preserveHeadLines ?? 30;
  const tailLinesCount = options?.preserveTailLines ?? 60;

  const lines = text.split(/\r?\n/);
  const exceedsChars = originalLength > maxLength;
  const exceedsLines = lines.length > maxLines;

  if (!exceedsChars && !exceedsLines) {
    return {
      text,
      truncated: false,
      originalLength,
      truncatedLength: originalLength,
      savedChars: 0,
      savedTokensEstimate: 0,
    };
  }

  const effectiveHeadCount = Math.min(headLinesCount, Math.floor(lines.length / 2));
  const effectiveTailCount = Math.min(tailLinesCount, Math.floor(lines.length / 2));

  const headPart = lines.slice(0, effectiveHeadCount).join('\n');
  const tailPart = lines.slice(-effectiveTailCount).join('\n');

  const omittedLinesCount = lines.length - effectiveHeadCount - effectiveTailCount;
  const omittedCharsCount = originalLength - headPart.length - tailPart.length;

  let separator = `\n\n[... Đã cắt bớt ${omittedLinesCount} dòng (${omittedCharsCount} ký tự log thừa để bảo vệ token window) ...]`;
  if (options?.logFilePath) {
    separator += `\n[💡 TOÀN BỘ LOG ĐẦY ĐỦ ĐÃ ĐƯỢC LƯU TẠI TỆP: ${options.logFilePath} — Có thể dùng tool "read_file" nếu cần xem đoạn giữa]`;
  }
  separator += '\n\n';

  const truncatedText = `${headPart}${separator}${tailPart}`;
  const truncatedLength = truncatedText.length;
  const savedChars = Math.max(0, originalLength - truncatedLength);
  const savedTokensEstimate = Math.round(savedChars / 4);

  return {
    text: truncatedText,
    truncated: true,
    originalLength,
    truncatedLength,
    savedChars,
    savedTokensEstimate,
  };
}
