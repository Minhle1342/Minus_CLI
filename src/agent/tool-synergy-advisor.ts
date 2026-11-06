import type { ToolFailureDiagnosis } from '../tools/tool-use-guardian.js';
import { ROOT_CAUSE_STEPS } from '../llm/sections/shared.js';
import { isMutationTool } from '../tools/diff-generator.js';
import { decideReliableToolRoute, type TrajectoryStep } from './reliable-tool-orchestration.js';
import { isToolResultFailure, isVerificationCommand } from './completion-evidence.js';

export { ROOT_CAUSE_STEPS };

export interface ToolSynergyContext {
  lastToolName?: string;
  lastToolResult?: any;
  hasErrors?: boolean;
  activeTaskTitle?: string;
  activeTaskAcceptance?: string;
  hasRunningBackgroundTasks?: boolean;
  hasSharedContextConflicts?: boolean;
  guardianDiagnosis?: ToolFailureDiagnosis;
  userRequest?: string;
  hasSubmittedSolution?: boolean;
  trajectory?: TrajectoryStep[];
  evidenceSufficient?: boolean;
  reflexionMemo?: string;
  repairCyclesExhausted?: boolean;
  lastTargetFile?: string;
  callGraphContext?: {
    symbol?: string;
    callers?: string[];
    callees?: string[];
  };
}

export interface ToolAdvice {
  playbook: 'A_DISCOVERY' | 'B_DEBUGGING' | 'C_MUTATION' | 'D_ASYNC_CLI' | 'E_MULTI_AGENT' | 'F_PLAN_LIFECYCLE' | 'G_BLAST_RADIUS' | 'H_BROWSER' | 'GENERAL';
  guidance: string;
  suggestedTools: string[];
}

export function detectBugReportIntent(text?: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Strip feature/build phrases first so "Fix crash in error handling middleware"
  // still detects the real bug signal outside the excluded phrase.
  const stripped = lower.replace(/\b(failover|error handling|error recovery|error message|error log|error boundary|validation error|failure mode|failure recovery|bug tracker dashboard)\b/g, ' ');
  return /\b(lỗi|bị lỗi|fix bug|sửa bug|bug|crash|crashed|exception|traceback|failed|failing|error|bị hỏng|không chạy được|fail)\b/.test(stripped);
}

// Single canonical protocol wording (defined in sections/shared); branches below only add context + tools.

/**
 * ToolSynergyAdvisor
 * 
 * Bộ não Điều phối Công cụ Động (Dynamic Tool Synergy & Playbook Engine)
 * theo chuẩn OpenAI Codex CLI & Google Antigravity CLI:
 * 
 * 1. Phân tích hành vi & kết quả của tool vừa chạy.
 * 2. Xác định Playbook chuẩn tắc (A -> F) phù hợp nhất với trạng thái hiện tại.
 * 3. Sinh chỉ dẫn hành động kế tiếp (Next-Action Tool Advice) súc tích để dẫn hướng LLM,
 *    ngăn chặn tình trạng "Loãng ngữ cảnh" (Context Dilution) và dùng tool mò mẫm.
 */
