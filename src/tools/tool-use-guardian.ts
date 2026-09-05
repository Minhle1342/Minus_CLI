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

export type ToolFailureCategory =
  | 'TRUNCATED_JSON'
  | 'API_TIMEOUT'
  | 'RATE_LIMIT'
  | 'AUTH_EXPIRED'
  | 'MID_CHAIN_BREAK'
  | 'ERROR_AS_200'
  | 'SCHEMA_MISMATCH'
  | 'NETWORK_FAILURE'
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

export interface GuardianPreCallResult {
  valid: boolean;
  coercedArgs: Record<string, any>;
  wasCoerced: boolean;
  coercedKeys: string[];
  warning?: string;
  error?: string;
  errorCode?: string;
  isUnreliable?: boolean;
  suggestedAlternative?: string;
}

export const DEFAULT_TOOL_ALTERNATIVES: Record<string, string[]> = {
  search_codebase_fast: ['grep_search', 'run_command (rg)', 'read_file'],
  grep_search: ['search_codebase_fast', 'run_command (rg)'],
  search_text: ['grep_search', 'read_file', 'run_command (rg)'],
  read_file: ['run_command (cat/head)', 'inspect_symbol'],
  replace_text: ['apply_patch', 'write_file'],
  apply_patch: ['replace_text', 'write_file'],
  query_call_graph: ['inspect_symbol', 'read_file', 'find_references'],
  get_route_map: ['grep_search', 'read_file'],
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
    lower.includes('expected number')
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

  constructor(options?: {
    maxPayloadBytes?: number;
    maxConsecutiveFailuresThreshold?: number;
  }) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 5 * 1024 * 1024; // 5MB
    this.maxConsecutiveFailuresThreshold = options?.maxConsecutiveFailuresThreshold ?? 3;
  }

  /**
   * Step 1: Pre-Call Validation & Parameter Auto-Coercion
   */
  preCallValidate(
    toolName: string,
    args: Record<string, any>,
    schema?: any,
  ): GuardianPreCallResult {
    // 1. Kiểm tra kích thước payload
    try {
      const serialized = JSON.stringify(args || {});
      if (serialized.length > this.maxPayloadBytes) {
        return {
          valid: false,
          coercedArgs: args,
          wasCoerced: false,
          coercedKeys: [],
          error: `Tool request size (${serialized.length} bytes) exceeds maximum limit (${this.maxPayloadBytes} bytes).`,
          errorCode: 'PAYLOAD_TOO_LARGE',
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

    // 3. Tự động ép kiểu (Auto-coercion) cho schema không khớp phổ biến
    const { coerced, changed, coercedKeys } = this.coerceParameters(args || {}, schema);

    return {
      valid: true,
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
   * 1. coerceParameters(args, schema) -> { coerced, changed, coercedKeys }
   * 2. coerceParameters(toolName, args, schema) -> coerced (Record<string, any>)
   */
  coerceParameters(args: Record<string, any>, schema?: any): { coerced: Record<string, any>; changed: boolean; coercedKeys: string[] };
  coerceParameters(toolName: string, args: Record<string, any>, schema?: any): Record<string, any>;
  coerceParameters(arg1: any, arg2?: any, arg3?: any): any {
    let actualArgs: Record<string, any>;
    let actualSchema: any;
    const isDirectArgsReturn = typeof arg1 === 'string';

    if (isDirectArgsReturn) {
      actualArgs = arg2 || {};
      actualSchema = arg3;
    } else {
      actualArgs = arg1 || {};
      actualSchema = arg2;
    }

    if (!actualSchema || typeof actualSchema !== 'object' || !actualSchema.properties) {
      return isDirectArgsReturn ? actualArgs : { coerced: actualArgs, changed: false, coercedKeys: [] };
    }

    const coerced = { ...actualArgs };
    let changed = false;
    const coercedKeys: string[] = [];

    for (const [key, prop] of Object.entries<any>(actualSchema.properties)) {
      if (key in coerced) {
        const val = coerced[key];
        const targetType = (prop.type || '').toLowerCase();

        // Chuỗi số thành number (ví dụ: "10" -> 10)
        if ((targetType === 'number' || targetType === 'integer') && typeof val === 'string' && val.trim() !== '') {
          const num = Number(val);
          if (Number.isFinite(num)) {
            coerced[key] = num;
            changed = true;
            coercedKeys.push(key);
          }
        }
        // Chuỗi boolean thành boolean (ví dụ: "true" -> true)
        else if (targetType === 'boolean' && typeof val === 'string') {
          if (val.toLowerCase() === 'true') {
            coerced[key] = true;
            changed = true;
            coercedKeys.push(key);
          } else if (val.toLowerCase() === 'false') {
            coerced[key] = false;
            changed = true;
            coercedKeys.push(key);
          }
        }
        // Chuỗi JSON thành object / array (ví dụ: "{\"a\":1}" -> {a: 1})
        else if ((targetType === 'object' || targetType === 'array') && typeof val === 'string') {
          const trimmed = val.trim();
          if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
              coerced[key] = JSON.parse(trimmed);
              changed = true;
              coercedKeys.push(key);
            } catch {
              // Bỏ qua nếu parse thất bại
            }
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
