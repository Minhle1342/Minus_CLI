import type { ToolFailureDiagnosis } from '../tools/tool-use-guardian.js';
import { SECTION_PATCH_FORMAT_SPEC } from '../llm/prompt-sections.js';
import { isMutationTool } from '../tools/diff-generator.js';

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
}

export interface ToolAdvice {
  playbook: 'A_DISCOVERY' | 'B_DEBUGGING' | 'C_MUTATION' | 'D_ASYNC_CLI' | 'E_MULTI_AGENT' | 'F_PLAN_LIFECYCLE' | 'G_BLAST_RADIUS' | 'POST_SUBMISSION' | 'GENERAL';
  guidance: string;
  suggestedTools: string[];
}

export function detectBugReportIntent(text?: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\b(lỗi|bị lỗi|fix bug|sửa bug|bug|crash|crashed|exception|traceback|failed|failing|error|bị hỏng|không chạy được|fail)\b/i.test(lower);
}

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
      hasSubmittedSolution,
    } = context;

    // 0a. Vừa gọi submit_solution hoặc đã submit giải pháp thành công (Playbook POST_SUBMISSION)
    if (lastToolName === 'submit_solution' || hasSubmittedSolution) {
      return {
        playbook: 'POST_SUBMISSION',
        guidance: 'Solution has been submitted and verified with empirical evidence. The task is now COMPLETE. You MUST NOT call any further tools. Conclude your turn immediately with your final comprehensive response to the user.',
        suggestedTools: [],
      };
    }

    // 0b. Phát hiện người dùng báo lỗi trong prompt (User Bug Report Intent) ngay turn đầu
    if (!lastToolName && detectBugReportIntent(userRequest)) {
      return {
        playbook: 'B_DEBUGGING',
        guidance: '[5-STAGE ROOT CAUSE PROTOCOL] User reported a bug or error. Do not guess or monkey-patch! Protocol: 1.[Extract Coordinates / Locate defect] -> 2.[Backward Causal Trace via search/read_file/query_call_graph] -> 3.[Formulate Falsifiable Hypothesis] -> 4.[Surgical Fix] -> 5.[Verify via get_diagnostics/test]. Max 3 repair cycles.',
        suggestedTools: ['search_codebase_fast', 'read_file', 'get_diagnostics', 'query_call_graph'],
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

    // 2.5. Sự cố apply_patch (Lỗi format patch hoặc FUZZY_CANDIDATE_FOUND)
    if (
      lastToolName === 'apply_patch' &&
      lastToolResult &&
      (lastToolResult.error || lastToolResult.fuzzyCandidate || lastToolResult.status === 'FUZZY_CANDIDATE_FOUND')
    ) {
      const isFuzzy = Boolean(lastToolResult.fuzzyCandidate || lastToolResult.status === 'FUZZY_CANDIDATE_FOUND');
      const reason = isFuzzy
        ? 'FUZZY_CANDIDATE_FOUND (Fuzz Level 3 match). Disk was NOT mutated to avoid accidental corruption.'
        : `Patch application failed: ${lastToolResult.error || 'Invalid patch structure'}`;
      return {
        playbook: 'C_MUTATION',
        guidance: `[PATCH FORMAT & FUZZ ADVISORY]: ${reason}\n${SECTION_PATCH_FORMAT_SPEC}\n→ Action: Call "read_file" on the target lines to obtain fresh contentHash and line offsets, then provide an exact patch hunk with matching context lines.`,
        suggestedTools: ['read_file', 'apply_patch', 'replace_text'],
      };
    }

    // 2.7. Fast-path: run_command vừa chạy test thành công → gợi ý submit_solution ngay (Step Efficiency Boost)
    if (
      lastToolName === 'run_command' &&
      lastToolResult &&
      !lastToolResult.error &&
      (lastToolResult.exitCode === 0 || lastToolResult.exitCode === undefined) &&
      typeof lastToolResult.command === 'string' &&
      /\b(?:test|spec|check|verify)\b/i.test(lastToolResult.command)
    ) {
      return {
        playbook: 'C_MUTATION',
        guidance: 'Test/verification command passed successfully (exit 0). You have empirical proof of correctness. Call "submit_solution" immediately with verification evidence. Do NOT run additional exploration or redundant tests.',
        suggestedTools: ['submit_solution'],
      };
    }

    // 3. Vừa sửa đổi code (Playbook C: Safe Mutation & Verification)
    if (lastToolName && isMutationTool(lastToolName)) {
      if (lastToolResult && !lastToolResult.error) {
        const blast = lastToolResult.blastRadius;
        if (blast) {
          const testAdvice = blast.impactedTestSuites?.length > 0
            ? ` Impacted test suite(s): ${blast.impactedTestSuites.slice(0, 2).join(', ')}. Run targeted test via "run_command".`
            : ' Next, call "get_diagnostics" or targeted tests to verify.';
          const consumerAdvice = blast.directConsumers?.length > 0
            ? ` ${blast.directConsumers.length} direct consumer file(s) affected.`
            : '';
          const symbolAdvice = blast.modifiedSymbols?.length > 0
            ? ` Modified symbols: ${blast.modifiedSymbols.slice(0, 3).join(', ')}.`
            : '';
          const riskPrefix = blast.risk ? `[Blast Radius: ${blast.risk}] ` : '';

          return {
            playbook: 'C_MUTATION',
            guidance: `${riskPrefix}Code mutation applied.${symbolAdvice}${consumerAdvice}${testAdvice}`,
            suggestedTools: blast.impactedTestSuites?.length > 0
              ? ['run_command', 'get_diagnostics', 'get_symbol_context_360']
              : ['get_diagnostics', 'run_command', 'get_symbol_context_360'],
          };
        }

        return {
          playbook: 'C_MUTATION',
          guidance: 'Code was modified. Next, call "get_diagnostics" to check for compiler/type errors, then run relevant test suites via "run_command".',
          suggestedTools: ['get_diagnostics', 'run_command', 'get_symbol_context_360'],
        };
      }
    }

    // 3.4. Vừa chạy get_diagnostics (Playbook C: Verification Transition)
    if (lastToolName === 'get_diagnostics') {
      const isClean = lastToolResult && !lastToolResult.error && lastToolResult.clean === true && (!lastToolResult.totalErrors || lastToolResult.totalErrors === 0);
      if (isClean) {
        return {
          playbook: 'C_MUTATION',
          guidance: 'Diagnostics clean (0 syntax and type errors). Verification passed! You can now call "submit_solution" with empirical proof and summary, or run specific test suites via "run_command" if required.',
          suggestedTools: ['submit_solution', 'run_command'],
        };
      }
      const errCount = lastToolResult?.totalErrors || (Array.isArray(lastToolResult?.diagnostics) ? lastToolResult.diagnostics.length : 1);
      return {
        playbook: 'B_DEBUGGING',
        guidance: `[5-STAGE ROOT CAUSE PROTOCOL] Diagnostics detected ${errCount} compiler/type error(s). Never monkey-patch crash sites or weaken assertions! Protocol: 1.[Extract Coordinates] -> 2.[Backward Causal Trace callers] -> 3.[Falsifiable Hypothesis] -> 4.[Surgical Fix] -> 5.[Verification]. Use "replace_text" or "apply_patch" to resolve errors before submitting.`,
        suggestedTools: ['replace_text', 'apply_patch', 'inspect_symbol', 'get_diagnostics'],
      };
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
          : ['get_diagnostics', 'inspect_symbol', 'query_call_graph'],
      };
    }

    // 4. Phát hiện lỗi Compiler / Test Failure / Lỗi Thực thi (Playbook B: Root Cause Debugging)
    if (
      hasErrors ||
      (lastToolResult && (lastToolResult.error || (Array.isArray(lastToolResult.diagnostics) && lastToolResult.diagnostics.length > 0)))
    ) {
      return {
        playbook: 'B_DEBUGGING',
        guidance: '[5-STAGE ROOT CAUSE PROTOCOL] Error or test failure detected. Never monkey-patch crash sites or repeat failing commands without modifying hypothesis! Protocol: 1.[Extract Coordinates] -> 2.[Backward Causal Trace via get_symbol_context_360 or query_call_graph(direction=\'callers\')] -> 3.[Falsifiable Hypothesis] -> 4.[Surgical Fix] -> 5.[Verification]. Max 3 repair cycles.',
        suggestedTools: ['get_diagnostics', 'get_symbol_context_360', 'query_call_graph', 'inspect_symbol', 'replace_text'],
      };
    }

    // 5. Khám phá Module hoặc Bắt đầu Task Mới (Playbook A: Architecture & Exploration)
    if (activeTaskTitle && (!lastToolName || ['create_plan', 'update_plan_task'].includes(lastToolName))) {
      return {
        playbook: 'A_DISCOVERY',
        guidance: `Starting task "${activeTaskTitle}". Use "get_symbol_context_360" or "get_route_map" / "get_architecture_topology" to inspect module boundaries before making changes.`,
        suggestedTools: ['get_symbol_context_360', 'get_route_map', 'get_architecture_topology', 'query_call_graph'],
      };
    }

    // 6. Vừa nén đọc nhiều file (read_compressed_code)
    if (lastToolName === 'read_compressed_code' && lastToolResult && !lastToolResult.error) {
      return {
        playbook: 'A_DISCOVERY',
        guidance: 'Compressed code structures analyzed. To inspect full 360-degree context for any specific symbol (definition, type signature, callers, callees, dependencies, and tests in 1 single payload), call "get_symbol_context_360".',
        suggestedTools: ['get_symbol_context_360', 'read_file', 'replace_text', 'get_diagnostics'],
      };
    }

    // 7. Vừa tra cứu symbol đơn lẻ (inspect_symbol)
    if (lastToolName === 'inspect_symbol' && lastToolResult && !lastToolResult.error) {
      return {
        playbook: 'G_BLAST_RADIUS',
        guidance: 'Symbol definition inspected. For full cross-codebase 360-degree context (all callers, outgoing callees, dependencies, and test coverage in 1 payload), use "get_symbol_context_360".',
        suggestedTools: ['get_symbol_context_360', 'query_call_graph', 'analyze_impact', 'replace_text'],
      };
    }

    // 8. Vừa đọc file mã nguồn (Playbook G: Blast Radius & Impact Awareness)
    if (lastToolName === 'read_file' && lastToolResult && !lastToolResult.error) {
      return {
        playbook: 'G_BLAST_RADIUS',
        guidance: 'File inspected. Before modifying any function or class, verify upstream callers, dependencies, and contracts via "get_symbol_context_360" or "query_call_graph(direction=\'callers\')".',
        suggestedTools: ['get_symbol_context_360', 'query_call_graph', 'replace_text', 'get_diagnostics'],
      };
    }

    // 9. Mặc định: Hướng dẫn chuỗi hành vi tổng quát
    return {
      playbook: 'GENERAL',
      guidance: 'Choose the most precise high-level tool: "get_symbol_context_360" for complete 360-degree symbol analysis, "get_route_map" for APIs, or "get_architecture_topology" for system structure.',
      suggestedTools: ['get_symbol_context_360', 'query_call_graph', 'replace_text', 'get_diagnostics'],
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
