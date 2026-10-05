/**
 * ToolTransitionGraph (ToolNet State Machine Engine)
 * 
 * Mô hình hóa Đồ thị Chuyển đổi Trạng thái Công cụ (Directed Tool Transition Graph):
 * Tính toán xác suất chuyển trạng thái P(Next_Tool | Last_Tool, Outcome) nhằm:
 * 1. Tự động nâng ưu tiên (Prior Boost) cho các công cụ kế nhiệm hợp lý trong chuỗi thao tác.
 * 2. Triệt tiêu sự phụ thuộc vào các khối regex thủ công, phân tán.
 * 3. Tối ưu hóa chu trình Reasoning -> Acting -> Verification trong Agentic Loop.
 */

export type ToolOutcomeState =
  | 'IDLE'
  | 'SUCCESS_MUTATION'
  | 'FAILED_MUTATION'
  | 'CLEAN_DIAGNOSTICS'
  | 'DIRTY_DIAGNOSTICS'
  | 'PASSED_TEST'
  | 'FAILED_TEST'
  | 'HYPOTHESIS_VALIDATED'
  | 'HYPOTHESIS_FORMULATED'
  | 'HYPOTHESIS_FALSIFIED'
  | 'PLAN_CREATED'
  | 'PLAN_TASK_UPDATED'
  | 'WEB_SEARCH_HIT'
  | 'WEB_CONTENT_ACQUIRED'
  | 'MEMORY_RECALLED'
  | 'MEMORY_SAVED'
  | 'DESIGN_REVIEW_COMPLETED'
  | 'AGENT_TASK_ALLOCATED'
  | 'SUBAGENT_QUALITY_VERIFIED'
  | 'IMAGE_INSPECTED'
  | 'DISCOVERY_HIT'
  | 'SYMBOL_INSPECTED'
  | 'BACKGROUND_RUNNING'
  | 'OCC_CONFLICT'
  | 'EXPLORATION_SUFFICIENCY_BLOCKED'
  | 'REPRODUCTION_GATE_BLOCKED'
  | 'ANTI_FIXATION_CIRCUIT_BREAKER_BLOCKED'
  | 'COMPLETION_EVIDENCE_REQUIRED'
  | 'TARGET_CONTENT_NOT_FOUND'
  | 'GRAPH_CONTEXT_ACQUIRED'
  | 'PHASE_TRANSITION_ACCEPTED'
  | 'GENERAL_SUCCESS'
  | 'GENERAL_ERROR';

export interface TransitionRule {
  primarySuccessors: string[];
  secondarySuccessors: string[];
  primaryBoost: number;
  secondaryBoost: number;
}

