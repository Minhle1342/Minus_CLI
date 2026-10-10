/**
 * Deterministic failure dedup (Option 1+2).
 *
 * Một số lỗi tool là quyết định luận theo trạng thái harness: gọi lại y hệt
 * trong cùng turn mà trạng thái không đổi thì kết quả chắc chắn giống nhau
 * (ví dụ: Docker unavailable + lệnh non-readonly → ISOLATED_SANDBOX_REQUIRED).
 * Retry loại này chỉ đốt context, render thêm block ✖ FAIL, và không cho LLM
 * thông tin mới — nên fingerprint + chặn lặp ở 3 tầng:
 *  1. LoopProgressGuard: đếm lặp + shouldStop sau 3 lần, kèm hướng dẫn đổi chiến lược.
 *  2. ToolRunner: short-circuit, trả cached result + deduped:true, không re-execute.
 *  3. UI: collapse block trùng thay vì render full FAIL.
 *
 * Cố ý KHÔNG bao gồm lỗi môi trường/thực thi (COMMAND_NOT_FOUND, COMMAND_TIMEOUT,
 * EXECUTION_ERROR, exitCode != 0...): chúng có thể đổi khi state đổi (cài SDK,
 * sửa code) nên vẫn cho retry như cũ.
 */

/** Error codes mà retry y hệt trong cùng turn là vô ích khi state không đổi. */
export const DETERMINISTIC_BLOCK_CODES = new Set([
  'ISOLATED_SANDBOX_REQUIRED',
  'HOST_SYSTEM_RISK',
  'INTERACTIVE_COMMAND_PROHIBITED',
  'GIT_CLONE_CURRENT_DIRECTORY_FORBIDDEN',
  'TOOL_NOT_ALLOWED_THIS_TURN',
  'INVALID_TOOL_DECISION_BINDING',
  'TOOL_CALL_BUDGET_EXHAUSTED',
  'POST_SUBMISSION_TOOL_CALL_BLOCKED',
  'PHASE_TOOL_EFFECT_BLOCKED',
  'PAYLOAD_TOO_LARGE',
  'INVALID_ARGS',
  'INVALID_EXECUTION_TARGET',
  'GIT_CREDENTIAL_IN_URL',
  'UNKNOWN_TOOL',
  'SECURITY_VIOLATION',
  'HOOK_DENIED',
  'PREFLIGHT_GUARD_REJECTED',
  'EXECUTION_GUARD_REJECTED',
]);

export function isDeterministicBlock(result: Record<string, any> | undefined | null): boolean {
  if (!result || typeof result !== 'object') return false;
  const code = String((result as any).errorCode || (result as any).preflightCode || '');
  return code !== '' && DETERMINISTIC_BLOCK_CODES.has(code);
}

export function deterministicBlockCode(result: Record<string, any>): string | undefined {
  const code = String(result?.errorCode || result?.preflightCode || '');
  return code && DETERMINISTIC_BLOCK_CODES.has(code) ? code : undefined;
}

function normalizeArgValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Chuẩn hóa lệnh shell: trim + collapse whitespace + lowercase để
    // `npm  Test` và `npm test` fingerprint giống nhau.
    return value.trim().replace(/\s+/g, ' ');
  }
  if (Array.isArray(value)) return value.map(normalizeArgValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key.startsWith('_')) continue; // bỏ metadata runtime (_system_*, _guardian_*)
      out[key] = normalizeArgValue(record[key]);
    }
    return out;
  }
  return value;
}

/** Fingerprint cho call (chưa biết errorCode): toolName + args đã chuẩn hóa. */
export function deterministicCallFingerprint(
  toolName: string,
  args: Record<string, any>,
  scope?: Record<string, unknown>,
): string {
  const normalized = normalizeArgValue(args || {});
  const scopePart = scope ? `::${JSON.stringify(normalizeArgValue(scope))}` : '';
  return `${toolName}::${JSON.stringify(normalized)}${scopePart}`;
}

/** Fingerprint đầy đủ cho observation: call + errorCode. */
export function deterministicBlockFingerprint(
  toolName: string,
  args: Record<string, any>,
  errorCode: string,
): string {
  return `${deterministicCallFingerprint(toolName, args)}::${errorCode}`;
}

export function deterministicRemediation(toolName: string, errorCode: string): string {
  if (toolName === 'run_command' && errorCode === 'ISOLATED_SANDBOX_REQUIRED') {
    return 'Do not retry the same command with execution_target "auto". Either retry explicitly with execution_target "host" (host policy + approval still apply) or switch to a read-only tool (read_file/list_files/search_text).';
  }
  if (errorCode === 'TOOL_NOT_ALLOWED_THIS_TURN' || errorCode === 'PHASE_TOOL_EFFECT_BLOCKED') {
    return 'Pick an authorized tool for the current phase; do not repeat the denied call unchanged.';
  }
  if (errorCode === 'TOOL_CALL_BUDGET_EXHAUSTED') {
    return 'Conclude the current turn instead of issuing further tool calls.';
  }
  return 'Change strategy instead of repeating the identical blocked call.';
}
