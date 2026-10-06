import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nativeTruncateToolOutput } from '../native/index.js';

export interface ToolOutputSanitizationOptions {
  maxBytes?: number;
  maxLines?: number;
  workspaceRoot?: string;
}

export interface SanitizedToolOutputResult<T = Record<string, any>> {
  result: T;
  wasTruncated: boolean;
  spillFilePath?: string;
  originalBytes: number;
  sanitizedBytes: number;
}

/**
 * Lấy ngưỡng dung lượng tối đa cho output của công cụ (bytes).
 * Ưu tiên biến môi trường MINUS_MAX_TOOL_OUTPUT_KB nếu có.
 * Mặc định: 12KB (12 * 1024 bytes) ~ 3.000 tokens, sweet-spot cho KV Caching.
 */
export function getMaxToolOutputBytes(): number {
  const envKb = Number(process.env.MINUS_MAX_TOOL_OUTPUT_KB);
  if (Number.isFinite(envKb) && envKb > 0) {
    return Math.round(envKb * 1024);
  }
  return 12 * 1024;
}

/**
 * Lưu toàn bộ raw output ra đĩa khi vượt quá ngưỡng bộ nhớ.
 * Ưu tiên 1: `.minus/logs/tool_outputs/` trong workspace (đã gitignored).
 * Fallback 2: Thư mục tạm hệ điều hành `os.tmpdir()/minus_tool_logs/` nếu workspace không ghi được.
 */
export async function spillToolOutputToDisk(
  workspaceRoot: string | undefined,
  toolName: string,
  rawContent: string,
): Promise<string | undefined> {
  if (!rawContent) return undefined;

  const safeSlug = (toolName || 'tool')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 30);
  const fileName = `${Date.now()}_${safeSlug}_${Math.random().toString(36).slice(2, 6)}.log`;

  // 1. Thử lưu vào workspace/.minus/logs/tool_outputs/
  if (workspaceRoot) {
    try {
      const logsDir = path.resolve(workspaceRoot, '.minus', 'logs', 'tool_outputs');
      await fs.mkdir(logsDir, { recursive: true });
      const fullLogPath = path.join(logsDir, fileName);
      await fs.writeFile(fullLogPath, rawContent, 'utf-8');
      return path.relative(workspaceRoot, fullLogPath).replace(/\\/g, '/');
    } catch {
      // Fallback xuống os.tmpdir()
    }
  }

  // 2. Fallback lưu vào thư mục tạm OS
  try {
    const tmpLogsDir = path.join(os.tmpdir(), 'minus_tool_logs');
    await fs.mkdir(tmpLogsDir, { recursive: true });
    const fullLogPath = path.join(tmpLogsDir, fileName);
    await fs.writeFile(fullLogPath, rawContent, 'utf-8');
    return fullLogPath.replace(/\\/g, '/');
  } catch {
    return undefined;
  }
}

/**
 * Truncate một chuỗi string đơn lẻ kèm chỉ dẫn file log nếu spill-to-disk thành công.
 */
export function truncateAndAnnotateString(
  content: string,
  toolName: string,
  spillFilePath: string | undefined,
  maxLines: number = 100,
  maxBytes: number = getMaxToolOutputBytes(),
): string {
  const nativeRes = nativeTruncateToolOutput(content, maxLines, maxBytes, true);
  if (!nativeRes.wasTruncated) {
    return content;
  }

  let truncated = nativeRes.text;
  if (spillFilePath) {
    truncated += `\n[💡 FULL TOOL OUTPUT SAVED TO DISK: ${spillFilePath} — Use the "read_file" tool with line offset if you need to inspect the omitted section]`;
  } else {
    truncated += `\n[💡 OUTPUT TRUNCATED TO PREVENT CONTEXT OVERFLOW (${nativeRes.originalBytes} bytes → ${nativeRes.truncatedBytes} bytes)]`;
  }

  return truncated;
}

