import type { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';

export interface ToolExecutionFeedback {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
  durationMs: number;
}

export interface ReflectionAnalysis {
  isFailure: boolean;
  reflectionPrompt?: string;
  consecutiveFailures: number;
  advice?: string;
  diagnostics?: DiagnosticItem[];
  hypothesisFalsified?: boolean;
}

/**
 * ReflectionEngine - Động cơ Tự vấn & Quy trình Gỡ lỗi Thông minh (Codex CLI Standard)
 * 
 * Ngăn chặn tình trạng Agent "đoán mò" và lặp lại thao tác sai:
 * 1. Nhận diện các thất bại khi chạy lệnh (exitCode !== 0) hoặc lỗi sửa file.
 * 2. Tích hợp trực tiếp Language Server Protocol (LSP / TypeScript Diagnostics) theo thời gian thực.
 * 3. Tự động sinh ra hướng dẫn Debugging Protocol & Hypothesis Falsification có cấu trúc cho LLM.
 * 4. Đếm số lần thất bại liên tiếp và cảnh báo khi Agent đi vào ngõ cụt.
 */
export class ReflectionEngine {
  private consecutiveFailures: number = 0;
  private maxConsecutiveFailuresBeforeWarning: number = 2;

  /**
   * Trích xuất các lỗi TypeScript (TSxxxx) từ output hoặc Language Service trong RAM
   */
  private extractLspDiagnostics(feedback: ToolExecutionFeedback, workspace?: Workspace): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];

    // 1. Kiểm tra qua in-memory TypeScript Language Service nếu có workspace
    if (workspace) {
      try {
        const targetPath = feedback.args?.path ? String(feedback.args.path) : undefined;
        if (targetPath && (targetPath.endsWith('.ts') || targetPath.endsWith('.tsx') || targetPath.endsWith('.js') || targetPath.endsWith('.jsx'))) {
          const tsService = getOrCreateTypeScriptService(workspace);
          const inMemoryDiags = tsService.getDiagnostics(targetPath);
          const errors = inMemoryDiags.filter((d) => d.category === 'error');
          if (errors.length > 0) {
            diagnostics.push(...errors.slice(0, 5));
          }
        }
      } catch {
        // Bỏ qua nếu workspace không phải TS project
      }
    }

    // 2. Parse nhanh regex TSxxxx từ stderr / stdout
    const rawText = `${feedback.result.stderr || ''}\n${feedback.result.stdout || ''}\n${feedback.result.error || ''}`;
    const tsRegex = /([a-zA-Z0-9_\-\/\.]+\.tsx?)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.+)/g;
    let match;
    while ((match = tsRegex.exec(rawText)) !== null) {
      const [, file, line, col, codeStr, message] = match;
      const codeNum = parseInt(codeStr.replace('TS', ''), 10) || 0;
      if (!diagnostics.some((d) => d.file === file && d.line === parseInt(line, 10))) {
        diagnostics.push({
          file,
          line: parseInt(line, 10),
          character: parseInt(col, 10),
          code: codeNum,
          category: 'error',
          message: `[${codeStr}] ${message}`,
        });
      }
    }

    return diagnostics;
  }

  /**
   * Phân tích kết quả thực thi của Tool và xác định xem có cần kích hoạt Self-Reflection hay không
   */
  analyze(feedback: ToolExecutionFeedback, workspace?: Workspace): ReflectionAnalysis {
    const { toolName, result } = feedback;
    let isFailure = false;
    let reflectionPrompt: string | undefined;
    let advice: string | undefined;
    let diagnostics: DiagnosticItem[] = [];

    const environmentFailureCodes = new Set([
      'COMMAND_NOT_FOUND',
      'COMMAND_NOT_EXECUTABLE',
      'COMMAND_TIMEOUT',
      'COMMAND_RESOURCE_LIMIT',
      'NATIVE_DEPENDENCY_MISSING',
      'PACKAGE_DEPENDENCY_MISSING',
      'MULTIPLE_RUNTIMES_REQUIRED',
      'RUNTIME_SANDBOX_INIT_FAILED',
    ]);

    // 1. Lỗi môi trường/runtime cần hướng dẫn khắc phục, không phải phân tích stack trace mã nguồn.
    if (toolName === 'run_command' && environmentFailureCodes.has(result.errorCode)) {
      isFailure = true;
      this.consecutiveFailures++;
      const details = result.diagnostic || result.stderr || result.errorCode;
      const suggestion = result.suggestion || 'Correct the execution environment before retrying.';
      reflectionPrompt = [
        `\n⚠️ [EXECUTION ENVIRONMENT FAILURE - ${result.errorCode}]`,
        details,
        `👉 ${suggestion}`,
        `Do not inspect application stack traces or retry the same command unchanged because the process did not start successfully.`,
      ].join('\n');
      advice = `${result.errorCode}: ${details}`;
    }
    // 2. Phân tích lệnh run_command thất bại (test failed, build error, syntax error)
    else if (toolName === 'run_command' && result.exitCode !== undefined && result.exitCode !== 0) {
      isFailure = true;
      this.consecutiveFailures++;

      const errorSnippet = (result.stderr || result.stdout || '').trim().slice(0, 1000);

      reflectionPrompt = [
        `\n⚠️ [DEBUGGING PROTOCOL TRIGGERED - COMMAND EXECUTION FAILED (Exit Code: ${result.exitCode})]`,
        `Error output:`,
        `----------------------------------------`,
        errorSnippet || '(No stderr output)',
        `----------------------------------------`,
        `👉 SELF-REFLECTION & DEBUGGING PROTOCOL:`,
        `1. [Read Stack Trace]: Identify the exact file, line number, and error message causing the failure above.`,
        `2. [Inspect State & Diff]: Use git_diff or read_file to inspect recent changes.`,
        `3. [Formulate Hypothesis]: Clearly state a root cause hypothesis before mutating code.`,
        `4. [Anti-Loop Invariant]: DO NOT repeat the exact same failing command or tool arguments!`,
      ].join('\n');

      advice = `Command failed (exit: ${result.exitCode}). Triggering debugging protocol and stack trace analysis.`;
    } 
    // 3. Phân tích lỗi áp dụng patch apply_patch
    else if (toolName === 'apply_patch' && (result.error || result.errorCode)) {
      isFailure = true;
      this.consecutiveFailures++;

      const details = result.diagnostic || result.error || result.errorCode;
      const failedHunkMsg = result.failedHunkNumber ? ` (Hunk #${result.failedHunkNumber})` : '';
      const targetFileMsg = result.failedFile ? ` for file "${result.failedFile}"` : '';
      const suggestedReadMsg = result.suggestedRead
        ? `Call read_file with parameters: ${JSON.stringify(result.suggestedRead)}.`
        : 'Use read_file to inspect the exact current lines and context in the target file.';

      reflectionPrompt = [
        `\n⚠️ [SELF-REFLECTION - PATCH APPLICATION FAILED${failedHunkMsg}${targetFileMsg}]`,
        `Error code: ${result.errorCode || 'PATCH_APPLY_FAILED'}`,
        `Details: ${details}`,
        `💡 CODEX CLI HUNK RECOVERY PROTOCOL:`,
        `1. ${suggestedReadMsg}`,
        `2. Recommended Fallback: Use "replace_text" with exact oldText from read_file for 100% deterministic mutation.`,
        `3. If creating a new patch: Narrow context lines in @@ hunks to 1 unique line to eliminate drift.`,
      ].join('\n');

      advice = `apply_patch failed${failedHunkMsg} (${result.errorCode || 'unknown'}). Read exact file region before retrying.`;
    }
    // 4. Phân tích lỗi sửa file replace_text không khớp
    else if (toolName === 'replace_text' && result.error) {
      isFailure = true;
      this.consecutiveFailures++;

      const suggestedRead = result.suggestedRead
        ? `Call read_file with parameters: ${JSON.stringify(result.suggestedRead)}.`
        : 'Call read_file over a narrow line range with includeLineNumbers=false.';

      reflectionPrompt = [
        `\n⚠️ [SELF-REFLECTION - TEXT REPLACEMENT FAILED]`,
        `Error code: ${result.errorCode || 'REPLACE_TEXT_FAILED'}`,
        `Reason: ${result.error}`,
        `💡 ${suggestedRead}`,
        `Use raw content without line numbers as oldText, pass contentHash as expectedFileHash, and do not repeat identical failing parameters.`,
      ].join('\n');

      advice = `replace_text failed (${result.errorCode || 'unknown'}). Read exact file region before retrying.`;
    }
    // 5. Phân tích lỗi cập nhật kế hoạch update_plan_task
    else if (toolName === 'update_plan_task' && (result.error || result.errorCode)) {
      isFailure = true;
      this.consecutiveFailures++;

      reflectionPrompt = [
        `\n⚠️ [PLAN MANAGEMENT ERROR - UPDATE TASK FAILED]`,
        `Error code: ${result.errorCode || 'PLAN_UPDATE_FAILED'}`,
        `Error details: ${result.error}`,
        result.hint ? `💡 Hint: ${result.hint}` : '',
        `👉 ADJUSTMENT RULES:`,
        `1. If no plan exists: Call "create_plan" first with a tasks array (e.g. [{ title: "Inspect files" }, { title: "Implement code" }, { title: "Verify" }]).`,
        `2. If this is a simple task: Do not call "update_plan_task"; execute tools directly or answer immediately.`,
        `3. If evidence is required: Call the corresponding inspection/mutation/verification tool first before marking COMPLETED.`,
        `4. DO NOT call update_plan_task with the same invalid parameters again!`,
      ].filter(Boolean).join('\n');

      advice = `update_plan_task failed (${result.errorCode || 'error'}). Create plan first via create_plan or execute directly.`;
    }
    // 6. Phân tích lỗi chung khác
    else if (result.error || result.errorCode) {
      isFailure = true;
      this.consecutiveFailures++;

      reflectionPrompt = [
        `\n⚠️ [TOOL EXECUTION ERROR]`,
        `Error encountered: ${result.error || result.errorCode}`,
        `💡 Analyze the root cause and adjust tool arguments.`,
      ].join('\n');

      advice = `Tool execution error: ${result.error || result.errorCode}`;
    } 
    // 6. Nếu thành công -> Reset bộ đếm thất bại liên tiếp
    else {
      this.consecutiveFailures = 0;
    }

    // 7. Bổ sung LSP / TypeScript Diagnostics vào Reflection Prompt nếu phát hiện lỗi compiler
    if (isFailure) {
      diagnostics = this.extractLspDiagnostics(feedback, workspace);
      if (diagnostics.length > 0) {
        const diagLines = diagnostics.map(
          (d) => `  • [TS${d.code}] ${d.file}:${d.line}:${d.character} - ${d.message}`,
        );
        const lspSection = [
          `\n🔍 [LSP COMPILER & TYPE DIAGNOSTICS DETECTED]:`,
          ...diagLines,
          `💡 LSP ACTIONABLE FIX GUIDANCE:`,
          `  - Use "inspect_symbol" to inspect symbol definitions and type signatures.`,
          `  - Use "get_diagnostics" to re-verify the modified file.`,
        ].join('\n');

        reflectionPrompt = reflectionPrompt ? `${reflectionPrompt}\n${lspSection}` : lspSection;
      }
    }

    // Cảnh báo nếu Agent thất bại liên tiếp nhiều lần
    if (this.consecutiveFailures >= this.maxConsecutiveFailuresBeforeWarning && isFailure) {
      reflectionPrompt += `\n🚨 [WARNING]: You have failed ${this.consecutiveFailures} consecutive times! Stop, re-evaluate your strategy, or break the task into simpler steps.`;
    }

    return {
      isFailure,
      reflectionPrompt,
      consecutiveFailures: this.consecutiveFailures,
      advice,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      hypothesisFalsified: isFailure,
    };
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}
