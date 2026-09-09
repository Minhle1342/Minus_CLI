/**
 * Tool Use Guardian - Intelligent Tool-Call Reliability Wrapper
 * Specification: C:\Users\HP\.gemini\config\skills\tool-use-guardian\SKILL.md
 * 
 * 1. Pre-Call Validation (Parameter Coercion, Size Guard, Reliability Check)
 * 2. 9-Category Failure Classification & Recovery Diagnosis
 * 3. Auto-Retry with Exponential Backoff & Jitter (Rate Limits, Network, Idempotent Timeouts)
 * 4. Error-as-200 Detection & Unmasking
 * 5. Learning & Tool Reliability Tracking (3+ failures marks tool degraded with alternative suggestions)
 */

import { normalizeForMatching } from '../agent/final-answer-guard.js';

export type ToolFailureCategory =
  | 'TRUNCATED_JSON'
  | 'API_TIMEOUT'
  | 'RATE_LIMIT'
  | 'AUTH_EXPIRED'
  | 'MID_CHAIN_BREAK'
  | 'ERROR_AS_200'
  | 'SCHEMA_MISMATCH'
  | 'NETWORK_FAILURE'
  | 'PRE_MUTATION_GATE_BLOCKED'
  | 'POST_SUBMISSION_TOOL_CALL_BLOCKED'
  | 'UNKNOWN_ERROR';

export interface ToolFailureDiagnosis {
  category: ToolFailureCategory;
  message: string;
  isRetryable: boolean;
  maxRetries: number;
  backoffMs: number;
  recoveryAction: string;
  suggestedAlternative?: string;
  errorAs200Unmasked?: boolean;
}

export interface ToolReliabilityStats {
  toolName: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  consecutiveFailures: number;
  failuresByCategory: Partial<Record<ToolFailureCategory, number>>;
  isUnreliable: boolean;
  unreliableReason?: string;
  suggestedAlternatives: string[];
  lastFailureAt?: number;
  lastFailureCategory?: ToolFailureCategory;
}

export interface PreMutationGateContext {
  isBugfixTask?: boolean;
  taskIntent?: string;
  taskClass?: string;
  phase?: string;
  hasPlan?: boolean;
  hasValidatedHypothesis: boolean;
  hypothesisCount?: number;
  targetFiles?: string[];
  isTrivialEdit?: boolean;
  hasSubmittedSolution?: boolean;
}

export interface GuardianPreCallResult {
  valid: boolean;
  allowed?: boolean;
  coercedArgs: Record<string, any>;
  wasCoerced: boolean;
  coercedKeys: string[];
  warning?: string;
  error?: string;
  errorCode?: string;
  reason?: string;
  isUnreliable?: boolean;
  suggestedAlternative?: string;
}

export const DEFAULT_TOOL_ALTERNATIVES: Record<string, string[]> = {
  search_codebase_fast: ['grep_search', 'run_command (rg)', 'read_file'],
  grep_search: ['search_codebase_fast', 'run_command (rg)'],
  search_text: ['grep_search', 'read_file', 'run_command (rg)'],
  read_file: ['read_compressed_code', 'run_command (cat/head)', 'inspect_symbol'],
  read_compressed_code: ['read_file', 'inspect_symbol'],
  pack_codebase: ['list_files', 'read_compressed_code'],
  replace_text: ['apply_patch', 'write_file'],
  apply_patch: ['replace_text', 'write_file'],
  query_call_graph: ['get_symbol_context_360', 'inspect_symbol', 'read_file', 'find_references'],
  get_symbol_context_360: ['inspect_symbol', 'query_call_graph', 'find_references'],
  get_route_map: ['grep_search', 'read_file'],
  git_status: ['git_command', 'run_command (git status)'],
  git_diff: ['git_command', 'run_command (git diff)'],
  submit_solution: ['report_investigation_findings'],
  report_investigation_findings: ['submit_solution'],
  formulate_and_verify_hypothesis: ['get_symbol_context_360', 'query_call_graph', 'analyze_impact'],
  replace_file_content: ['formulate_and_verify_hypothesis', 'get_symbol_context_360'],
  write_to_file: ['formulate_and_verify_hypothesis', 'replace_file_content'],
  web_search: ['search_web', 'read_url_content'],
  search_web: ['read_url_content', 'run_command (curl)'],
  read_url_content: ['search_web', 'run_command (curl)'],
};

