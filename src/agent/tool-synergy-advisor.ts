import type { ToolFailureDiagnosis } from '../tools/tool-use-guardian.js';
import { ROOT_CAUSE_STEPS } from '../llm/sections/shared.js';
import { resolvePatchFormatSpec } from '../llm/sections/tools.js';
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
        guidance: `[ROOT-CAUSE:REPORT] User reported a bug or error. Do not guess or monkey-patch. Protocol: ${ROOT_CAUSE_STEPS} via search/read_file/query_call_graph. Investigate in proportion to risk and pivot only after repeated equivalent failure or falling confidence.`,
        suggestedTools: ['search_codebase_fast', 'read_file', 'run_command', 'query_call_graph'],
      };
    }

    // 1. Xung đột Khóa Lạc Quan OCC trong Multi-Agent (Playbook E)
    if (hasSharedContextConflicts || (lastToolResult && lastToolResult.conflict)) {
      return {
        playbook: 'E_MULTI_AGENT',
        guidance: 'OCC Version Conflict detected on shared context key. Call "read_shared_context" to inspect latest versionHash before attempting "write_shared_context".',
        suggestedTools: ['read_shared_context', 'write_shared_context'],
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
        guidance: 'Background task is active. Use "schedule" (with TimerCondition) to wait reactively without polling, or "manage_task(send_input)" if interactive prompt is waiting.',
        suggestedTools: ['schedule', 'manage_task'],
      };
    }

    // 2a. Browser automation flow (Playbook H: Playwright MCP)
    if (lastToolName && lastToolName.startsWith('browser_')) {
      if (lastToolName === 'browser_navigate' || lastToolName === 'browser_click' || lastToolName === 'browser_type' || lastToolName === 'browser_wait') {
        return {
          playbook: 'H_BROWSER',
          guidance: 'Browser action done. Call "browser_snapshot" to get fresh refs before next click/type. Sequence: navigate -> snapshot -> click/type -> wait -> snapshot. Call "browser_close" when done.',
          suggestedTools: ['browser_snapshot', 'browser_click', 'browser_type', 'browser_wait', 'browser_close'],
        };
      }
      if (lastToolName === 'browser_snapshot' || lastToolName === 'browser_screenshot') {
        return {
          playbook: 'H_BROWSER',
          guidance: 'Snapshot captured. Use refs (e.g. e12) with "browser_click"/"browser_type" for SPA/login/form interaction.',
          suggestedTools: ['browser_click', 'browser_type', 'browser_wait', 'browser_close'],
        };
      }
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

    // 2.5. Sự cố apply_patch (Lỗi format patch hoặc FUZZY_CANDIDATE_FOUND) -> gợi ý chuyển sang replace_text
    if (
      lastToolName === 'apply_patch' &&
      lastToolResult &&
      (lastToolResult.error || lastToolResult.fuzzyCandidate || lastToolResult.status === 'FUZZY_CANDIDATE_FOUND')
    ) {
      const isFuzzy = Boolean(lastToolResult.fuzzyCandidate || lastToolResult.status === 'FUZZY_CANDIDATE_FOUND');
      const reason = isFuzzy
        ? 'FUZZY_CANDIDATE_FOUND (Fuzz Level 3 match). Disk was NOT mutated to avoid accidental corruption.'
        : `Patch application failed: ${lastToolResult.error || 'Invalid patch structure'}`;
      const patchSpec = resolvePatchFormatSpec(context.lastTargetFile);
      return {
        playbook: 'C_MUTATION',
        guidance: `[PATCH FORMAT & FUZZ ADVISORY]: ${reason}\n${patchSpec}\n→ Action: Call "read_file" on the target lines to obtain fresh contentHash and line offsets, then provide exact replacement with "replace_text".`,
        suggestedTools: ['read_file', 'replace_text'],
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
          : ['run_command', 'read_file', 'search_text'],
      };
    }

    // 3.9. LATS Backtracking khi đã cạn kiệt chu kỳ sửa lỗi (3+ lần thất bại)
    if (context.repairCyclesExhausted) {
      const memoText = context.reflexionMemo ? ` Failure reflection: ${context.reflexionMemo}` : '';
      return {
        playbook: 'B_DEBUGGING',
        guidance: `[LATS BACKTRACKING] Repeated repair attempts failed. Stop speculative edits and re-evaluate the causal hypothesis. Failures do not authorize Git restore, reset, stash or discarding workspace changes. Only use a rollback explicitly authorized for the affected scope.${memoText}`,
        suggestedTools: ['run_command', 'read_file', 'search_text'],
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
        suggestedTools: ['run_command', 'read_file', 'search_text', 'replace_text'],
      };
    }

    // 5. Deterministic broad-to-narrow retrieval routing. This is guidance-only
    // here; AgentLoop enforcement remains separately feature-gated and fail-open.
    if (
      activeTaskTitle
      || userRequest
      || ['search_codebase_fast', 'read_compressed_code', 'get_symbol_context_360', 'read_file'].includes(lastToolName || '')
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

    // 6. Vừa tra cứu symbol đơn lẻ (inspect_symbol)
    if (lastToolName === 'inspect_symbol' && lastToolResult && !lastToolResult.error) {
      const callerHint = context.callGraphContext?.callers?.length
        ? ` Direct callers: [${context.callGraphContext.callers.slice(0, 3).join(', ')}].`
        : '';
      return {
        playbook: 'G_BLAST_RADIUS',
        guidance: `Symbol definition inspected.${callerHint} Inspect exact implementation lines with read_file or search occurrences with search_text.`,
        suggestedTools: ['read_file', 'search_text', 'replace_text'],
      };
    }

    // 7. Mặc định: Hướng dẫn chuỗi hành vi tổng quát
    return {
      playbook: 'GENERAL',
      guidance: 'Explore with list_files and search_text, inspect implementation details with read_file, edit with replace_text or write_file, and verify with run_command.',
      suggestedTools: ['list_files', 'search_text', 'read_file', 'replace_text', 'run_command'],
    };
  }

  /**
   * Định dạng lời khuyên thành chuỗi text ngắn gọn chèn vào Dynamic Execution Context
   */
  formatAdvicePrompt(context: ToolSynergyContext): string {
    const advice = this.advise(context);
    const toolsText = advice.suggestedTools.length > 0
      ? advice.suggestedTools.join(', ')
      : '(None - Conclude with Final Answer)';
    return `[TOOL PLAYBOOK GUIDANCE - ${advice.playbook}]\n→ Recommended next actions: ${advice.guidance}\n→ Suggested tools: ${toolsText}`;
  }
}
