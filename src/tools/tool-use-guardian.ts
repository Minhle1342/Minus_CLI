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

import fs from 'node:fs';
import path from 'node:path';
import { normalizeForMatching } from '../agent/final-answer-guard.js';
import { extractTechnicalEntities, CONCRETE_ACTION_VERBS_REGEX, isPurelyEvasiveText } from '../agent/solution-grounding-auditor.js';
import { detectLazyOmission, resolveFullRewriteWarnLines } from '../agent/aci-guardrails.js';
import { PatchEngine } from '../patch/patch-engine.js';

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
  | 'AUTHORIZATION_DENIED'
  | 'BUDGET_EXHAUSTED'
  | 'SECURITY_VIOLATION'
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
  validatedTargetFiles?: string[];
  isTrivialEdit?: boolean;
  /** `off` skips only the Adaptive Pareto evidence block; other mutation guards still apply. */
  evidenceGateMode?: 'off' | 'observe' | 'enforce';
  risk?: string;
  evidenceScore?: number;
  evidenceThreshold?: number;
  evidenceReasons?: string[];
  inspectedFiles?: string[];
  supportedHypothesisCount?: number;
  hasEmpiricalEvidence?: boolean;
  hasSubmittedSolution?: boolean;
  cascadeFrozen?: boolean;
  cascadeReason?: string;
  allMutationsAreNonExecutable?: boolean;
  userExplicitlyExemptsTesting?: boolean;
  reproductionStatus?: {
    isVerified?: boolean;
    hasPreFixRepro?: boolean;
    hasPostFixPass?: boolean;
    enforceReproductionPass?: boolean;
  };
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
  run_node_script: ['apply_patch', 'replace_text', 'run_command'],
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
        recoveryAction: 'Collect the missing evidence named in the gate notice: read the right target, trace the structure, or run a reproduction test for high-risk changes.',
        suggestedAlternative: 'read_file',
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
        recoveryAction: 'The solution has been accepted. All tool calls are now locked. Immediately conclude the turn and send the final analysis answer to the user.',
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
  private workspaceDir: string;

  constructor(options?: {
    maxPayloadBytes?: number;
    maxConsecutiveFailuresThreshold?: number;
    workspaceDir?: string;
  }) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 5 * 1024 * 1024; // 5MB
    this.maxConsecutiveFailuresThreshold = options?.maxConsecutiveFailuresThreshold ?? 3;
    this.workspaceDir = options?.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
  }

  setWorkspaceDir(dir: string): void {
    if (dir) {
      this.workspaceDir = path.resolve(dir);
    }
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
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
      const errorMsg = 'Tool call rejected by Tool-Use Guardian: the solution has been accepted via submit_solution. All tools are now locked. Immediately conclude the turn (conclude turn) and return the final summary analysis to the user.';
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
      const isEvasivePhrase = isPurelyEvasiveText(normalizedSummary);
      const hasActionVerb = CONCRETE_ACTION_VERBS_REGEX.test(normalizedSummary);
      const entities = extractTechnicalEntities(summary);
      const declaredFiles = Array.isArray(args.filesModified)
        ? args.filesModified.filter((f: any) => typeof f === 'string' && f.trim().length > 0)
        : [];
      const hasSubstance =
        entities.length > 0 ||
        declaredFiles.length > 0 ||
        Boolean(args.rootCause && String(args.rootCause).trim().length > 0);

      const isPseudoClaim = !hasSubstance && (isEvasivePhrase || (!hasActionVerb && summary.length < 140));
      if (isPseudoClaim && summary.length < 250 && !/[-*•\d]\.\s|```|\*\*|###/.test(summary)) {
        const errorMsg = 'Tool "submit_solution" rejected by Tool-Use Guardian: the "summary" field contains only a hollow completion notice ("Answer provided...") with no root-cause analysis, source location, or concrete solution. Put all technical findings into summary or answer the user in detail.';
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

      // SWE-Reasoner Execution-Verified Gating (Phase 1):
      const declaredAllNonExecutable = declaredFiles.length > 0
        && declaredFiles.every((f: string) => {
          const lower = f.trim().toLowerCase();
          return /\.(?:md|markdown|txt|rst|csv|tsv|svg|png|jpe?g|gif|webp|ico|json|ya?ml|toml|ini|xml|css|scss|sass|less|lock)$/i.test(lower);
        });

      const isNonCodeTask = args.resolutionType === 'investigation_only'
        || args.resolutionType === 'text_or_asset_edit'
        || (args.resolutionType === 'configuration_change' && declaredAllNonExecutable)
        || gateContext?.allMutationsAreNonExecutable === true
        || declaredAllNonExecutable;
      const userExempted = gateContext?.userExplicitlyExemptsTesting === true;
      const isBugfix = gateContext?.isBugfixTask !== false;

      if (
        isBugfix &&
        gateContext?.reproductionStatus?.enforceReproductionPass &&
        !gateContext.reproductionStatus.hasPostFixPass &&
        !isNonCodeTask &&
        !userExempted
      ) {
        const errorMsg = 'Tool "submit_solution" blocked by the Reproduction Verification Gate (SWE-Reasoner): bugfix tasks require execution proof that the bug-reproduction test passes after the fix (post-fix PASS). Run the verification test before submitting the solution.';
        return {
          valid: false,
          allowed: false,
          coercedArgs: args,
          wasCoerced: false,
          coercedKeys: [],
          error: errorMsg,
          errorCode: 'REPRODUCTION_VERIFICATION_REQUIRED',
          reason: errorMsg,
          suggestedAlternative: 'run_command',
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
      'run_node_script',
    ].includes(toolName);

    // 2c(i). Lazy-omission sensor: block LLM placeholders that would silently
    // delete code ("# ... rest of code unchanged"). Content-bearing writes only;
    // apply_patch hunks and deletions carry no free-form content to scan.
    let hugeRewriteWarning: string | undefined;
    if (['write_file', 'write_to_file', 'replace_text', 'replace_file_content', 'create_file'].includes(toolName)) {
      const fullContent = String(
        args?.content ?? args?.CodeContent ?? args?.codeContent
        ?? args?.newText ?? args?.new_text
        ?? args?.ReplacementContent ?? args?.replacementContent ?? '',
      );
      if (fullContent) {
        const targetForScan = String(
          args?.path || args?.filePath || args?.file_path
          || args?.targetFile || args?.TargetFile || args?.file || '',
        );
        const omissions = detectLazyOmission(fullContent, targetForScan);
        if (omissions.length > 0) {
          const shown = omissions.slice(0, 3)
            .map((finding) => `line ${finding.line}: "${finding.marker}"`)
            .join('; ');
          const errorMsg = `[LAZY_OMISSION_BLOCKED]: "${toolName}" contains lazy markers (${shown}) — a sign the LLM rewrote content while dropping code. Split into smaller "replace_text" calls with concrete anchor oldText blocks, or write the full content; never use placeholders.`;
          return {
            valid: false,
            allowed: false,
            coercedArgs: args,
            wasCoerced: false,
            coercedKeys: [],
            error: errorMsg,
            errorCode: 'LAZY_OMISSION_BLOCKED',
            reason: errorMsg,
            suggestedAlternative: 'replace_text',
          };
        }
        if ((toolName === 'write_file' || toolName === 'write_to_file')
          && fullContent.split(/\r?\n/).length > resolveFullRewriteWarnLines()) {
          hugeRewriteWarning = `Warning: long full-file rewrite (${fullContent.split(/\r?\n/).length} lines): prefer multiple small "replace_text" edits per chunk to reduce the risk of dropped code instead of one full overwrite.`;
        }
      }
    }

    const isEvidenceControlledTask = Boolean(
      gateContext?.isBugfixTask ||
      gateContext?.taskIntent === 'bugfix' ||
      gateContext?.taskClass === 'bugfix' ||
      gateContext?.taskClass === 'refactor' ||
      gateContext?.taskClass === 'security'
    );

    const targetPath = String(
      args?.path ||
      args?.filePath ||
      args?.file_path ||
      args?.targetFile ||
      args?.file ||
      ''
    ).trim();
    const patchFiles = toolName === 'apply_patch'
      ? PatchEngine.parsePatch(String(args?.patch || ''), targetPath || undefined).files
      : [];
    const targetPaths = patchFiles.length
      ? patchFiles.map((file) => file.newPath || file.oldPath || '')
      : [targetPath];
    let evidenceGateWarning: string | undefined;

    // 2c(iii). Cascade-repair freeze: ≥3 consecutive failures on ONE error
    // signature means flailing, not exploration. Mutations stay locked until
    // the agent pivots (new signature, verified success, re-plan). Read and
    // verification tools remain available to gather a new signal.
    if (isMutationTool && gateContext?.cascadeFrozen) {
      const detail = gateContext.cascadeReason ? ` ${gateContext.cascadeReason}.` : '';
      const errorMsg = `[CASCADE_REPAIR_FROZEN]: Mutation tools are locked because repeated fixes keep failing on the same error.${detail} Stop editing blindly: revise the root-cause hypothesis, re-plan via "update_plan_task", or run diagnostics/tests to obtain a genuinely different signal before mutating again.`;
      return {
        valid: false,
        allowed: false,
        coercedArgs: args,
        wasCoerced: false,
        coercedKeys: [],
        error: errorMsg,
        errorCode: 'CASCADE_REPAIR_FROZEN',
        reason: errorMsg,
        suggestedAlternative: 'update_plan_task',
      };
    }

    for (const filePath of targetPaths) {
      // Test/reproduction files may be created before the production target is inspected.
      const isTestOrReproFile = Boolean(filePath && (
        /([._-](?:test|spec)\.[a-zA-Z0-9]+$)|([\\/](?:tests?|__tests__|scratch|\.scratch)[\\/])/i.test(filePath)
        || /^(?:\.?scratch|tests?)[\\/]/i.test(filePath)
        || /(?:^|[\\/])(?:scratch|throwaway)[_-][a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/i.test(filePath)
      ));
      if (!isMutationTool || gateContext?.evidenceGateMode === 'off' || !isEvidenceControlledTask || isTestOrReproFile) continue;

      const normalizeTarget = (value: string): string => {
        if (!value) return '';
        const absolute = path.isAbsolute(value) ? value : path.resolve(this.workspaceDir, value);
        return path.relative(this.workspaceDir, absolute).replace(/\\/g, '/').toLowerCase();
      };
      const normalizedTarget = normalizeTarget(filePath);
      const targetInspected = Boolean(normalizedTarget
        && gateContext?.inspectedFiles?.some((file) => normalizeTarget(file) === normalizedTarget));
      const targetEmpiricallyValidated = Boolean(normalizedTarget && gateContext?.hasValidatedHypothesis
        && gateContext?.validatedTargetFiles?.some((file) => normalizeTarget(file) === normalizedTarget));
      const risk = gateContext?.risk || 'R2';
      const isHighRisk = gateContext?.taskClass === 'security' || ['R3', 'R4', 'R5'].includes(risk);
      const evidenceThreshold = Math.max(1, gateContext?.evidenceThreshold || (isHighRisk ? 5 : risk === 'R2' ? 3 : 2));
      const evidenceScore = (gateContext?.evidenceScore || 0) + (targetInspected ? 2 : 0);
      const hasEmpiricalEvidence = Boolean(gateContext?.hasValidatedHypothesis
        || gateContext?.hasEmpiricalEvidence || gateContext?.reproductionStatus?.hasPreFixRepro);
      const oldText = String(args?.oldText || args?.old_text || args?.TargetContent || args?.targetContent || args?.searchContent || args?.searchText || '');
      const newText = String(args?.newText || args?.new_text || args?.ReplacementContent || args?.replacementContent || args?.replaceWith || '');
      const changedLineCount = Math.max(oldText.split(/\r?\n/).length, newText.split(/\r?\n/).length);
      const isSmallInspectedEdit = toolName === 'replace_text' && targetInspected
        && Math.max(oldText.length, newText.length) <= 800 && changedLineCount <= 8 && !isHighRisk;
      const isTrivialFastPath = !isHighRisk && Boolean(gateContext?.isTrivialEdit || isSmallInspectedEdit);
      const plannedR3FastPath = risk === 'R3' && gateContext?.taskClass === 'refactor'
        && gateContext?.hasPlan === true && targetInspected;
      const evidenceSufficient = targetEmpiricallyValidated || isTrivialFastPath || plannedR3FastPath
        || (targetInspected && evidenceScore >= evidenceThreshold && (!isHighRisk || hasEmpiricalEvidence));
      if (evidenceSufficient) continue;

      const missing = !targetInspected && !targetEmpiricallyValidated
        ? `read the exact target "${filePath || '(unknown)'}" before editing`
        : isHighRisk && !hasEmpiricalEvidence
          ? 'run a reproduction/test with observable results for high-risk changes'
          : `add evidence up to threshold ${evidenceThreshold}`;
      const reasons = gateContext?.evidenceReasons?.length
        ? ` Current evidence: ${gateContext.evidenceReasons.join(', ')}.`
        : '';
      const errorMsg = `[UNVERIFIED_MUTATION_BLOCKED]: Adaptive Pareto gate blocks "${toolName}" because uncertainty is still high relative to the cost of error (evidence ${evidenceScore}/${evidenceThreshold}, risk ${risk}). Need ${missing}.${reasons}`;
      if (gateContext?.evidenceGateMode === 'observe') {
        evidenceGateWarning = `[EVIDENCE_GATE_OBSERVE]: ${errorMsg}`;
        break;
      }
      return {
        valid: false,
        allowed: false,
        coercedArgs: args,
        wasCoerced: false,
        coercedKeys: [],
        error: errorMsg,
        errorCode: 'UNVERIFIED_MUTATION_BLOCKED',
        reason: errorMsg,
        suggestedAlternative: targetInspected ? 'formulate_and_verify_hypothesis' : 'read_file',
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
      warning: [
        hugeRewriteWarning,
        evidenceGateWarning,
        stats.isUnreliable
          ? `[GUARDIAN ADVISORY] Tool "${toolName}" has failed ${stats.consecutiveFailures} consecutive times (${stats.lastFailureCategory}). Consider alternative: "${suggestedAlternative}".`
          : undefined,
      ].filter(Boolean).join('\n') || undefined,
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
    // Top-level semantic aliases cho TargetFile, AbsolutePath, SearchPath, DirectoryPath
    const pathKeys = ['TargetFile', 'AbsolutePath', 'SearchPath', 'DirectoryPath', 'path', 'filePath', 'targetFile'];
    for (const field of pathKeys) {
      if (actualSchema.properties[field] && !(field in coerced)) {
        const candidate = coerced.TargetFile || coerced.AbsolutePath || coerced.targetFile || coerced.path || coerced.filePath || coerced.file_path || coerced.file || coerced.SearchPath || coerced.DirectoryPath;
        if (typeof candidate === 'string') {
          coerced[field] = candidate;
          changed = true;
          coercedKeys.push(field);
        }
      }
    }
    if (actualSchema.properties.CommandLine && !('CommandLine' in coerced)) {
      const cmd = coerced.command || coerced.cmd || coerced.commandLine;
      if (typeof cmd === 'string') {
        coerced.CommandLine = cmd;
        changed = true;
        coercedKeys.push('CommandLine');
      }
    }
    if (actualSchema.properties.Cwd && !('Cwd' in coerced)) {
      const cwd = coerced.cwd || coerced.workingDir || coerced.workdir;
      if (typeof cwd === 'string') {
        coerced.Cwd = cwd;
        changed = true;
        coercedKeys.push('Cwd');
      }
    }
    if (actualSchema.properties.WaitMsBeforeAsync && !('WaitMsBeforeAsync' in coerced)) {
      const wait = coerced.waitMs || coerced.timeout || coerced.waitMsBeforeAsync;
      if (wait !== undefined) {
        coerced.WaitMsBeforeAsync = wait;
        changed = true;
        coercedKeys.push('WaitMsBeforeAsync');
      }
    }

    // Top-level semantic aliases cho oldText / TargetContent và newText / ReplacementContent
    if (actualSchema.properties.oldText && (!coerced.oldText || typeof coerced.oldText !== 'string' || coerced.oldText.trim() === '')) {
      const candidate = coerced.old_text
        ?? coerced.oldContent
        ?? coerced.old_content
        ?? coerced.TargetContent
        ?? coerced.targetContent
        ?? coerced.target_content
        ?? coerced.searchContent
        ?? coerced.search_content
        ?? coerced.searchText
        ?? coerced.search_text
        ?? coerced.originalText
        ?? coerced.original_text
        ?? coerced.find;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        coerced.oldText = candidate;
        changed = true;
        coercedKeys.push('oldText');
      }
    }
    if (actualSchema.properties.newText && (!coerced.newText || typeof coerced.newText !== 'string' || coerced.newText.trim() === '')) {
      const candidate = coerced.new_text
        ?? coerced.newContent
        ?? coerced.new_content
        ?? coerced.ReplacementContent
        ?? coerced.replacementContent
        ?? coerced.replacement_content
        ?? coerced.replaceWith
        ?? coerced.replace_with
        ?? coerced.replacement
        ?? coerced.updatedText
        ?? coerced.updated_text
        ?? coerced.replace;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        coerced.newText = candidate;
        changed = true;
        coercedKeys.push('newText');
      }
    }
    if (actualSchema.properties.TargetContent && (!coerced.TargetContent || typeof coerced.TargetContent !== 'string' || coerced.TargetContent.trim() === '')) {
      const candidate = coerced.oldText
        ?? coerced.old_text
        ?? coerced.oldContent
        ?? coerced.old_content
        ?? coerced.targetContent
        ?? coerced.target_content
        ?? coerced.searchContent
        ?? coerced.search_content
        ?? coerced.originalText
        ?? coerced.find;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        coerced.TargetContent = candidate;
        changed = true;
        coercedKeys.push('TargetContent');
      }
    }
    if (actualSchema.properties.ReplacementContent && (!coerced.ReplacementContent || typeof coerced.ReplacementContent !== 'string' || coerced.ReplacementContent.trim() === '')) {
      const candidate = coerced.newText
        ?? coerced.new_text
        ?? coerced.newContent
        ?? coerced.new_content
        ?? coerced.replacementContent
        ?? coerced.replacement_content
        ?? coerced.replaceWith
        ?? coerced.replace_with
        ?? coerced.replacement
        ?? coerced.updatedText
        ?? coerced.replace;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        coerced.ReplacementContent = candidate;
        changed = true;
        coercedKeys.push('ReplacementContent');
      }
    }

    // Xóa các key alias không có trong schema để tránh bị rejectUnknownProperties từ chối
    const textAliasesToClean = [
      'old_text', 'oldContent', 'old_content', 'targetContent', 'target_content',
      'searchContent', 'search_content', 'searchText', 'search_text', 'originalText', 'original_text', 'find',
      'new_text', 'newContent', 'new_content', 'replacementContent', 'replacement_content',
      'replaceWith', 'replace_with', 'replacement', 'updatedText', 'updated_text', 'replace',
    ];
    if (actualSchema.properties.oldText && !actualSchema.properties.TargetContent) {
      textAliasesToClean.push('TargetContent');
    }
    if (actualSchema.properties.newText && !actualSchema.properties.ReplacementContent) {
      textAliasesToClean.push('ReplacementContent');
    }
    if (actualSchema.properties.TargetContent && !actualSchema.properties.oldText) {
      textAliasesToClean.push('oldText');
    }
    if (actualSchema.properties.ReplacementContent && !actualSchema.properties.newText) {
      textAliasesToClean.push('newText');
    }
    for (const alias of textAliasesToClean) {
      if (alias in coerced && !actualSchema.properties[alias]) {
        delete coerced[alias];
      }
    }

    for (const [key, prop] of Object.entries<any>(actualSchema.properties)) {
      if (key in coerced) {
        let val = coerced[key];
        const targetType = (prop.type || '').toLowerCase();

        // Chuỗi string: loại bỏ quotes bọc ngoài và tự động resolve relative path sang absolute path nếu cần
        if (targetType === 'string' && typeof val === 'string') {
          let cleaned = val.trim();
          if (
            (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
            (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
            (cleaned.startsWith('`') && cleaned.endsWith('`'))
          ) {
            cleaned = cleaned.slice(1, -1).trim();
            if (cleaned !== val) {
              val = cleaned;
              coerced[key] = val;
              changed = true;
              coercedKeys.push(key);
            }
          }

          // Safe Parameter Resolution (Life-Harness Action Realization):
          // Nếu trường yêu cầu đường dẫn tuyệt đối hoặc là TargetFile/AbsolutePath/SearchPath/DirectoryPath/Cwd, tự động resolve & auto-repair đuôi file
          const isAbsoluteField = ['targetfile', 'absolutepath', 'searchpath', 'directorypath', 'cwd'].includes(key.toLowerCase())
            || (typeof prop.description === 'string' && prop.description.toLowerCase().includes('must be an absolute path'));
          if (isAbsoluteField && val.length > 0 && !val.startsWith('http://') && !val.startsWith('https://')) {
            let candidatePath = val;
            if (!path.isAbsolute(candidatePath)) {
              candidatePath = path.resolve(this.workspaceDir, candidatePath);
            }
            // Auto-heal missing extension if target file does not exist directly
            if (!fs.existsSync(candidatePath)) {
              const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs', '.py', '.go', '.rs'];
              for (const ext of extensions) {
                const withExt = candidatePath + ext;
                if (fs.existsSync(withExt)) {
                  candidatePath = withExt;
                  break;
                }
              }
            }
            if (candidatePath !== val) {
              coerced[key] = candidatePath;
              changed = true;
              coercedKeys.push(key);
              val = candidatePath;
            }
          }
        }
        // Chuỗi số thành number (ví dụ: "10" -> 10, "5000" -> 5000)
        else if ((targetType === 'number' || targetType === 'integer') && typeof val === 'string' && val.trim() !== '') {
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

    // Tier 2 Self-Healing: Fuzzy whitespace and line offset auto-repair for text replacement tools
    const targetFilePath = String(coerced.TargetFile || coerced.path || coerced.filePath || coerced.targetFile || '').trim();
    const targetContentVal = coerced.TargetContent ?? coerced.oldText ?? coerced.old_text;
    if (targetFilePath && typeof targetContentVal === 'string' && targetContentVal.length > 0) {
      try {
        const absFile = path.isAbsolute(targetFilePath) ? targetFilePath : path.resolve(this.workspaceDir, targetFilePath);
        if (fs.existsSync(absFile)) {
          const fileContent = fs.readFileSync(absFile, 'utf8');
          // If not an exact match, attempt fuzzy whitespace and line normalization
          if (!fileContent.includes(targetContentVal)) {
            const healed = this.fuzzyAlignTargetContent(fileContent, targetContentVal);
            if (healed) {
              if ('TargetContent' in coerced || actualSchema?.properties?.TargetContent) {
                coerced.TargetContent = healed.exactMatch;
                changed = true;
                coercedKeys.push('TargetContent:FuzzyWhitespaceHealed');
              } else if ('oldText' in coerced || actualSchema?.properties?.oldText) {
                coerced.oldText = healed.exactMatch;
                changed = true;
                coercedKeys.push('oldText:FuzzyWhitespaceHealed');
              }
              if (actualSchema?.properties?.StartLine && healed.startLine) {
                coerced.StartLine = healed.startLine;
                changed = true;
                coercedKeys.push('StartLine:DriftHealed');
              }
              if (actualSchema?.properties?.EndLine && healed.endLine) {
                coerced.EndLine = healed.endLine;
                changed = true;
                coercedKeys.push('EndLine:DriftHealed');
              }
            }
          }
        }
      } catch {
        // Safe fallback
      }
    }

    if (isDirectArgsReturn) {
      return coerced;
    }
    return { coerced, changed, coercedKeys };
  }

  /**
   * Tự động căn chỉnh và tìm vị trí tương đồng của TargetContent trong file
   * (khắc phục sai khác về thụt đầu dòng, \r\n vs \n, khoảng trắng thừa cuối dòng)
   */
  fuzzyAlignTargetContent(
    fileContent: string,
    targetText: string,
  ): { exactMatch: string; startLine: number; endLine: number } | undefined {
    const normalizeLine = (l: string) => l.trim().replace(/\s+/g, ' ');
    const targetLines = targetText.split(/\r?\n/).map(normalizeLine).filter((l) => l.length > 0);
    if (targetLines.length === 0) return undefined;

    const fileLines = fileContent.split(/\r?\n/);
    let matchStart = -1;
    let matchEnd = -1;
    let matchCount = 0;

    for (let i = 0; i <= fileLines.length - targetLines.length; i++) {
      let isMatch = true;
      let targetIdx = 0;
      let j = i;

      while (targetIdx < targetLines.length && j < fileLines.length) {
        const fileNorm = normalizeLine(fileLines[j]);
        if (!fileNorm) {
          j++;
          continue;
        }
        if (fileNorm !== targetLines[targetIdx]) {
          isMatch = false;
          break;
        }
        targetIdx++;
        j++;
      }

      if (isMatch && targetIdx === targetLines.length) {
        matchCount++;
        matchStart = i;
        matchEnd = j; // exclusive
      }
    }

    // Chỉ tự động dàn xếp nếu tìm thấy ĐÚNG 1 vị trí tương đồng duy nhất (đảm bảo tính đơn định)
    if (matchCount === 1 && matchStart >= 0 && matchEnd > matchStart) {
      const exactMatch = fileLines.slice(matchStart, matchEnd).join('\n');
      return {
        exactMatch,
        startLine: matchStart + 1,
        endLine: matchEnd,
      };
    }

    return undefined;
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
