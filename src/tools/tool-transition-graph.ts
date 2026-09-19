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
  | 'DISCOVERY_HIT'
  | 'SYMBOL_INSPECTED'
  | 'BACKGROUND_RUNNING'
  | 'OCC_CONFLICT'
  | 'EXPLORATION_SUFFICIENCY_BLOCKED'
  | 'REPRODUCTION_GATE_BLOCKED'
  | 'GRAPH_CONTEXT_ACQUIRED'
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
  SUCCESS_MUTATION: {
    primarySuccessors: ['get_diagnostics', 'run_command', 'get_symbol_context_360'],
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
    primarySuccessors: ['get_diagnostics', 'get_symbol_context_360', 'search_codebase_fast'],
    secondarySuccessors: ['query_call_graph', 'inspect_symbol', 'replace_text'],
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
  'write_file',
  'create_file',
  'delete_file',
  'move_file',
  'write_to_file',
  'replace_file_content',
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

    // 0. Kiểm tra Gate Block Reason Codes
    if (res?.reasonCode === 'EXPLORATION_SUFFICIENCY_BLOCKED') {
      return 'EXPLORATION_SUFFICIENCY_BLOCKED';
    }
    if (res?.reasonCode === 'REPRODUCTION_GATE_BLOCKED') {
      return 'REPRODUCTION_GATE_BLOCKED';
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