export class ToolSynergyAdvisor {
  advise(context: ToolSynergyContext): ToolAdvice {
    const {
      lastToolName,
      lastToolResult,
      hasErrors,
      activeTaskTitle,
      hasRunningBackgroundTasks,
      hasSharedContextConflicts,
      userRequest,
    } = context;

    // 0. Phát hiện người dùng báo lỗi trong prompt (User Bug Report Intent) ngay turn đầu
    if (!lastToolName && detectBugReportIntent(userRequest)) {
      return {
        playbook: 'B_DEBUGGING',
        guidance: `[ROOT-CAUSE:REPORT] User reported a bug or error. Do not guess or monkey-patch. Protocol: ${ROOT_CAUSE_STEPS} via run_command (rg) / read_file. Investigate in proportion to risk and pivot only after repeated equivalent failure or falling confidence.`,
        suggestedTools: ['run_command', 'read_file'],
      };
    }

    // 1. Xung đột Khóa Lạc Quan OCC trong Multi-Agent (Playbook E)
    if (hasSharedContextConflicts || (lastToolResult && lastToolResult.conflict)) {
      return {
        playbook: 'E_MULTI_AGENT',
        guidance: 'OCC Version Conflict detected on a shared context key. Re-read the current file content with "read_file" before attempting the write again.',
        suggestedTools: ['read_file', 'replace_text'],
      };
    }

    // 2. Vừa chạy Background Task hoặc Lệnh Dài hạn (Playbook D)
    if (
      lastToolResult?.isBackgroundTask ||
      lastToolName === 'run_command' && lastToolResult?.taskId ||
      hasRunningBackgroundTasks
    ) {
      return {
        playbook: 'D_ASYNC_CLI',
        guidance: 'Background task is active. Wait reactively for completion or use "manage_task(send_input)" if interactive prompt is waiting.',
        suggestedTools: ['manage_task'],
      };
    }

    // 2.5. Fast-path: run_command vừa chạy test thành công → tái sử dụng bằng chứng, kết luận (Step Efficiency Boost)
    if (
      lastToolName === 'run_command' &&
      lastToolResult &&
      !isToolResultFailure(lastToolResult) &&
      lastToolResult.processStarted !== false &&
      !lastToolResult.dryRun &&
      !['running', 'pending', 'background', 'started'].includes(lastToolResult.status) &&
      lastToolResult.exitCode === 0 &&
      typeof lastToolResult.command === 'string' &&
      isVerificationCommand(lastToolResult.command)
    ) {
      return {
        playbook: 'C_MUTATION',
        guidance: 'The observed verification command completed with exit 0. Reuse this evidence; check the active task acceptance criteria, evidence freshness and remaining authorized workflow before concluding the turn. Do not infer that unrelated checks passed.',
        suggestedTools: [],
      };
    }

    // 3. Vừa sửa đổi code (Playbook C: Safe Mutation & Verification)
    if (lastToolName && isMutationTool(lastToolName)) {
      if (lastToolResult && !lastToolResult.error) {
        const blast = lastToolResult.blastRadius;
        const graphAdvice = (context.callGraphContext?.symbol && context.callGraphContext?.callers && context.callGraphContext.callers.length > 0)
          ? ` [Graph Intelligence]: Symbol "${context.callGraphContext.symbol}" is invoked by: [${context.callGraphContext.callers.slice(0, 3).join(', ')}]. Verify caller expectations before finishing mutation.`
          : '';

        if (blast) {
          const testAdvice = blast.impactedTestSuites?.length > 0
            ? ` Impacted test suite(s): ${blast.impactedTestSuites.slice(0, 2).join(', ')}. Run targeted test via "run_command".`
            : ' Next, call "run_command" for targeted tests/typecheck to verify.';
          const consumerAdvice = blast.directConsumers?.length > 0
            ? ` ${blast.directConsumers.length} direct consumer file(s) affected.`
            : '';
          const symbolAdvice = blast.modifiedSymbols?.length > 0
            ? ` Modified symbols: ${blast.modifiedSymbols.slice(0, 3).join(', ')}.`
            : '';
          const riskPrefix = blast.risk ? `[Blast Radius: ${blast.risk}] ` : '';

          return {
            playbook: 'C_MUTATION',
            guidance: `${riskPrefix}Code mutation applied.${symbolAdvice}${consumerAdvice}${graphAdvice}${testAdvice}`,
            suggestedTools: ['run_command'],
          };
        }

        return {
          playbook: 'C_MUTATION',
          guidance: `Code was modified.${graphAdvice} Next, run targeted tests/typecheck via "run_command" to verify the change.`,
          suggestedTools: ['run_command'],
        };
      }
    }

    // 3.5. Cảnh báo lỗi và gợi ý công cụ thay thế từ Tool Use Guardian (Playbook B: Root Cause Debugging)
    const guardianDiag = context.guardianDiagnosis || lastToolResult?.guardianDiagnosis;
    if (guardianDiag) {
      const alternatives = guardianDiag.suggestedAlternative
        ? [guardianDiag.suggestedAlternative]
        : [];
      return {
        playbook: 'B_DEBUGGING',
        guidance: `[TOOL GUARDIAN ADVISORY]: Tool "${lastToolName || 'unknown'}" failed with ${guardianDiag.category}. ${guardianDiag.recoveryAction}`,
        suggestedTools: alternatives.length > 0
          ? alternatives
          : ['run_command', 'read_file'],
      };
    }

    // 3.9. LATS Backtracking khi đã cạn kiệt chu kỳ sửa lỗi (3+ lần thất bại)
    if (context.repairCyclesExhausted) {
      const memoText = context.reflexionMemo ? ` Failure reflection: ${context.reflexionMemo}` : '';
      return {
        playbook: 'B_DEBUGGING',
        guidance: `[LATS BACKTRACKING] Repeated repair attempts failed. Stop speculative edits and re-evaluate the causal hypothesis. Failures do not authorize Git restore, reset, stash or discarding workspace changes. Only use a rollback explicitly authorized for the affected scope.${memoText}`,
        suggestedTools: ['run_command', 'read_file'],
      };
    }

    // 4. Phát hiện lỗi Compiler / Test Failure / Lỗi Thực thi (Playbook B: Root Cause Debugging)
    if (
      hasErrors ||
      (lastToolResult && (lastToolResult.error || (Array.isArray(lastToolResult.diagnostics) && lastToolResult.diagnostics.length > 0)))
    ) {
      const graphTrace = context.callGraphContext?.symbol
        ? ` [Graph Trace]: Defect locus "${context.callGraphContext.symbol}"${context.callGraphContext.callers?.length ? ` invoked by [${context.callGraphContext.callers.slice(0, 3).join(', ')}]` : ''}${context.callGraphContext.callees?.length ? ` calls [${context.callGraphContext.callees.slice(0, 3).join(', ')}]` : ''}.`
        : '';
      return {
        playbook: 'B_DEBUGGING',
        guidance: `[ROOT-CAUSE:FAIL] Error or test failure detected. Never monkey-patch crash sites or repeat failing commands without revising the hypothesis. Protocol: ${ROOT_CAUSE_STEPS}.${graphTrace} Use the newest feedback to pivot after repeated equivalent failure.`,
        suggestedTools: ['run_command', 'read_file', 'replace_text'],
      };
    }

    // 5. Deterministic broad-to-narrow retrieval routing. This is guidance-only
    // here; AgentLoop enforcement remains separately feature-gated and fail-open.
    if (
      activeTaskTitle
      || userRequest
      || ['run_command', 'search_text', 'read_file'].includes(lastToolName || '')
    ) {
      const route = decideReliableToolRoute({
        userRequest: userRequest || activeTaskTitle,
        lastToolName,
        lastToolResult,
        trajectory: context.trajectory,
        evidenceSufficient: context.evidenceSufficient,
      });
      const argsHint = route.suggestedArgs ? ` Suggested args: ${JSON.stringify(route.suggestedArgs)}.` : '';
      return {
        playbook: route.stage === 'ready_for_mutation' ? 'G_BLAST_RADIUS' : 'A_DISCOVERY',
        guidance: `[Reliable retrieval: ${route.stage}] ${route.guidance}${argsHint}`,
        suggestedTools: [route.selectedTool, ...route.fallbackTools]
          .filter((tool): tool is string => Boolean(tool))
          .filter((tool, index, tools) => tools.indexOf(tool) === index),
      };
    }

    // 6. Mặc định: Hướng dẫn chuỗi hành vi tổng quát
    return {
      playbook: 'GENERAL',
      guidance: 'Explore workspace with run_command (ls, dir, rg), inspect implementation details with read_file, edit with replace_text or write_file, and verify with run_command.',
      suggestedTools: ['run_command', 'read_file', 'replace_text', 'write_file'],
    };
  }

