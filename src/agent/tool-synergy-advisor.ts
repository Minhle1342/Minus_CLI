export interface ToolSynergyContext {
  lastToolName?: string;
  lastToolResult?: any;
  hasErrors?: boolean;
  activeTaskTitle?: string;
  activeTaskAcceptance?: string;
  hasRunningBackgroundTasks?: boolean;
  hasSharedContextConflicts?: boolean;
}

export interface ToolAdvice {
  playbook: 'A_DISCOVERY' | 'B_DEBUGGING' | 'C_MUTATION' | 'D_ASYNC_CLI' | 'E_MULTI_AGENT' | 'F_PLAN_LIFECYCLE' | 'G_BLAST_RADIUS' | 'GENERAL';
  guidance: string;
  suggestedTools: string[];
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
    } = context;

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

    // 3. Vừa sửa đổi code (Playbook C: Safe Mutation & Verification)
    if (
      lastToolName &&
      ['replace_text', 'apply_patch', 'write_file', 'create_file', 'delete_file'].includes(lastToolName)
    ) {
      if (lastToolResult && !lastToolResult.error) {
        return {
          playbook: 'C_MUTATION',
          guidance: 'Code was modified. Next, call "get_diagnostics" to check for compiler/type errors, then run relevant test suites via "run_command".',
          suggestedTools: ['get_diagnostics', 'run_command', 'get_symbol_context_360'],
        };
      }
    }

    // 4. Phát hiện lỗi Compiler / Test Failure / Lỗi Thực thi (Playbook B: Root Cause Debugging)
    if (
      hasErrors ||
      (lastToolResult && (lastToolResult.error || (Array.isArray(lastToolResult.diagnostics) && lastToolResult.diagnostics.length > 0)))
    ) {
      return {
        playbook: 'B_DEBUGGING',
        guidance: 'Error or diagnostic issue detected. Use "inspect_symbol" and "query_call_graph(direction=\'callers\')" to trace root cause up the call stack instead of guessing.',
        suggestedTools: ['get_diagnostics', 'inspect_symbol', 'query_call_graph', 'search_web'],
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

    // 6. Vừa đọc file mã nguồn (Playbook G: Blast Radius & Impact Awareness)
    if (lastToolName === 'read_file' && lastToolResult && !lastToolResult.error) {
      if (lastToolResult.symbolsCount > 0 || lastToolResult.isTruncated || (Array.isArray(lastToolResult.outline) && lastToolResult.outline.length > 0)) {
        return {
          playbook: 'G_BLAST_RADIUS',
          guidance: 'File inspected with symbols outline. Before modifying any function or class, verify upstream callers via "query_call_graph(direction=\'callers\')" or "get_symbol_context_360".',
          suggestedTools: ['query_call_graph', 'get_symbol_context_360', 'replace_text', 'get_diagnostics'],
        };
      }
    }

    // 7. Mặc định: Hướng dẫn chuỗi hành vi tổng quát
    return {
      playbook: 'GENERAL',
      guidance: 'Choose the most precise high-level tool: "get_symbol_context_360" for symbol analysis, "get_route_map" for APIs, or "get_architecture_topology" for system structure.',
      suggestedTools: ['get_symbol_context_360', 'query_call_graph', 'replace_text', 'get_diagnostics'],
    };
  }

  /**
   * Định dạng lời khuyên thành chuỗi text ngắn gọn chèn vào Dynamic Execution Context
   */
  formatAdvicePrompt(context: ToolSynergyContext): string {
    const advice = this.advise(context);
    return `[TOOL PLAYBOOK GUIDANCE - ${advice.playbook}]\n→ Recommended next actions: ${advice.guidance}\n→ Suggested tools: ${advice.suggestedTools.join(', ')}`;
  }
}