/**
 * Phân loại lỗi theo 9 nhóm quy chuẩn của Tool Use Guardian
 */
export function classifyToolFailure(
  toolName: string,
  error: unknown,
  result?: Record<string, any>,
): ToolFailureDiagnosis {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : result?.error
        ? String(result.error)
        : 'Unknown tool failure';

  const lower = message.toLowerCase();
  const suggestedAlternative = DEFAULT_TOOL_ALTERNATIVES[toolName]?.[0];

  // 1. Error-as-200: Tool trả về thành công cấp HTTP / hàm nhưng nội dung bên trong chứa lỗi
  if (result && (
    result.error !== undefined ||
    result.success === false ||
    result.status === 'error' ||
    result.status === 'failed' ||
    result.isError === true
  )) {
    // Nếu bị chặn bởi Cổng Pareto 80/20, phân loại thành PRE_MUTATION_GATE_BLOCKED sạch sẽ (không phải disguised HTTP error)
    if (result.errorCode === 'UNVERIFIED_MUTATION_BLOCKED') {
      return {
        category: 'PRE_MUTATION_GATE_BLOCKED',
        message,
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Hãy khảo sát bằng get_symbol_context_360/inspect_symbol và gọi "formulate_and_verify_hypothesis", hoặc viết test tái hiện lỗi trong test/ / scratch/.',
        suggestedAlternative: 'formulate_and_verify_hypothesis',
      };
    }

    // Nếu bị chặn sau khi đã submit_solution thành công
    if (result.errorCode === 'POST_SUBMISSION_TOOL_CALL_BLOCKED') {
      return {
        category: 'POST_SUBMISSION_TOOL_CALL_BLOCKED',
        message,
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Giải pháp đã được nghiệm thu. Toàn bộ tool calls đã bị khóa. Hãy lập tức hoàn tất lượt và gửi câu trả lời phân tích cuối cùng cho người dùng.',
      };
    }

    // Nếu có mã lỗi cụ thể bên trong kết quả, phân loại sâu hơn
    if (result.errorCode === 'INVALID_ARGS' || lower.includes('invalid argument') || lower.includes('validation')) {
      return {
        category: 'SCHEMA_MISMATCH',
        message,
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Attempt auto-coercion or fix argument types matching tool parameter schema.',
        suggestedAlternative,
        errorAs200Unmasked: true,
      };
    }
    if (lower.includes('timeout') || result.errorCode === 'COMMAND_TIMEOUT') {
      return {
        category: 'API_TIMEOUT',
        message,
        isRetryable: true,
        maxRetries: 1,
        backoffMs: 1500,
        recoveryAction: 'Retry once with a simpler query, or decompose into smaller chunks.',
        suggestedAlternative,
        errorAs200Unmasked: true,
      };
    }
    if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
      return {
        category: 'RATE_LIMIT',
        message,
        isRetryable: true,
        maxRetries: 3,
        backoffMs: 2000,
        recoveryAction: 'Apply exponential backoff with jitter (max 3 retries).',
        suggestedAlternative,
        errorAs200Unmasked: true,
      };
    }
    if (lower.includes('permission') || lower.includes('unauthorized') || lower.includes('approval')) {
      return {
        category: 'AUTH_EXPIRED',
        message,
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Flag for user intervention / request operator approval.',
        suggestedAlternative,
        errorAs200Unmasked: true,
      };
    }
    return {
      category: 'ERROR_AS_200',
      message,
      isRetryable: false,
      maxRetries: 0,
      backoffMs: 0,
      recoveryAction: 'Unmask disguised error; inspect result payload and handle error explicitly.',
      suggestedAlternative,
      errorAs200Unmasked: true,
    };
  }

  // 2. Truncated JSON
  if (
    lower.includes('unexpected end of json') ||
    lower.includes('unexpected end of data') ||
    lower.includes('unterminated string') ||
    lower.includes('truncated json') ||
    lower.includes('malformed sse json') ||
    lower.includes('truncated_output')
  ) {
    return {
      category: 'TRUNCATED_JSON',
      message,
      isRetryable: true,
      maxRetries: 1,
      backoffMs: 500,
      recoveryAction: 'Re-fetch with pagination or smaller chunks; repair trailing unclosed JSON braces.',
      suggestedAlternative,
    };
  }

  // 3. API Timeout
  if (
    lower.includes('etimedout') ||
    lower.includes('esockettimedout') ||
    lower.includes('command_timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadlineexceeded') ||
    lower.includes('timeout of')
  ) {
    return {
      category: 'API_TIMEOUT',
      message,
      isRetryable: true,
      maxRetries: 1,
      backoffMs: 1500,
      recoveryAction: 'Retry once with a simpler query/command, then decompose into smaller sub-tasks.',
      suggestedAlternative,
    };
  }

  // 4. Rate Limit (429)
  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota exceeded')
  ) {
    return {
      category: 'RATE_LIMIT',
      message,
      isRetryable: true,
      maxRetries: 3,
      backoffMs: 2000,
      recoveryAction: 'Apply exponential backoff with jitter (max 3 retries).',
      suggestedAlternative,
    };
  }

  // 5. Auth Expired
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('permission_denied') ||
    lower.includes('invalid_api_key') ||
    lower.includes('token expired') ||
    lower.includes('auth expired')
  ) {
    return {
      category: 'AUTH_EXPIRED',
      message,
      isRetryable: false,
      maxRetries: 0,
      backoffMs: 0,
      recoveryAction: 'Flag for user intervention or re-authentication.',
      suggestedAlternative,
    };
  }

  // 6. Mid-chain Break
  if (
    lower.includes('mid-chain') ||
    lower.includes('mid_chain') ||
    lower.includes('midchain') ||
    lower.includes('broken chain') ||
    lower.includes('chain broken') ||
    lower.includes('aborted_before_dispatch') ||
    lower.includes('command_cancelled') ||
    lower.includes('aborterror') ||
    lower.includes('cancellation requested') ||
    lower.includes('interrupted')
  ) {
    return {
      category: 'MID_CHAIN_BREAK',
      message,
      isRetryable: false,
      maxRetries: 0,
      backoffMs: 0,
      recoveryAction: 'Resume from the last successful checkpoint; do not restart chain from scratch.',
      suggestedAlternative,
    };
  }

  // 7. Schema Mismatch
  if (
    lower.includes('invalid_args') ||
    lower.includes('schema mismatch') ||
    lower.includes('validation error') ||
    lower.includes('missing required') ||
    lower.includes('expected string') ||
    lower.includes('expected number') ||
    lower.includes('not declared by the tool schema') ||
    lower.includes('invalid arguments')
  ) {
    return {
      category: 'SCHEMA_MISMATCH',
      message,
      isRetryable: false,
      maxRetries: 0,
      backoffMs: 0,
      recoveryAction: 'Attempt auto-coercion, warn if lossy, or fix parameter format.',
      suggestedAlternative,
    };
  }

  // 8. Network Failure
  if (
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('fetch failed') ||
    lower.includes('network error') ||
    lower.includes('socket hung up')
  ) {
    return {
      category: 'NETWORK_FAILURE',
      message,
      isRetryable: true,
      maxRetries: 2,
      backoffMs: 1000,
      recoveryAction: 'Retry with randomized jitter, maximum 2 attempts.',
      suggestedAlternative,
    };
  }

  // 9. Unknown Error
  return {
    category: 'UNKNOWN_ERROR',
    message,
    isRetryable: false,
    maxRetries: 0,
    backoffMs: 0,
    recoveryAction: 'Log full failure context, escalate to user or pivot to an alternative tool.',
    suggestedAlternative,
  };
}

