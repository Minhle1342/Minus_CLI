import fs from 'node:fs';
import path from 'node:path';
import type { ToolRunner, ToolExecutionResult } from '../tools/tool-runner.js';
import type { Workspace } from '../workspace/workspace.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';

export interface PipelinedDispatchTelemetry {
  earlyDispatchedCount: number;
  pipelinedHits: number;
  timeSavedMs: number;
  speculativeDiagnosticsHits: number;
  speculativeDispatchedCount: number;
  speculativeHits: number;
  speculativeMisses: number;
  speculativeSavedMs: number;
}

export interface SpeculativeCandidate {
  toolName: string;
  args: Record<string, unknown>;
  confidence: number;
  source: 'inter-step-pattern' | 'thought-stream-intent';
}

import { CONCURRENT_READ_ONLY_TOOLS } from './tool-execution-scheduler.js';

export const SAFE_READ_ONLY_TOOLS = new Set([
  ...CONCURRENT_READ_ONLY_TOOLS,
  'find_by_name',
  'grep_search',
  'read_image',
  'list_dir',
]);

/**
 * Trích xuất đường dẫn tệp tin từ luồng suy nghĩ của LLM (Thinking Stream)
 */
export function extractThoughtPaths(thought: string, rootDir?: string): string[] {
  if (!thought || typeof thought !== 'string') return [];
  const candidates = new Set<string>();
  const verbRegex = /\b(?:read|inspect|check|view|open|cat|examine)\s+(?:the\s+)?(?:file\s+)?["'`]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_-]+)["'`]?/gi;
  let match: RegExpExecArray | null;
  while ((match = verbRegex.exec(thought)) !== null) {
    const raw = match[1]?.trim().replace(/\\/g, '/');
    if (raw && !raw.startsWith('http') && raw.length > 2 && raw.length < 180) {
      candidates.add(raw);
    }
  }
  const quotedRegex = /["'`]([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_-]+)["'`]/g;
  while ((match = quotedRegex.exec(thought)) !== null) {
    const raw = match[1]?.trim().replace(/\\/g, '/');
    if (raw && (raw.includes('/') || raw.includes('.')) && raw.length > 3 && raw.length < 180) {
      candidates.add(raw);
    }
  }

  const valid: string[] = [];
  for (const candidate of candidates) {
    const clean = candidate.replace(/^(\.\/)+/, '');
    if (rootDir) {
      const fullPath = path.resolve(rootDir, clean);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          valid.push(clean);
        }
      } catch {}
    } else {
      valid.push(clean);
    }
    // ponytail: cap at top 2 paths to avoid disk churn
    if (valid.length >= 2) break;
  }
  return valid;
}

/**
 * Dự đoán các công cụ đọc tiếp theo dựa trên kết quả của công cụ ở bước trước (Inter-Step Transition)
 */
export function predictObservationCandidates(
  lastToolName?: string,
  lastToolResult?: any,
  rootDir?: string,
): SpeculativeCandidate[] {
  if (!lastToolName || !lastToolResult) return [];
  const candidates: SpeculativeCandidate[] = [];

  if (lastToolName === 'grep_search' || lastToolName === 'search_codebase_fast' || lastToolName === 'search_text') {
    const fileHits = new Map<string, number>();
    const matches = Array.isArray(lastToolResult.matches)
      ? lastToolResult.matches
      : Array.isArray(lastToolResult)
        ? lastToolResult
        : Array.isArray(lastToolResult.files)
          ? lastToolResult.files
          : [];
    for (const item of matches) {
      const filePath = typeof item === 'string'
        ? item
        : item.file || item.filePath || item.path || item.Filename;
      if (typeof filePath === 'string') {
        const clean = filePath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
        fileHits.set(clean, (fileHits.get(clean) || 0) + 1);
      }
    }
    const sortedFiles = Array.from(fileHits.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);
    for (const file of sortedFiles.slice(0, 2)) {
      if (!rootDir || (fs.existsSync(path.resolve(rootDir, file)) && fs.statSync(path.resolve(rootDir, file)).isFile())) {
        candidates.push({
          toolName: 'read_file',
          args: { path: file },
          confidence: 0.85,
          source: 'inter-step-pattern',
        });
      }
    }
  } else if (lastToolName === 'find_by_name' || lastToolName === 'locate_files') {
    const files = Array.isArray(lastToolResult.files)
      ? lastToolResult.files
      : Array.isArray(lastToolResult.matches)
        ? lastToolResult.matches
        : [];
    for (const item of files.slice(0, 2)) {
      const p = typeof item === 'string' ? item : item.path || item.filePath;
      if (typeof p === 'string') {
        candidates.push({
          toolName: 'read_file',
          args: { path: p.replace(/\\/g, '/').replace(/^(\.\/)+/, '') },
          confidence: 0.9,
          source: 'inter-step-pattern',
        });
      }
    }
  } else if (lastToolName === 'inspect_symbol') {
    const targetFile = lastToolResult.filePath || lastToolResult.path;
    if (typeof targetFile === 'string') {
      candidates.push({
        toolName: 'read_file',
        args: { path: targetFile.replace(/\\/g, '/').replace(/^(\.\/)+/, '') },
        confidence: 0.8,
        source: 'inter-step-pattern',
      });
    }
  }

  return candidates.slice(0, 2);
}

