export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGS'
  | 'SECURITY_VIOLATION'
  | 'PERMISSION_DENIED'
  | 'EXECUTION_ERROR'
  | 'FILE_ALREADY_EXISTS'
  | 'FILE_NOT_FOUND'
  | 'STALE_FILE_HASH'
  | 'AMBIGUOUS_REPLACEMENT'
  | 'PATCH_APPLY_FAILED'
  | 'PATCH_ERROR'
  | 'INVALID_PATCH'
  | 'UNAUTHORIZED_DESTRUCTION'
  | 'FUZZY_CANDIDATE_FOUND'
  | 'VERIFICATION_FAILED'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_NOT_FOUND'
  | 'INVALID_TOOL_RESULT'
  | 'TRANSACTION_ABORTED'
  | 'LAZY_CODE_PLACEHOLDER_DETECTED'
  | 'LARGE_FILE_OVERWRITE_PROTECTION'
  | 'SANDBOX_VIOLATION'
  | 'SUBSTRATE_EXECUTION_ERROR'
  | 'TEST_HARNESS_FAILURE';

export interface ToolSuccessResult<T = Record<string, any>> {
  success: true;
  data?: T;
  [key: string]: any;
}

export interface ToolErrorResult {
  success: false;
  error: string;
  errorCode: ToolErrorCode;
  details?: Record<string, any>;
  suggestion?: string;
  [key: string]: any;
}

export type StandardToolResult<T = Record<string, any>> = ToolSuccessResult<T> | ToolErrorResult;

export function toolSuccess<T extends Record<string, any>>(payload: T): T & { success: true } {
  return {
    success: true,
    ...payload,
  };
}

export function toolError(
  message: string,
  errorCode: ToolErrorCode,
  details?: Record<string, any>,
  suggestion?: string,
): ToolErrorResult {
  const res: ToolErrorResult = {
    success: false,
    error: message,
    errorCode,
  };
  if (details) res.details = details;
  if (suggestion) res.suggestion = suggestion;
  return res;
}