/**
 * Intelligent Tool-Call Reliability Wrapper (ToolUseGuardian)
 */
export class ToolUseGuardian {
  private reliabilityMap = new Map<string, ToolReliabilityStats>();
  private readonly maxPayloadBytes: number;
  private readonly maxConsecutiveFailuresThreshold: number;
  private preMutationGateContext?: PreMutationGateContext;

  constructor(options?: {
    maxPayloadBytes?: number;
    maxConsecutiveFailuresThreshold?: number;
  }) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 5 * 1024 * 1024; // 5MB
    this.maxConsecutiveFailuresThreshold = options?.maxConsecutiveFailuresThreshold ?? 3;
  }

  setPreMutationGateContext(ctx?: PreMutationGateContext): void {
    this.preMutationGateContext = ctx;
  }

  getPreMutationGateContext(): PreMutationGateContext | undefined {
    return this.preMutationGateContext;
  }

  /**
   * Step 1: Pre-Call Validation & Parameter Auto-Coercion
   */
  preCallValidate(
    toolName: string,
    args: Record<string, any>,
    schema?: any,
    options?: { preMutationGate?: PreMutationGateContext },
  ): GuardianPreCallResult {
    // 1. Kiểm tra kích thước payload
    try {
      const serialized = JSON.stringify(args || {});
      if (serialized.length > this.maxPayloadBytes) {
        const errorMsg = `Tool request size (${serialized.length} bytes) exceeds maximum limit (${this.maxPayloadBytes} bytes).`;
        return {
          valid: false,
          allowed: false,
          coercedArgs: args,
          wasCoerced: false,
          coercedKeys: [],
          error: errorMsg,
          errorCode: 'PAYLOAD_TOO_LARGE',
          reason: errorMsg,
        };
      }
    } catch {
      // Bỏ qua nếu có circular reference (sẽ bị bắt ở json strict)
    }

    // 2. Kiểm tra độ tin cậy của Tool (Reliability status)
    const stats = this.getStats(toolName);
    const suggestedAlternative = stats.isUnreliable
      ? stats.suggestedAlternatives[0] || DEFAULT_TOOL_ALTERNATIVES[toolName]?.[0]
      : undefined;

    // 2a. Tool-Use Guardian: Post-Submission Terminal Gate Check
    const gateContext = options?.preMutationGate || this.preMutationGateContext;
    if (gateContext?.hasSubmittedSolution === true) {
      const errorMsg = 'Tool call bị Tool-Use Guardian từ chối: Giải pháp đã được submit_solution nghiệm thu thành công. Toàn bộ công cụ đã bị khóa. Hãy lập tức hoàn tất lượt (conclude turn) và trả về câu trả lời phân tích tổng kết cho người dùng.';
      return {
        valid: false,
        allowed: false,
        coercedArgs: args,
        wasCoerced: false,
        coercedKeys: [],
        error: errorMsg,
        errorCode: 'POST_SUBMISSION_TOOL_CALL_BLOCKED',
        reason: errorMsg,
      };
    }

    // 2b. Tool-Use Guardian: Semantic check for submit_solution summary (Reject pseudo-completion stubs)
    if (toolName === 'submit_solution' && typeof args.summary === 'string') {
      const summary = args.summary.trim();
      const normalizedSummary = normalizeForMatching(summary);
      const isPseudoClaim = /\b(?:da|vua)?\s*(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+(?:cau tra loi\s+)?(?:chi tiet|chinh xac|day du)/i.test(normalizedSummary)
        || /\b(?:se|will)\s+(?:bao cao|trinh bay|giai thich|cung cap)\s+(?:chi tiet|day du)/i.test(normalizedSummary);
      if (isPseudoClaim && summary.length < 250 && !/[-*•\d]\.\s|```|\*\*|###/.test(summary)) {
        const errorMsg = 'Tool "submit_solution" bị Tool-Use Guardian từ chối: trường "summary" chỉ chứa câu thông báo hoàn tất suông ("Đã cung cấp câu trả lời...") mà không có nội dung phân tích nguyên nhân, vị trí mã nguồn hoặc giải pháp thực tế. Hãy đưa toàn bộ phát hiện kỹ thuật vào summary hoặc trả lời chi tiết cho người dùng.';
        return {
          valid: false,
          allowed: false,
          coercedArgs: args,
          wasCoerced: false,
          coercedKeys: [],
          error: errorMsg,
          errorCode: 'INVALID_SUMMARY_CONTENT',
          reason: errorMsg,
        };
      }
    }

    // 2c. Tool-Use Guardian: Explore-to-Implement Pre-Mutation Gate (Adaptive Pareto 80/20 Rule)
    const isMutationTool = [
      'write_to_file',
      'replace_file_content',
      'multi_replace_file_content',
      'apply_patch',
      'write_file',
      'replace_text',
      'create_file',
      'delete_file',
      'move_file',
    ].includes(toolName);

    const isBugfix = Boolean(
      gateContext?.isBugfixTask ||
      gateContext?.taskIntent === 'bugfix' ||
      gateContext?.taskClass === 'bugfix'
    );

    // Trích xuất đường dẫn file mục tiêu từ các tham số phổ biến
    const targetPath = String(
      args?.path ||
      args?.filePath ||
      args?.file_path ||
      args?.targetFile ||
      args?.file ||
      ''
    ).trim();

    // 1. TDD Fast-Pass: Cho phép tạo/sửa file kiểm thử, spec, reproduction script hoặc scratch file tự do
    const isTestOrReproFile = Boolean(
      targetPath &&
      (
        /([._-](?:test|spec)\.[a-zA-Z0-9]+$)|([\\/](?:tests?|__tests__|scratch|\.scratch)[\\/])/i.test(targetPath) ||
        targetPath.startsWith('scratch/') ||
        targetPath.startsWith('scratch\\') ||
        targetPath.startsWith('.scratch/') ||
        targetPath.startsWith('.scratch\\') ||
        targetPath.startsWith('tests/') ||
        targetPath.startsWith('tests\\') ||
        targetPath.startsWith('test/') ||
        targetPath.startsWith('test\\') ||
        /(?:^|[\\/])(?:scratch|throwaway)[_-][a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/i.test(targetPath)
      )
    );

    // 2. Plan & Phase Fast-Pass: Cho phép can thiệp nếu đã có Kế hoạch được kích hoạt hoặc đã chuyển sang Phase Implement/Verify/Release
    const isAuthorizedPhaseOrPlan = Boolean(
      gateContext?.hasPlan ||
      gateContext?.phase === 'implement' ||
      gateContext?.phase === 'verify' ||
      gateContext?.phase === 'release'
    );

    // 3. Đã có giả thuyết được kiểm chứng
    const hasValidated = Boolean(gateContext?.hasValidatedHypothesis);

    // 4. Trivial fix / Explicit patch bypass
    const isTrivialBypass = Boolean(gateContext?.isTrivialEdit);

    if (isMutationTool && isBugfix && !isTestOrReproFile && !isAuthorizedPhaseOrPlan && !hasValidated && !isTrivialBypass) {
      const errorMsg = `[UNVERIFIED_MUTATION_BLOCKED]: Thao tác can thiệp mã nguồn "${toolName}" bị Cổng Pareto 80/20 từ chối: Bạn đang ở Phase Explore của một tác vụ sửa lỗi nhưng chưa có giả thuyết nào được xác minh. Theo nguyên tắc 80/20, hãy hoàn tất 80% khảo sát bằng cách dùng get_symbol_context_360 / inspect_symbol / query_call_graph, HOẶC tạo bài kiểm thử tạm thời trong "scratch/" để tái hiện/cô lập lỗi trước (hệ thống sẽ tự động dọn dẹp file scratch sau khi kiểm thử thành công mà không tốn thêm bước xóa). Sau đó gọi "formulate_and_verify_hypothesis" để chứng minh nguyên nhân lỗi trước khi được phép sửa code sản phẩm.`;
      return {
        valid: false,
        allowed: false,
        coercedArgs: args,
        wasCoerced: false,
        coercedKeys: [],
        error: errorMsg,
        errorCode: 'UNVERIFIED_MUTATION_BLOCKED',
        reason: errorMsg,
        suggestedAlternative: 'formulate_and_verify_hypothesis',
      };
    }

    // 3. Tự động ép kiểu (Auto-coercion) cho schema không khớp phổ biến
    const { coerced, changed, coercedKeys } = this.coerceParameters(args || {}, schema, toolName);

    return {
      valid: true,
      allowed: true,
      coercedArgs: coerced,
      wasCoerced: changed,
      coercedKeys,
      isUnreliable: stats.isUnreliable,
      suggestedAlternative,
      warning: stats.isUnreliable
        ? `[GUARDIAN ADVISORY] Tool "${toolName}" has failed ${stats.consecutiveFailures} consecutive times (${stats.lastFailureCategory}). Consider alternative: "${suggestedAlternative}".`
        : undefined,
    };
  }

  /**
   * Tự động ép kiểu tham số dựa theo Schema (Schema Auto-Coercion)
   * Hỗ trợ cả hai dạng:
   * 1. coerceParameters(args, schema, toolName?) -> { coerced, changed, coercedKeys }
   * 2. coerceParameters(toolName, args, schema) -> coerced (Record<string, any>)
   */
  coerceParameters(args: Record<string, any>, schema?: any, toolName?: string): { coerced: Record<string, any>; changed: boolean; coercedKeys: string[] };
  coerceParameters(toolName: string, args: Record<string, any>, schema?: any): Record<string, any>;
  coerceParameters(arg1: any, arg2?: any, arg3?: any): any {
    let actualArgs: Record<string, any>;
    let actualSchema: any;
    let toolName: string | undefined;
    const isDirectArgsReturn = typeof arg1 === 'string';

    if (isDirectArgsReturn) {
      toolName = arg1;
      actualArgs = arg2 || {};
      actualSchema = arg3;
    } else {
      actualArgs = arg1 || {};
      actualSchema = arg2;
      toolName = typeof arg3 === 'string' ? arg3 : undefined;
    }

    if (!actualSchema || typeof actualSchema !== 'object' || !actualSchema.properties) {
      return isDirectArgsReturn ? actualArgs : { coerced: actualArgs, changed: false, coercedKeys: [] };
    }

    const coerced = { ...actualArgs };
    let changed = false;
    const coercedKeys: string[] = [];

    // Top-level semantic aliases
    if (actualSchema.properties.path && !('path' in coerced)) {
      const pathAlias = coerced.filePath || coerced.file_path || coerced.filename || coerced.file;
      if (typeof pathAlias === 'string') {
        coerced.path = pathAlias;
        changed = true;
        coercedKeys.push('path');
        if (coerced.filePath && !actualSchema.properties.filePath) delete coerced.filePath;
        if (coerced.file_path && !actualSchema.properties.file_path) delete coerced.file_path;
        if (coerced.filename && !actualSchema.properties.filename) delete coerced.filename;
        if (coerced.file && !actualSchema.properties.file) delete coerced.file;
      }
    }
    if (actualSchema.properties.filePath && !('filePath' in coerced)) {
      const pathAlias = coerced.path || coerced.file_path || coerced.filename || coerced.file;
      if (typeof pathAlias === 'string') {
        coerced.filePath = pathAlias;
        changed = true;
        coercedKeys.push('filePath');
        if (coerced.path && !actualSchema.properties.path) delete coerced.path;
        if (coerced.file_path && !actualSchema.properties.file_path) delete coerced.file_path;
        if (coerced.filename && !actualSchema.properties.filename) delete coerced.filename;
        if (coerced.file && !actualSchema.properties.file) delete coerced.file;
      }
    }
    if (actualSchema.properties.paths && !('paths' in coerced)) {
      const pathsCandidate = coerced.files || coerced.file || coerced.path || coerced.filePaths || coerced.file_paths;
      if (Array.isArray(pathsCandidate)) {
        coerced.paths = pathsCandidate.map(String);
        changed = true;
        coercedKeys.push('paths');
      } else if (typeof pathsCandidate === 'string' && pathsCandidate.trim()) {
        coerced.paths = [pathsCandidate.trim()];
        changed = true;
        coercedKeys.push('paths');
      }
      if (coerced.files && !actualSchema.properties.files) delete coerced.files;
      if (coerced.file && !actualSchema.properties.file) delete coerced.file;
      if (coerced.path && !actualSchema.properties.path) delete coerced.path;
      if (coerced.filePaths && !actualSchema.properties.filePaths) delete coerced.filePaths;
      if (coerced.file_paths && !actualSchema.properties.file_paths) delete coerced.file_paths;
    }
    if (actualSchema.properties.files && !('files' in coerced)) {
      const filesCandidate = coerced.paths || coerced.file || coerced.path || coerced.filePaths || coerced.file_paths;
      if (Array.isArray(filesCandidate)) {
        coerced.files = filesCandidate.map(String);
        changed = true;
        coercedKeys.push('files');
      } else if (typeof filesCandidate === 'string' && filesCandidate.trim()) {
        coerced.files = [filesCandidate.trim()];
        changed = true;
        coercedKeys.push('files');
      }
      if (coerced.paths && !actualSchema.properties.paths) delete coerced.paths;
      if (coerced.file && !actualSchema.properties.file) delete coerced.file;
      if (coerced.path && !actualSchema.properties.path) delete coerced.path;
      if (coerced.filePaths && !actualSchema.properties.filePaths) delete coerced.filePaths;
      if (coerced.file_paths && !actualSchema.properties.file_paths) delete coerced.file_paths;
    }
    if (actualSchema.properties.command && !('command' in coerced)) {
      const cmdAlias = coerced.cmd;
      if (typeof cmdAlias === 'string') {
        coerced.command = cmdAlias;
        changed = true;
        coercedKeys.push('command');
        if (coerced.cmd && !actualSchema.properties.cmd) delete coerced.cmd;
      }
    }

    for (const [key, prop] of Object.entries<any>(actualSchema.properties)) {
      if (key in coerced) {
        let val = coerced[key];
        const targetType = (prop.type || '').toLowerCase();

        // Chuỗi số thành number (ví dụ: "10" -> 10)
        if ((targetType === 'number' || targetType === 'integer') && typeof val === 'string' && val.trim() !== '') {
          const num = Number(val);
          if (Number.isFinite(num)) {
            coerced[key] = num;
            changed = true;
            coercedKeys.push(key);
            val = num;
          }
        }
        // Chuỗi boolean thành boolean (ví dụ: "true" -> true)
        else if (targetType === 'boolean' && typeof val === 'string') {
          if (val.toLowerCase() === 'true') {
            coerced[key] = true;
            changed = true;
            coercedKeys.push(key);
            val = true;
          } else if (val.toLowerCase() === 'false') {
            coerced[key] = false;
            changed = true;
            coercedKeys.push(key);
            val = false;
          }
        }
        // Chuỗi JSON thành object / array (ví dụ: "{\"a\":1}" -> {a: 1}) hoặc chuỗi đơn thành mảng (ví dụ: "file.ts" -> ["file.ts"])
        else if ((targetType === 'object' || targetType === 'array') && typeof val === 'string') {
          const trimmed = val.trim();
          let parsed = false;
          if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
              val = JSON.parse(trimmed);
              coerced[key] = val;
              changed = true;
              coercedKeys.push(key);
              parsed = true;
            } catch {
              // Bỏ qua nếu parse thất bại
            }
          }
          if (!parsed && targetType === 'array' && trimmed !== '') {
            val = [trimmed];
            coerced[key] = val;
            changed = true;
            coercedKeys.push(key);
          }
        }

        // Deep Array & Item-Level Coercion
        if ((targetType === 'array' || Array.isArray(val)) && Array.isArray(val)) {
          let arrayChanged = false;
          const newArray = val.map((item) => {
            // Phần tử là chuỗi số mà schema items yêu cầu number/integer
            if (prop.items && (prop.items.type === 'number' || prop.items.type === 'integer') && typeof item === 'string' && item.trim() !== '') {
              const num = Number(item);
              if (Number.isFinite(num)) {
                arrayChanged = true;
                return num;
              }
            }
            // Phần tử là object
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              let itemChanged = false;
              const coercedItem = { ...item };

              // Quy tắc đặc thù cho create_plan hoặc mảng tasks:
              if (toolName === 'create_plan' || key === 'tasks') {
                // Ánh xạ description -> title nếu thiếu title
                if (!coercedItem.title && typeof coercedItem.description === 'string' && coercedItem.description.trim()) {
                  coercedItem.title = coercedItem.description.trim();
                  itemChanged = true;
                }
                // Ép kiểu chuỗi số id -> number
                if (typeof coercedItem.id === 'string' && /^\d+$/.test(coercedItem.id.trim())) {
                  const parsedId = Number(coercedItem.id.trim());
                  if (Number.isFinite(parsedId)) {
                    coercedItem.id = parsedId;
                    itemChanged = true;
                  }
                }
              }

              // Ánh xạ theo schema items.properties nếu có
              if (prop.items?.properties) {
                for (const [subKey, subProp] of Object.entries<any>(prop.items.properties)) {
                  if (subKey in coercedItem) {
                    const subVal = coercedItem[subKey];
                    const subTargetType = (subProp.type || '').toLowerCase();
                    if ((subTargetType === 'number' || subTargetType === 'integer') && typeof subVal === 'string' && subVal.trim() !== '') {
                      const num = Number(subVal);
                      if (Number.isFinite(num)) {
                        coercedItem[subKey] = num;
                        itemChanged = true;
                      }
                    } else if (subTargetType === 'boolean' && typeof subVal === 'string') {
                      if (subVal.toLowerCase() === 'true') {
                        coercedItem[subKey] = true;
                        itemChanged = true;
                      } else if (subVal.toLowerCase() === 'false') {
                        coercedItem[subKey] = false;
                        itemChanged = true;
                      }
                    }
                  }
                }
              }

              if (itemChanged) {
                arrayChanged = true;
                return coercedItem;
              }
            }
            return item;
          });

          if (arrayChanged) {
            coerced[key] = newArray;
            changed = true;
            if (!coercedKeys.includes(key)) coercedKeys.push(key);
          }
        }
      }
    }

    if (isDirectArgsReturn) {
      return coerced;
    }
    return { coerced, changed, coercedKeys };
  }

  /**
   * Step 2 & 4: Ghi nhận kết quả thực thi & Cập nhật chỉ số độ tin cậy
   */
  recordExecution(
    toolName: string,
    result: Record<string, any>,
    durationMs: number,
  ): ToolFailureDiagnosis | undefined {
    const stats = this.getOrCreateStats(toolName);
    stats.totalCalls++;

    const isFailure = Boolean(
      result.error !== undefined ||
      result.success === false ||
      result.status === 'error' ||
      result.status === 'failed' ||
      result.errorCode
    );

    if (!isFailure) {
      stats.successfulCalls++;
      stats.consecutiveFailures = 0;
      stats.isUnreliable = false;
      stats.unreliableReason = undefined;
      return undefined;
    }

    // Phân loại lỗi theo 9 categories
    const diagnosis = classifyToolFailure(toolName, result.error || result.errorCode, result);
    stats.failedCalls++;
    stats.consecutiveFailures++;
    stats.lastFailureAt = Date.now();
    stats.lastFailureCategory = diagnosis.category;
    stats.failuresByCategory[diagnosis.category] = (stats.failuresByCategory[diagnosis.category] || 0) + 1;

    // Đánh dấu unreliable nếu lỗi liên tiếp >= 3 lần
    if (stats.consecutiveFailures >= this.maxConsecutiveFailuresThreshold) {
      stats.isUnreliable = true;
      stats.unreliableReason = `${stats.consecutiveFailures} consecutive failures (most recent: ${diagnosis.category})`;
      if (stats.suggestedAlternatives.length === 0) {
        stats.suggestedAlternatives = DEFAULT_TOOL_ALTERNATIVES[toolName] || [];
      }
    }

    return diagnosis;
  }

  /**
   * Lấy thống kê độ tin cậy của Tool
   */
  getStats(toolName: string): ToolReliabilityStats {
    const existing = this.reliabilityMap.get(toolName);
    if (existing) return { ...existing };
    return {
      toolName,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      consecutiveFailures: 0,
      failuresByCategory: {},
      isUnreliable: false,
      suggestedAlternatives: DEFAULT_TOOL_ALTERNATIVES[toolName] || [],
    };
  }

  /**
   * Tạo báo cáo độ tin cậy tổng thể cho toàn bộ các tool đã gọi
   */
  getReliabilityReport(): ToolReliabilityStats[] {
    return Array.from(this.reliabilityMap.values()).map((s) => ({ ...s }));
  }

  /**
   * Khôi phục trạng thái tin cậy của tool
   */
  resetToolReliability(toolName: string): void {
    const stats = this.reliabilityMap.get(toolName);
    if (stats) {
      stats.consecutiveFailures = 0;
      stats.isUnreliable = false;
      stats.unreliableReason = undefined;
    }
  }

  /**
   * Kiểm tra xem một tool có đang bị đánh dấu không tin cậy (Unreliable) do lỗi liên tiếp >= 3 lần hay không
   */
  isToolUnreliable(toolName: string): boolean {
    return this.getStats(toolName).isUnreliable;
  }

  private getOrCreateStats(toolName: string): ToolReliabilityStats {
    let stats = this.reliabilityMap.get(toolName);
    if (!stats) {
      stats = {
        toolName,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        consecutiveFailures: 0,
        failuresByCategory: {},
        isUnreliable: false,
        suggestedAlternatives: DEFAULT_TOOL_ALTERNATIVES[toolName] || [],
      };
      this.reliabilityMap.set(toolName, stats);
    }
    return stats;
  }
}
