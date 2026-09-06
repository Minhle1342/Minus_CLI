import type { ToolRunner, ToolExecutionResult } from '../tools/tool-runner.js';
import type { Workspace } from '../workspace/workspace.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';

export interface PipelinedDispatchTelemetry {
  earlyDispatchedCount: number;
  pipelinedHits: number;
  timeSavedMs: number;
  speculativeDiagnosticsHits: number;
}

export const SAFE_READ_ONLY_TOOLS = new Set([
  'read_file',
  'find_by_name',
  'grep_search',
  'inspect_symbol',
  'get_diagnostics',
  'read_image',
  'list_dir',
]);

/**
 * PipelinedToolDispatcher - Bộ điều phối thực thi Tool song song & suy đoán (Streaming Incremental Dispatch)
 * 
 * Áp dụng kiến trúc Pipeline tương tự Claude Code / Codex CLI:
 * 1. Khi Token Stream đang sinh tool call read-only, ngay lập tức nạp I/O và thực thi bất đồng bộ ngầm.
 * 2. Khi LLM kết thúc turn và AgentLoop đến bước dispatch, kết quả đã CÓ SẴN (0ms wait).
 * 3. Ngay sau khi file bị sửa đổi, kích hoạt Speculative Diagnostics ngầm để CriticGate nghiệm thu tức thì.
 */
export class PipelinedToolDispatcher {
  private inFlightExecutions = new Map<string, { promise: Promise<ToolExecutionResult>; startTime: number }>();
  private completedExecutions = new Map<string, { result: ToolExecutionResult; readyAt: number }>();
  private telemetry: PipelinedDispatchTelemetry = {
    earlyDispatchedCount: 0,
    pipelinedHits: 0,
    timeSavedMs: 0,
    speculativeDiagnosticsHits: 0,
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
   * Lấy kết quả đã được thực thi sớm trong Pipeline hoặc chờ Promise hoàn tất
   */
  async awaitOrExecute(
    toolName: string,
    args: Record<string, any>,
    toolRunner: ToolRunner,
    context: any,
    callId?: string,
  ): Promise<{ executionResult: ToolExecutionResult; wasPipelined: boolean; savedMs: number }> {
    const key = this.getCallKey(toolName, args, callId);

    // 1. Nếu kết quả đã chạy xong từ trước trong stream
    if (this.completedExecutions.has(key)) {
      const { result, readyAt } = this.completedExecutions.get(key)!;
      this.completedExecutions.delete(key);
      const savedMs = Math.max(0, result.durationMs);
      this.telemetry.pipelinedHits++;
      this.telemetry.timeSavedMs += savedMs;
      return { executionResult: result, wasPipelined: true, savedMs };
    }

    // 2. Nếu đang chạy dở trong background stream
    if (this.inFlightExecutions.has(key)) {
      const { promise, startTime } = this.inFlightExecutions.get(key)!;
      this.inFlightExecutions.delete(key);
      const result = await promise;
      this.completedExecutions.delete(key);
      const elapsedSinceStart = Date.now() - startTime;
      const savedMs = Math.max(0, result.durationMs - Math.max(0, elapsedSinceStart - result.durationMs));
      this.telemetry.pipelinedHits++;
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
    this.inFlightExecutions.clear();
    this.completedExecutions.clear();
  }

  getTelemetry(): PipelinedDispatchTelemetry {
    return { ...this.telemetry };
  }
}