const TRANSITION_TABLE: Record<ToolOutcomeState, TransitionRule> = {
  IDLE: {
    primarySuccessors: ['search_codebase_fast', 'read_file', 'get_symbol_context_360'],
    secondarySuccessors: ['inspect_symbol', 'list_files'],
    primaryBoost: 0.15,
    secondaryBoost: 0.08,
  },
  PHASE_TRANSITION_ACCEPTED: {
    primarySuccessors: ['create_file', 'write_file', 'replace_text', 'apply_patch'],
    secondarySuccessors: ['read_file', 'run_command', 'run_node_script'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  SUCCESS_MUTATION: {
    primarySuccessors: ['verify_edit', 'get_diagnostics', 'run_command', 'get_symbol_context_360'],
    secondarySuccessors: ['analyze_impact', 'replace_text'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  FAILED_MUTATION: {
    primarySuccessors: ['read_file', 'replace_text'],
    secondarySuccessors: ['apply_patch', 'inspect_symbol'],
    primaryBoost: 0.26,
    secondaryBoost: 0.10,
  },
  CLEAN_DIAGNOSTICS: {
    primarySuccessors: ['submit_solution', 'run_command'],
    secondarySuccessors: ['get_symbol_context_360'],
    primaryBoost: 0.32,
    secondaryBoost: 0.14,
  },
  DIRTY_DIAGNOSTICS: {
    primarySuccessors: ['replace_text', 'apply_patch', 'inspect_symbol'],
    secondarySuccessors: ['get_symbol_context_360', 'query_call_graph', 'get_diagnostics'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  PASSED_TEST: {
    primarySuccessors: ['submit_solution'],
    secondarySuccessors: ['get_diagnostics'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  FAILED_TEST: {
    primarySuccessors: ['formulate_and_verify_hypothesis', 'get_diagnostics', 'get_symbol_context_360', 'search_codebase_fast'],
    secondarySuccessors: ['query_call_graph', 'inspect_symbol', 'replace_text'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  HYPOTHESIS_VALIDATED: {
    primarySuccessors: ['request_phase_transition', 'create_file', 'replace_text', 'apply_patch'],
    secondarySuccessors: ['run_command', 'get_diagnostics'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  HYPOTHESIS_FORMULATED: {
    primarySuccessors: ['run_command', 'get_symbol_context_360', 'read_file'],
    secondarySuccessors: ['search_codebase_fast', 'inspect_symbol'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  HYPOTHESIS_FALSIFIED: {
    primarySuccessors: ['formulate_and_verify_hypothesis', 'get_symbol_context_360', 'search_codebase_fast'],
    secondarySuccessors: ['query_call_graph', 'read_file'],
    primaryBoost: 0.30,
    secondaryBoost: 0.12,
  },
  PLAN_CREATED: {
    primarySuccessors: ['update_plan_task', 'read_file', 'search_codebase_fast'],
    secondarySuccessors: ['formulate_and_verify_hypothesis', 'allocate_agent_task'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  PLAN_TASK_UPDATED: {
    primarySuccessors: ['read_file', 'replace_text', 'run_command'],
    secondarySuccessors: ['submit_solution', 'update_plan_task', 'get_diagnostics'],
    primaryBoost: 0.25,
    secondaryBoost: 0.12,
  },
  WEB_SEARCH_HIT: {
    primarySuccessors: ['web_fetch'],
    secondarySuccessors: ['read_file', 'replace_text'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  WEB_CONTENT_ACQUIRED: {
    primarySuccessors: ['read_file', 'replace_text', 'create_file'],
    secondarySuccessors: ['apply_patch', 'run_command'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  MEMORY_RECALLED: {
    primarySuccessors: ['verify_repository_memory', 'read_file', 'search_codebase_fast'],
    secondarySuccessors: ['get_symbol_context_360', 'save_memory'],
    primaryBoost: 0.25,
    secondaryBoost: 0.12,
  },
  MEMORY_SAVED: {
    primarySuccessors: ['read_file', 'create_plan', 'search_codebase_fast'],
    secondarySuccessors: ['get_symbol_context_360'],
    primaryBoost: 0.20,
    secondaryBoost: 0.10,
  },
  DESIGN_REVIEW_COMPLETED: {
    primarySuccessors: ['allocate_agent_task', 'create_plan', 'write_shared_context'],
    secondarySuccessors: ['schedule_dag_parallel', 'read_file'],
    primaryBoost: 0.30,
    secondaryBoost: 0.12,
  },
  AGENT_TASK_ALLOCATED: {
    primarySuccessors: ['verify_subagent_quality', 'read_shared_context', 'schedule_dag_parallel'],
    secondarySuccessors: ['publish_agent_event', 'write_shared_context'],
    primaryBoost: 0.30,
    secondaryBoost: 0.15,
  },
  SUBAGENT_QUALITY_VERIFIED: {
    primarySuccessors: ['write_shared_context', 'update_plan_task', 'submit_solution'],
    secondarySuccessors: ['get_diagnostics', 'run_command'],
    primaryBoost: 0.32,
    secondaryBoost: 0.15,
  },
  IMAGE_INSPECTED: {
    primarySuccessors: ['generate_image', 'replace_text', 'read_file'],
    secondarySuccessors: ['create_file', 'write_file'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  DISCOVERY_HIT: {
    primarySuccessors: ['read_file', 'get_symbol_context_360', 'inspect_symbol'],
    secondarySuccessors: ['search_text', 'query_call_graph'],
    primaryBoost: 0.22,
    secondaryBoost: 0.10,
  },
  SYMBOL_INSPECTED: {
    primarySuccessors: ['get_symbol_context_360', 'query_call_graph', 'analyze_impact'],
    secondarySuccessors: ['replace_text', 'read_file'],
    primaryBoost: 0.25,
    secondaryBoost: 0.12,
  },
  GRAPH_CONTEXT_ACQUIRED: {
    primarySuccessors: ['read_file', 'replace_text', 'write_file'],
    secondarySuccessors: ['get_diagnostics', 'run_command', 'inspect_symbol'],
    primaryBoost: 0.28,
    secondaryBoost: 0.12,
  },
  EXPLORATION_SUFFICIENCY_BLOCKED: {
    primarySuccessors: ['read_file', 'get_symbol_context_360', 'run_command'],
    secondarySuccessors: ['inspect_symbol', 'query_call_graph', 'search_codebase_fast'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  REPRODUCTION_GATE_BLOCKED: {
    primarySuccessors: ['write_file', 'run_command', 'read_file'],
    secondarySuccessors: ['search_codebase_fast', 'get_symbol_context_360'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  ANTI_FIXATION_CIRCUIT_BREAKER_BLOCKED: {
    primarySuccessors: ['get_symbol_context_360', 'query_call_graph', 'read_file'],
    secondarySuccessors: ['grep_search', 'search_codebase_fast', 'inspect_symbol'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  COMPLETION_EVIDENCE_REQUIRED: {
    primarySuccessors: ['run_command', 'get_diagnostics'],
    secondarySuccessors: ['verify_edit', 'read_file'],
    primaryBoost: 0.38,
    secondaryBoost: 0.16,
  },
  TARGET_CONTENT_NOT_FOUND: {
    primarySuccessors: ['read_file', 'view_file_outline'],
    secondarySuccessors: ['inspect_symbol', 'replace_text'],
    primaryBoost: 0.35,
    secondaryBoost: 0.15,
  },
  BACKGROUND_RUNNING: {
    primarySuccessors: ['schedule', 'manage_task'],
    secondarySuccessors: ['run_command'],
    primaryBoost: 0.30,
    secondaryBoost: 0.12,
  },
  OCC_CONFLICT: {
    primarySuccessors: ['read_shared_context', 'write_shared_context'],
    secondarySuccessors: ['shared_blackboard'],
    primaryBoost: 0.30,
    secondaryBoost: 0.15,
  },
  GENERAL_SUCCESS: {
    primarySuccessors: ['get_symbol_context_360', 'read_file'],
    secondarySuccessors: ['search_codebase_fast', 'run_command'],
    primaryBoost: 0.12,
    secondaryBoost: 0.06,
  },
  GENERAL_ERROR: {
    primarySuccessors: ['get_diagnostics', 'search_codebase_fast', 'read_file'],
    secondarySuccessors: ['inspect_symbol', 'query_call_graph'],
    primaryBoost: 0.20,
    secondaryBoost: 0.10,
  },
};

const MUTATION_TOOLS = new Set([
  'apply_patch',
  'replace_text',
  'verify_edit',
  'write_file',
  'create_file',
  'delete_file',
  'move_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const DISCOVERY_TOOLS = new Set([
  'search_codebase_fast',
  'search_text',
  'list_files',
  'find_files',
  'read_compressed_code',
  'pack_codebase',
]);

export class ToolTransitionGraph {
  /**
   * Đánh giá trạng thái kết quả (Outcome State) dựa trên tool vừa chạy và kết quả của nó
   */
  evaluateOutcome(lastToolName?: string, lastToolResult?: unknown): ToolOutcomeState {
    if (!lastToolName) return 'IDLE';

    const res: any = lastToolResult;
    const hasError = Boolean(
      res?.error ||
      res?.status === 'error' ||
      res?.success === false ||
      (typeof res?.exitCode === 'number' && res.exitCode !== 0) ||
      (Array.isArray(res?.diagnostics) && res.diagnostics.length > 0)
    );

    // 0. Kiểm tra Gate Block Reason Codes & Error Codes
    if (res?.reasonCode === 'EXPLORATION_SUFFICIENCY_BLOCKED') {
      return 'EXPLORATION_SUFFICIENCY_BLOCKED';
    }
    if (res?.reasonCode === 'REPRODUCTION_GATE_BLOCKED') {
      return 'REPRODUCTION_GATE_BLOCKED';
    }
    if (res?.reasonCode === 'ANTI_FIXATION_CIRCUIT_BREAKER_BLOCKED') {
      return 'ANTI_FIXATION_CIRCUIT_BREAKER_BLOCKED';
    }
    if (
      res?.errorCode === 'COMPLETION_EVIDENCE_REQUIRED' ||
      res?.reasonCode === 'COMPLETION_EVIDENCE_REQUIRED' ||
      res?.errorCode === 'OCR_REVIEW_REQUIRED' ||
      res?.reasonCode === 'OCR_REVIEW_REQUIRED'
    ) {
      return 'COMPLETION_EVIDENCE_REQUIRED';
    }
    if (
      res?.reasonCode === 'TARGET_CONTENT_NOT_FOUND' ||
      res?.reasonCode === 'AMBIGUOUS_REPLACEMENT' ||
      res?.errorCode === 'AMBIGUOUS_REPLACEMENT' ||
      res?.errorCode === 'TEXT_NOT_FOUND' ||
      (res?.errorCode === 'PATCH_ERROR' && typeof res?.error === 'string' && res.error.includes('TargetContent not found'))
    ) {
      return 'TARGET_CONTENT_NOT_FOUND';
    }
    if (res?.errorCode === 'PHASE_TRANSITION_REQUIRES_FRESH_MODEL_TURN') {
      return 'PHASE_TRANSITION_ACCEPTED';
    }

    // 1. Kiểm tra OCC Conflict
    if (res?.conflict || lastToolName === 'write_shared_context' && res?.conflict) {
      return 'OCC_CONFLICT';
    }

    // 2. Kiểm tra Background Task
    if (res?.isBackgroundTask || (lastToolName === 'run_command' && res?.taskId)) {
      return 'BACKGROUND_RUNNING';
    }

    // 2.1. Kiểm tra Graph Context Tools
    if (['get_symbol_context_360', 'query_call_graph', 'get_route_map', 'analyze_impact'].includes(lastToolName)) {
      return hasError ? 'GENERAL_ERROR' : 'GRAPH_CONTEXT_ACQUIRED';
    }

    // 3. Kiểm tra Mutation Tools
    if (MUTATION_TOOLS.has(lastToolName)) {
      if (hasError || res?.fuzzyCandidate || res?.status === 'FUZZY_CANDIDATE_FOUND') {
        return 'FAILED_MUTATION';
      }
      return 'SUCCESS_MUTATION';
    }

    // 4. Kiểm tra get_diagnostics
    if (lastToolName === 'get_diagnostics') {
      const isClean = !hasError && (res?.clean === true || res?.totalErrors === 0 || (Array.isArray(res?.diagnostics) && res.diagnostics.length === 0));
      return isClean ? 'CLEAN_DIAGNOSTICS' : 'DIRTY_DIAGNOSTICS';
    }

    // 5. Kiểm tra run_command
    if (lastToolName === 'run_command') {
      const isTestCmd = typeof res?.command === 'string' && /\b(?:test|spec|check|verify|jest|vitest|pytest|cargo test)\b/i.test(res.command);
      if (isTestCmd) {
        return hasError ? 'FAILED_TEST' : 'PASSED_TEST';
      }
      return hasError ? 'GENERAL_ERROR' : 'GENERAL_SUCCESS';
    }

    // 6. Kiểm tra inspect_symbol
    if (lastToolName === 'inspect_symbol') {
      return hasError ? 'GENERAL_ERROR' : 'SYMBOL_INSPECTED';
    }

    // 7. Kiểm tra Discovery Tools
    if (DISCOVERY_TOOLS.has(lastToolName)) {
      return hasError ? 'GENERAL_ERROR' : 'DISCOVERY_HIT';
    }

    // 8. Kiểm tra Phase Transition Tools
    if (lastToolName === 'request_phase_transition') {
      return (res?.accepted || res?.success) ? 'PHASE_TRANSITION_ACCEPTED' : 'GENERAL_ERROR';
    }

    // 9. Kiểm tra Hypothesis Verification Tools
    if (lastToolName === 'formulate_and_verify_hypothesis') {
      if (res?.status === 'validated' || res?.canProceedToImplement) return 'HYPOTHESIS_VALIDATED';
      if (hasError || res?.status === 'falsified') return 'HYPOTHESIS_FALSIFIED';
      return 'HYPOTHESIS_FORMULATED';
    }

    // 10. Kiểm tra Planning Tools
    if (lastToolName === 'create_plan') {
      return hasError ? 'GENERAL_ERROR' : 'PLAN_CREATED';
    }
    if (lastToolName === 'update_plan_task') {
      return hasError ? 'GENERAL_ERROR' : 'PLAN_TASK_UPDATED';
    }

    // 11. Kiểm tra Web Research Tools
    if (lastToolName === 'web_search') {
      return hasError ? 'GENERAL_ERROR' : 'WEB_SEARCH_HIT';
    }
    if (lastToolName === 'web_fetch') {
      return hasError ? 'GENERAL_ERROR' : 'WEB_CONTENT_ACQUIRED';
    }

    // 12. Kiểm tra Memory Tools
    if (lastToolName === 'recall_repository_memory' || lastToolName === 'read_memory') {
      return hasError ? 'GENERAL_ERROR' : 'MEMORY_RECALLED';
    }
    if (lastToolName === 'save_memory' || lastToolName === 'save_repository_memory' || lastToolName === 'verify_repository_memory') {
      return hasError ? 'GENERAL_ERROR' : 'MEMORY_SAVED';
    }

    // 13. Kiểm tra Multi-Agent Coordination Tools
    if (lastToolName === 'brainstorm_design') {
      return hasError ? 'GENERAL_ERROR' : 'DESIGN_REVIEW_COMPLETED';
    }
    if (lastToolName === 'allocate_agent_task') {
      return hasError ? 'GENERAL_ERROR' : 'AGENT_TASK_ALLOCATED';
    }
    if (lastToolName === 'verify_subagent_quality') {
      return hasError ? 'GENERAL_ERROR' : 'SUBAGENT_QUALITY_VERIFIED';
    }

    // 14. Kiểm tra Multimodal Vision Tools
    if (lastToolName === 'inspect_image') {
      return hasError ? 'GENERAL_ERROR' : 'IMAGE_INSPECTED';
    }

    return hasError ? 'GENERAL_ERROR' : 'GENERAL_SUCCESS';
  }

  /**
   * Tính toán điểm cộng ưu tiên (Prior Boost) từ đồ thị chuyển trạng thái cho ứng viên candidateToolName
   */
  getTransitionBoost(lastToolName: string | undefined, lastToolResult: unknown, candidateToolName: string): number {
    const outcome = this.evaluateOutcome(lastToolName, lastToolResult);
    const rule = TRANSITION_TABLE[outcome];
    if (!rule) return 0;

    if (rule.primarySuccessors.includes(candidateToolName)) {
      return rule.primaryBoost;
    }
    if (rule.secondarySuccessors.includes(candidateToolName)) {
      return rule.secondaryBoost;
    }
    return 0;
  }

  /**
   * Lấy danh sách các công cụ được đồ thị khuyến nghị theo trạng thái hiện tại
   */
  getSuggestedTools(lastToolName?: string, lastToolResult?: unknown): string[] {
    const outcome = this.evaluateOutcome(lastToolName, lastToolResult);
    const rule = TRANSITION_TABLE[outcome];
    if (!rule) return [];
    return [...rule.primarySuccessors, ...rule.secondarySuccessors];
  }
}
