/**
 * Satellite 3: Token Pacer & Leaky-Bucket Rate Limiter
 * 
 * Regulates token throughput over a 60-second sliding window to eliminate 429
 * Rate Limit / TPM (Tokens Per Minute) errors from aggressive bursts.
 */

export interface TokenRequestRecord {
  timestamp: number;
  tokens: number;
}

export interface RateLimitPacerOptions {
  windowMs?: number;
  safetyThresholdRatio?: number;
  defaultTpmLimit?: number;
  providerTpmLimits?: Record<string, number>;
  maxDelayMs?: number;
  minDelayMs?: number;
}

export interface PaceEvent {
  provider: string;
  model: string;
  estimatedTokens: number;
  tokensUsedInWindow: number;
  projectedTokens: number;
  tpmLimit: number;
  delayMs: number;
}

export class RateLimitPacer {
  private readonly windowMs: number;
  private readonly safetyThresholdRatio: number;
  private readonly defaultTpmLimit: number;
  private readonly providerTpmLimits: Record<string, number>;
  private readonly maxDelayMs: number;
  private readonly minDelayMs: number;

  private readonly requestHistory: TokenRequestRecord[] = [];

  constructor(options?: RateLimitPacerOptions) {
    this.windowMs = options?.windowMs ?? 60_000;
    this.safetyThresholdRatio = options?.safetyThresholdRatio ?? 0.85;
    this.defaultTpmLimit = options?.defaultTpmLimit ?? 80_000;
    this.maxDelayMs = options?.maxDelayMs ?? 10_000;
    this.minDelayMs = options?.minDelayMs ?? 500;

    this.providerTpmLimits = {
      anthropic: 80_000,
      gemini: 250_000,
      google: 250_000,
      openai: 100_000,
      groq: 30_000,
      deepseek: 60_000,
      ollama: 10_000_000,
      ...options?.providerTpmLimits,
    };
  }

  getTpmLimit(provider = 'default'): number {
    const envOverride = process.env.MINUS_TPM_LIMIT ? parseInt(process.env.MINUS_TPM_LIMIT, 10) : undefined;
    if (envOverride && Number.isFinite(envOverride) && envOverride > 0) {
      return envOverride;
    }
    const normalized = provider.toLowerCase();
    for (const [k, limit] of Object.entries(this.providerTpmLimits)) {
      if (normalized.includes(k)) return limit;
    }
    return this.defaultTpmLimit;
  }

  getTokensUsedInWindow(now = Date.now()): number {
    this.pruneOldRecords(now);
    return this.requestHistory.reduce((sum, r) => sum + r.tokens, 0);
  }

  private pruneOldRecords(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.requestHistory.length > 0 && this.requestHistory[0].timestamp < cutoff) {
      this.requestHistory.shift();
    }
  }

  recordActualUsage(tokens: number, timestamp = Date.now()): void {
    if (typeof tokens !== 'number' || tokens <= 0) return;
    this.requestHistory.push({ timestamp, tokens });
    this.pruneOldRecords(timestamp);
  }

  calculateRequiredDelay(
    estimatedTokens: number,
    provider = 'default',
    now = Date.now(),
  ): number {
    this.pruneOldRecords(now);
    const tpmLimit = this.getTpmLimit(provider);
    const thresholdTokens = Math.floor(tpmLimit * this.safetyThresholdRatio);
    const currentTokens = this.getTokensUsedInWindow(now);
    const projectedTokens = currentTokens + estimatedTokens;

    if (projectedTokens <= thresholdTokens) {
      return 0;
    }

    const excessTokens = projectedTokens - thresholdTokens;
    let accumulated = 0;
    let targetOldestTimestamp: number | undefined;

    for (const rec of this.requestHistory) {
      accumulated += rec.tokens;
      if (accumulated >= excessTokens) {
        targetOldestTimestamp = rec.timestamp;
        break;
      }
    }

    if (!targetOldestTimestamp && this.requestHistory.length > 0) {
      targetOldestTimestamp = this.requestHistory[0].timestamp;
    }

    if (targetOldestTimestamp !== undefined) {
      const expiry = targetOldestTimestamp + this.windowMs;
      const rawDelay = expiry - now;
      if (rawDelay > 0) {
        return Math.min(this.maxDelayMs, Math.max(this.minDelayMs, rawDelay));
      }
    }

    return Math.min(this.maxDelayMs, 2_000);
  }

  async throttleBeforeRequest(
    provider: string,
    model: string,
    estimatedTokens: number,
    signal?: AbortSignal,
    onPace?: (event: PaceEvent) => void,
  ): Promise<number> {
    const delayMs = this.calculateRequiredDelay(estimatedTokens, provider);
    if (delayMs <= 0) {
      return 0;
    }

    const tpmLimit = this.getTpmLimit(provider);
    const currentTokens = this.getTokensUsedInWindow();
    const event: PaceEvent = {
      provider,
      model,
      estimatedTokens,
      tokensUsedInWindow: currentTokens,
      projectedTokens: currentTokens + estimatedTokens,
      tpmLimit,
      delayMs,
    };

    onPace?.(event);

    if (signal?.aborted) {
      return 0;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

    return delayMs;
  }
}