/**
 * Bộ lọc thông minh chặn bùng nổ token trên toàn bộ tool output payload.
 * Duyệt qua các trường văn bản hoặc mảng lớn trong result:
 * - Nếu phát hiện chuỗi văn bản vượt ngưỡng (như file content, search matches, terminal stdout):
 *   Lưu raw ra disk và cắt gọt còn 50 dòng đầu + 50 dòng cuối.
 * - Nếu toàn bộ payload JSON vượt ngưỡng:
 *   Lưu raw JSON ra disk và thu gọn mảng dữ liệu.
 */
export type SanitizedPayload<T> = T & {
  _was_truncated?: boolean;
  _spill_log_path?: string;
  _summary_notice?: string;
};

export async function sanitizeToolResultPayload<T extends Record<string, any>>(
  toolName: string,
  result: T,
  options?: ToolOutputSanitizationOptions,
): Promise<SanitizedPayload<T>> {
  if (!result || typeof result !== 'object') {
    return result as SanitizedPayload<T>;
  }

  const maxBytes = options?.maxBytes ?? getMaxToolOutputBytes();
  const maxLines = options?.maxLines ?? 100;
  const workspaceRoot = options?.workspaceRoot;

  let modified = false;
  const cloned: Record<string, any> = { ...result };

  // Danh sách các trường văn bản thường chứa dữ liệu lớn từ file reads, grep, git diff, command output
  const candidateTextFields = ['content', 'text', 'output', 'stdout', 'stderr', 'diff', 'data'];

  for (const field of candidateTextFields) {
    if (typeof cloned[field] === 'string' && cloned[field].length > 0) {
      const rawText = cloned[field] as string;
      const textByteLen = Buffer.byteLength(rawText, 'utf8');

      if (textByteLen > maxBytes) {
        const spillPath = await spillToolOutputToDisk(workspaceRoot, `${toolName}_${field}`, rawText);
        cloned[field] = truncateAndAnnotateString(rawText, toolName, spillPath, maxLines, maxBytes);
        cloned._spill_log_path = spillPath;
        cloned._was_truncated = true;
        modified = true;
      }
    }
  }

  // Kiểm tra các trường mảng lớn (như files: string[], matches: any[])
  const candidateArrayFields = ['files', 'matches', 'entries', 'items'];
  for (const field of candidateArrayFields) {
    if (Array.isArray(cloned[field]) && cloned[field].length > 60) {
      const serializedArr = JSON.stringify(cloned[field]);
      if (Buffer.byteLength(serializedArr, 'utf8') > maxBytes) {
        const rawJson = JSON.stringify(cloned, null, 2);
        const spillPath = await spillToolOutputToDisk(workspaceRoot, `${toolName}_${field}`, rawJson);
        const head = cloned[field].slice(0, 40);
        const tail = cloned[field].slice(-10);
        const omittedCount = cloned[field].length - (head.length + tail.length);

        cloned[field] = [
          ...head,
          `[... Truncated ${omittedCount} items. Full output saved to ${spillPath || 'disk'} ...]`,
          ...tail,
        ];
        cloned._spill_log_path = spillPath;
        cloned._was_truncated = true;
        modified = true;
      }
    }
  }

  // Kiểm tra tổng kích thước của toàn bộ payload JSON
  try {
    const totalJson = JSON.stringify(cloned);
    const totalBytes = Buffer.byteLength(totalJson, 'utf8');
    if (totalBytes > maxBytes * 2 && !cloned._was_truncated) {
      const spillPath = await spillToolOutputToDisk(workspaceRoot, toolName, totalJson);
      cloned._spill_log_path = spillPath;
      cloned._was_truncated = true;
      cloned._summary_notice = `[Notice: Giant payload (${totalBytes} bytes) spilled to disk: ${spillPath}]`;
      modified = true;
    }
  } catch {
    // Ignore JSON stringify errors
  }

  return (modified ? cloned : result) as SanitizedPayload<T>;
}