  /**
   * Định dạng lời khuyên thành chuỗi text ngắn gọn chèn vào Dynamic Execution Context
   */
  formatAdvicePrompt(context: ToolSynergyContext): string {
    const advice = this.advise(context);
    if (advice.playbook === 'A_DISCOVERY' || advice.playbook === 'GENERAL') {
      return '';
    }
    const CANONICAL_VISIBLE_TOOLS = new Set([
      'run_command',
      'read_file',
      'write_file',
      'replace_text',
      'web_search',
      'web_fetch',
      'manage_task',
    ]);
    const ADVICE_TOOL_MAP: Record<string, string> = {
      search_codebase_fast: 'run_command',
      tools_search: 'run_command',
      list_files: 'run_command',
      search_text: 'run_command',
      delete_file: 'run_command',
      write_to_file: 'write_file',
      create_file: 'write_file',
      replace_file_content: 'replace_text',
      multi_replace_file_content: 'replace_text',
      search_web: 'web_search',
      read_url_content: 'web_fetch',
      // Phantoms from removed tool modules: map before the prompt is emitted.
      view_file: 'read_file',
      inspect_symbol: 'read_file',
      read_compressed_code: 'read_file',
      get_symbol_context_360: 'read_file',
      get_diagnostics: 'run_command',
      analyze_impact: 'run_command',
      query_call_graph: 'run_command',
      apply_patch: 'replace_text',
    };
    const sanitizedTools = advice.suggestedTools
      .map((t) => ADVICE_TOOL_MAP[t] || t)
      .filter((t) => CANONICAL_VISIBLE_TOOLS.has(t))
      .filter((t, i, arr) => arr.indexOf(t) === i);
    const toolsText = sanitizedTools.length > 0
      ? sanitizedTools.join(', ')
      : '(None - Conclude with Final Answer)';
    let sanitizedGuidance = advice.guidance;
    for (const [phantom, canonical] of Object.entries(ADVICE_TOOL_MAP)) {
      sanitizedGuidance = sanitizedGuidance.replace(new RegExp(`\\b${phantom}\\b`, 'g'), canonical);
    }
    return `[TOOL PLAYBOOK GUIDANCE - ${advice.playbook}]\n→ Recommended next actions: ${sanitizedGuidance}\n→ Suggested tools: ${toolsText}`;
  }
}
