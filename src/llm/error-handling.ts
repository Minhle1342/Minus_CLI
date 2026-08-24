export type LLMErrorKind =
  | 'TRANSIENT_RATE_LIMIT'
  | 'HARD_QUOTA_EXHAUSTED'
  | 'AUTHENTICATION_ERROR'
  | 'SERVER_ERROR'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'OTHER';

export interface ClassifiedLLMError {
  kind: LLMErrorKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}

/**
 * Phân tích và phân loại các lỗi từ LLM Provider (Google Gemini, OpenAI, DeepSeek, Anthropic, v.v.)
 */
export function classifyLLMError(error: any): ClassifiedLLMError {
  if (!error) {
    return {
      kind: 'OTHER',
      message: 'Unknown error',
      retryable: false,
    };
  }

  const rawMessage = String(error?.message || error?.statusText || error || '').toLowerCase();
  const statusCode = typeof error?.status === 'number'
    ? error.status
    : typeof error?.statusCode === 'number'
    ? error.statusCode
    : typeof error?.response?.status === 'number'
    ? error.response.status
    : undefined;

  // 1. Kiểm tra Hard Quota Exhausted (Cạn hạn mức / Hết tiền / Vượt giới hạn ngày)
  const isHardQuota =
    rawMessage.includes('quota exceeded')
    || rawMessage.includes('insufficient_quota')
    || rawMessage.includes('credit_balance_too_low')
    || rawMessage.includes('daily_limit_reached')
    || rawMessage.includes('exceeded your current quota')
    || rawMessage.includes('check your plan and billing details')
    || (rawMessage.includes('resource_exhausted') && (rawMessage.includes('quota') || rawMessage.includes('limit: 0')));

  if (isHardQuota) {
    return {
      kind: 'HARD_QUOTA_EXHAUSTED',
      message: error.message || 'LLM API Quota Exceeded. Please check your billing or switch models.',
      retryable: false,
      statusCode: statusCode || 429,
    };
  }

  // 2. Kiểm tra Transient Rate Limit (429 Too Many Requests / Burst Limit / Resource Exhausted tạm thời)
  const isTransientRateLimit =
    statusCode === 429
    || rawMessage.includes('rate limit')
    || rawMessage.includes('rate_limit_exceeded')
    || rawMessage.includes('too many requests')
    || rawMessage.includes('resource_exhausted')
    || rawMessage.includes('tpm limit')
    || rawMessage.includes('rpm limit');

  if (isTransientRateLimit) {
    // Trích xuất retry-after nếu có trong header hoặc message (vd: "Please retry in 5.2s")
    let retryAfterMs: number | undefined;
    const retryMatch = rawMessage.match(/retry after\s+([0-9.]+)\s*(s|sec|seconds|ms)?/i)
      || rawMessage.match(/retry in\s+([0-9.]+)\s*(s|sec|seconds|ms)?/i);
    if (retryMatch) {
      const value = parseFloat(retryMatch[1]);
      const unit = retryMatch[2]?.toLowerCase() || 's';
      retryAfterMs = unit.startsWith('ms') ? value : Math.round(value * 1000);
    }

    return {
      kind: 'TRANSIENT_RATE_LIMIT',
      message: error.message || 'LLM Rate Limit (429) encountered.',
      retryable: true,
      statusCode: statusCode || 429,
      retryAfterMs,
    };
  }

  // 3. Kiểm tra Authentication Error
  if (
    statusCode === 401
    || statusCode === 403
    || rawMessage.includes('invalid api key')
    || rawMessage.includes('api_key_invalid')
    || rawMessage.includes('unauthorized')
  ) {
    return {
      kind: 'AUTHENTICATION_ERROR',
      message: error.message || 'Invalid or unauthorized API key.',
      retryable: false,
      statusCode: statusCode || 401,
    };
  }

  // 4. Kiểm tra Server Error (500, 502, 503, 504)
  if (
    (statusCode && statusCode >= 500 && statusCode < 600)
    || rawMessage.includes('overloaded')
    || rawMessage.includes('service unavailable')
    || rawMessage.includes('bad gateway')
    || rawMessage.includes('gateway timeout')
  ) {
    return {
      kind: 'SERVER_ERROR',
      message: error.message || 'LLM Provider Server Error.',
      retryable: true,
      statusCode,
    };
  }

  // 5. Kiểm tra Context Length Exceeded
  if (
    rawMessage.includes('context length')
    || rawMessage.includes('maximum context length')
    || rawMessage.includes('token limit exceeded')
    || rawMessage.includes('prompt is too long')
  ) {
    return {
      kind: 'CONTEXT_LENGTH_EXCEEDED',
      message: error.message || 'Context length exceeded maximum token limit.',
      retryable: false,
      statusCode: 400,
    };
  }

  return {
    kind: 'OTHER',
    message: error.message || String(error),
    retryable: false,
    statusCode,
  };
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  onRetry?: (attempt: number, delayMs: number, error: ClassifiedLLMError) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Thực thi hàm bất đồng bộ với cơ chế Exponential Backoff with Full Jitter
 */
export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1500;
  const maxDelayMs = options.maxDelayMs ?? 15000;
  const jitterMs = options.jitterMs ?? 500;
  const sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const classified = classifyLLMError(err);

      // Nếu không phải lỗi có thể retry hoặc đã hết số lần thử
      if (!classified.retryable || attempt > maxRetries) {
        throw err;
      }

      // Tính toán delay: Exponential backoff + Full Jitter
      const calculatedDelay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1),
      );
      const jitter = Math.random() * jitterMs;
      const finalDelayMs = classified.retryAfterMs && classified.retryAfterMs > 0
        ? Math.min(maxDelayMs, Math.max(classified.retryAfterMs, calculatedDelay + jitter))
        : calculatedDelay + jitter;

      if (options.onRetry) {
        options.onRetry(attempt, finalDelayMs, classified);
      }

      await sleep(finalDelayMs);
    }
  }

  throw lastError;
}
