import type { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';
import { ErrorDetective, type ErrorDetectiveReport } from './error-detective.js';

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
  detectiveReport?: ErrorDetectiveReport;
}

export function isExploratoryCommand(
  command: string,
  context?: { hasCodeMutations?: boolean; phase?: string; isReproduction?: boolean },
): boolean {
  const trimmed = (command || '').trim();
  if (!trimmed) return false;

  // 1. Lệnh tìm kiếm / định vị (exit code 1 thường chỉ là không tìm thấy kết quả)
  if (/^(?:grep|rg|ripgrep|findstr|find|where|which|dir|ls)\b/i.test(trimmed)) {
    return true;
  }

  // 2. Lệnh Git kiểm tra trạng thái / diff / log
  if (/^git\s+(?:status|diff|log|show|rev-parse|branch)\b/i.test(trimmed)) {
    return true;
  }

  // 3. Lệnh chạy test khi đang ở pha tái hiện lỗi (reproduce phase) hoặc chưa có bất kỳ code mutation nào
  if (context?.isReproduction || context?.phase === 'reproduce' || context?.hasCodeMutations === false) {
    return true;
  }

  return false;
}

/**
 * ReflectionEngine - Động cơ Tự vấn & Quy trình Gỡ lỗi Thông minh (Codex CLI Standard + Error Detective)
 * 
 * Ngăn chặn tình trạng Agent "đoán mò" và lặp lại thao tác sai:
 * 1. Nhận diện các thất bại khi chạy lệnh (exitCode !== 0) hoặc lỗi sửa file.
 * 2. Tích hợp trực tiếp Language Server Protocol (LSP / TypeScript Diagnostics) theo thời gian thực.
 * 3. Tích hợp ErrorDetective: bóc tách stack trace đa ngôn ngữ và truy vết nguyên nhân gốc rễ (Causal RCA).
 * 4. Tự động sinh ra hướng dẫn Debugging Protocol & Hypothesis Falsification có cấu trúc cho LLM.
 * 5. Đếm số lần thất bại liên tiếp và cảnh báo khi Agent đi vào ngõ cụt.
 */
export class ReflectionEngine {
  private consecutiveFailures: number = 0;
  private maxConsecutiveFailuresBeforeWarning: number = 2;
  readonly detective = new ErrorDetective();
  private lastDetectiveReport?: ErrorDetectiveReport;
  private lastReflectionPrompt?: string;

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

    // 2. Fallback: Parse từ stderr/stdout bằng Regex
    const rawText = `${feedback.result.stderr || ''}\n${feedback.result.stdout || ''}`;
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
  analyze(
    feedback: ToolExecutionFeedback,
    workspace?: Workspace,
    context?: { hasCodeMutations?: boolean },
  ): ReflectionAnalysis {
    const { toolName, result } = feedback;
    let isFailure = false;
    let reflectionPrompt: string | undefined;
    let advice: string | undefined;
    let diagnostics: DiagnosticItem[] = [];
    let detectiveReport: ErrorDetectiveReport | undefined;

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
    // 2. Phân tích lệnh run_command thất bại (test failed, build error, syntax error) qua Error Detective
    else if (toolName === 'run_command' && result.exitCode !== undefined && result.exitCode !== 0) {
      const commandStr = String(feedback.args?.command || result.command || '');
      const isExploratory = isExploratoryCommand(commandStr, context);

      if (isExploratory) {
        // Miễn trừ: Lệnh tìm kiếm / Git diff hoặc test ở pha tái hiện lỗi ban đầu không bị coi là failure nghiêm trọng
        isFailure = false;
        this.lastDetectiveReport = undefined;
        this.lastReflectionPrompt = undefined;
        return {
          isFailure: false,
          consecutiveFailures: this.consecutiveFailures,
          advice: `Exploratory command returned exit code ${result.exitCode} (non-blocking).`,
        };
      }

      isFailure = true;
      this.consecutiveFailures++;

      const rawCombined = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error || ''}`;
      detectiveReport = this.detective.investigate(rawCombined, workspace);
      this.lastDetectiveReport = detectiveReport;

      const errorSnippet = (result.stderr || result.stdout || '').trim().slice(0, 1000);

      const promptParts = [
        `\n⚠️ [DEBUGGING PROTOCOL TRIGGERED - COMMAND EXECUTION FAILED (Exit Code: ${result.exitCode})]`,
        `Error output:`,
        `----------------------------------------`,
        errorSnippet || '(No stderr output)',
        `----------------------------------------`,
      ];

      if (detectiveReport.primaryDefect) {
        promptParts.push(
          `Defect: ${detectiveReport.primaryDefect}${detectiveReport.location ? ` at ${detectiveReport.location}` : ''}${detectiveReport.immediateFix ? ` | Suggested Fix: ${detectiveReport.immediateFix}` : ''}`,
        );
      }

      // Level 1: Lần lỗi đầu tiên - giữ context gọn gàng, không nhồi nhét quy tắc phương pháp luận
      if (this.consecutiveFailures <= 1) {
        promptParts.push(`👉 Inspect the error output above and resolve the defect.`);
      } else {
        // Level 2+: Khi lỗi lặp lại từ lần 2 trở đi - mới bổ sung hướng dẫn phương pháp luận sâu và chặn lặp
        if (detectiveReport.promptGuidance) {
          promptParts.push(detectiveReport.promptGuidance);
        } else {
          promptParts.push(
            `👉 SELF-REFLECTION & DEBUGGING PROTOCOL:`,
            `1. [Read Stack Trace]: Identify the exact file, line number, and error message causing the failure above.`,
            `2. [Inspect State & Diff]: Use git_diff or read_file to inspect recent changes.`,
            `3. [Formulate Hypothesis]: Clearly state a root cause hypothesis before mutating code.`,
            `4. [Anti-Loop Invariant]: DO NOT repeat the exact same failing command or tool arguments!`,
          );
        }
      }

      reflectionPrompt = promptParts.join('\n');
      advice = detectiveReport.primaryDefect
        ? `Command failed (exit: ${result.exitCode}): ${detectiveReport.primaryDefect}${detectiveReport.failingSourceLine ? ` | Failing code: ${detectiveReport.failingSourceLine}` : ''}`
        : `Command failed (exit: ${result.exitCode}).`;
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

    // 7. Bổ sung LSP / TypeScript Diagnostics & ErrorDetective vào Reflection Prompt nếu phát hiện lỗi compiler
    if (isFailure) {
      diagnostics = this.extractLspDiagnostics(feedback, workspace);
      if (detectiveReport?.extractedErrors && detectiveReport.extractedErrors.length > 0) {
        const detectiveDiags = this.detective.toDiagnosticItems(detectiveReport.extractedErrors);
        for (const d of detectiveDiags) {
          if (!diagnostics.some((existing) => existing.file === d.file && existing.line === d.line)) {
            diagnostics.push(d);
          }
        }
      }

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

    this.lastReflectionPrompt = reflectionPrompt;

    return {
      isFailure,
      reflectionPrompt,
      consecutiveFailures: this.consecutiveFailures,
      advice,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      hypothesisFalsified: isFailure,
      detectiveReport,
    };
  }

  getLastDetectiveReport(): ErrorDetectiveReport | undefined {
    return this.lastDetectiveReport;
  }

  getLastReflectionPrompt(): string | undefined {
    return this.lastReflectionPrompt;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastDetectiveReport = undefined;
    this.lastReflectionPrompt = undefined;
  }
}