/**
 * PipelinedToolDispatcher - Bộ điều phối thực thi Tool song song & suy đoán (Streaming Incremental Dispatch & PASTE)
 */
export class PipelinedToolDispatcher {
  private inFlightExecutions = new Map<string, { promise: Promise<ToolExecutionResult>; startTime: number }>();
  private completedExecutions = new Map<string, { result: ToolExecutionResult; readyAt: number }>();
  private speculativeKeySet = new Set<string>();
  private telemetry: PipelinedDispatchTelemetry = {
    earlyDispatchedCount: 0,
    pipelinedHits: 0,
    timeSavedMs: 0,
    speculativeDiagnosticsHits: 0,
    speculativeDispatchedCount: 0,
    speculativeHits: 0,
    speculativeMisses: 0,
    speculativeSavedMs: 0,
  };

  /**
   * Kiểm tra xem một tool có phải là an toàn / chỉ đọc (read-only) để thực thi sớm hay không
   */
  isSafeReadOnlyTool(toolName: string): boolean {
    return SAFE_READ_ONLY_TOOLS.has(toolName);
  }

  /**
   * Tạo khóa định danh duy nhất cho tool call
   */
  getCallKey(toolName: string, args: Record<string, any>, callId?: string): string {
    if (callId) return `${toolName}:${callId}`;
    try {
      return `${toolName}:${JSON.stringify(args)}`;
    } catch {
      return `${toolName}:${Date.now()}`;
    }
  }

  /**
   * Khởi chạy sớm một tool an toàn ngay khi nhận được token từ stream (Streaming Early Dispatch)
   */
  dispatchEarly(
    toolName: string,
    args: Record<string, any>,
    toolRunner: ToolRunner,
    context: any,
    callId?: string,
  ): boolean {
    if (!this.isSafeReadOnlyTool(toolName)) {
      return false;
    }

    const key = this.getCallKey(toolName, args, callId);
    if (this.inFlightExecutions.has(key) || this.completedExecutions.has(key)) {
      return true;
    }

    const startTime = Date.now();
    this.telemetry.earlyDispatchedCount++;

    const promise = toolRunner.run(toolName, args, context).then((res: any) => {
      this.inFlightExecutions.delete(key);
      this.completedExecutions.set(key, { result: res, readyAt: Date.now() });
      return res;
    }).catch((err: any) => {
      this.inFlightExecutions.delete(key);
      const fallbackResult: ToolExecutionResult = {
        toolName,
        args,
        durationMs: Date.now() - startTime,
        result: {
          error: `Streaming pipelined execution error: ${err.message}`,
          errorCode: 'STREAMING_DISPATCH_ERROR',
        },
      };
      this.completedExecutions.set(key, { result: fallbackResult, readyAt: Date.now() });
      return fallbackResult;
    });

    this.inFlightExecutions.set(key, { promise, startTime });
    return true;
  }

  /**
   * Khởi chạy suy đoán ngầm (PASTE: Pattern-Aware Speculative Tool Pre-Execution)
   * Giới hạn tối đa K=2 tác vụ suy đoán đồng thời để tránh làm nghẽn CPU và I/O.
   */
  dispatchSpeculative(
    toolName: string,
    args: Record<string, any>,
    toolRunner: ToolRunner,
    context: any,
    source: 'inter-step-pattern' | 'thought-stream-intent' = 'thought-stream-intent',
  ): boolean {
    if (!this.isSafeReadOnlyTool(toolName)) {
      return false;
    }
    // ponytail: max 2 speculative tasks per turn is plenty for 99% of read cascades
    if (this.inFlightExecutions.size >= 2) {
      return false;
    }

    const key = this.getCallKey(toolName, args);
    if (this.inFlightExecutions.has(key) || this.completedExecutions.has(key)) {
      return true;
    }

    this.speculativeKeySet.add(key);
    this.telemetry.speculativeDispatchedCount++;
    const startTime = Date.now();

    const promise = toolRunner.run(toolName, args, context).then((res: any) => {
      this.inFlightExecutions.delete(key);
      this.completedExecutions.set(key, { result: res, readyAt: Date.now() });
      return res;
    }).catch((err: any) => {
      this.inFlightExecutions.delete(key);
      const fallbackResult: ToolExecutionResult = {
        toolName,
        args,
        durationMs: Date.now() - startTime,
        result: {
          error: `Speculative execution error: ${err.message}`,
          errorCode: 'SPECULATIVE_DISPATCH_ERROR',
        },
      };
      this.completedExecutions.set(key, { result: fallbackResult, readyAt: Date.now() });
      return fallbackResult;
    });

    this.inFlightExecutions.set(key, { promise, startTime });
    return true;
  }

  /**
   * Hủy và dọn dẹp các tác vụ suy đoán không được mô hình sử dụng (Zero Side-Effects)
   */
  cancelUnmatchedSpeculative(): void {
    for (const key of this.speculativeKeySet) {
      if (this.completedExecutions.has(key)) {
        this.completedExecutions.delete(key);
        this.telemetry.speculativeMisses++;
      }
      if (this.inFlightExecutions.has(key)) {
        this.inFlightExecutions.delete(key);
        this.telemetry.speculativeMisses++;
      }
    }
    this.speculativeKeySet.clear();
  }

  /**
   * Lấy kết quả đã được thực thi sớm trong Pipeline/PASTE hoặc chờ Promise hoàn tất
   */
  async awaitOrExecute(
    toolName: string,
    args: Record<string, any>,
    toolRunner: ToolRunner,
    context: any,
    callId?: string,
  ): Promise<{ executionResult: ToolExecutionResult; wasPipelined: boolean; savedMs: number }> {
    const key = this.getCallKey(toolName, args, callId);

    // 1. Nếu kết quả đã chạy xong từ trước trong stream/PASTE
    if (this.completedExecutions.has(key)) {
      const { result, readyAt } = this.completedExecutions.get(key)!;
      this.completedExecutions.delete(key);
      const savedMs = Math.max(0, result.durationMs);
      this.telemetry.pipelinedHits++;
      if (this.speculativeKeySet.has(key)) {
        this.telemetry.speculativeHits++;
        this.telemetry.speculativeSavedMs += savedMs;
        this.speculativeKeySet.delete(key);
      }
      this.telemetry.timeSavedMs += savedMs;
      return { executionResult: result, wasPipelined: true, savedMs };
    }

    // 2. Nếu đang chạy dở trong background stream/PASTE
    if (this.inFlightExecutions.has(key)) {
      const { promise, startTime } = this.inFlightExecutions.get(key)!;
      this.inFlightExecutions.delete(key);
      const result = await promise;
      this.completedExecutions.delete(key);
      const elapsedSinceStart = Date.now() - startTime;
      const savedMs = Math.max(0, result.durationMs - Math.max(0, elapsedSinceStart - result.durationMs));
      this.telemetry.pipelinedHits++;
      if (this.speculativeKeySet.has(key)) {
        this.telemetry.speculativeHits++;
        this.telemetry.speculativeSavedMs += savedMs;
        this.speculativeKeySet.delete(key);
      }
      this.telemetry.timeSavedMs += savedMs;
      return { executionResult: result, wasPipelined: true, savedMs };
    }

    // 3. Nếu chưa được dispatch sớm -> Chạy bình thường
    const executionResult = await toolRunner.run(toolName, args, context);
    return { executionResult, wasPipelined: false, savedMs: 0 };
  }

  /**
   * Kích hoạt Speculative Diagnostics ngầm sau khi chỉnh sửa file
   */
  triggerSpeculativeDiagnostics(filePath: string, workspace: Workspace): void {
    if (!filePath) return;
    setImmediate(async () => {
      try {
        await CodeSyntaxValidator.speculativeValidate(filePath, workspace);
        this.telemetry.speculativeDiagnosticsHits++;
      } catch {}
    });
  }

  /**
   * Xóa sạch các in-flight promise khi turn kết thúc
   */
  resetTurn(): void {
    this.cancelUnmatchedSpeculative();
    this.inFlightExecutions.clear();
    this.completedExecutions.clear();
  }

  getTelemetry(): PipelinedDispatchTelemetry {
    return { ...this.telemetry };
  }
}
