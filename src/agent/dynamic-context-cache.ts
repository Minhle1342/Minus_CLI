export interface DynamicContextCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  ttlExpirations?: number;
}

export interface DynamicContextCacheOptions {
  ttlMs?: number;
}

/** Single-entry, task-local memo for expensive dynamic context assembly with TTL-based freshness guardrails. */
export class DynamicContextCache<T> {
  private entry?: { key: string; value: T; timestamp: number };
  private stats: DynamicContextCacheStats = { hits: 0, misses: 0, invalidations: 0, ttlExpirations: 0 };
  readonly ttlMs: number;

  constructor(options?: DynamicContextCacheOptions) {
    this.ttlMs = options?.ttlMs ?? 60_000;
  }

  get(key: string): T | undefined {
    if (this.entry?.key === key) {
      if (Date.now() - this.entry.timestamp <= this.ttlMs) {
        this.stats.hits += 1;
        return this.entry.value;
      }
      // Expired by TTL
      this.stats.invalidations += 1;
      this.stats.ttlExpirations = (this.stats.ttlExpirations || 0) + 1;
      this.entry = undefined;
    }
    this.stats.misses += 1;
    return undefined;
  }

  set(key: string, value: T): void {
    this.entry = { key, value, timestamp: Date.now() };
  }

  invalidate(): void {
    if (this.entry) this.stats.invalidations += 1;
    this.entry = undefined;
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, invalidations: 0, ttlExpirations: 0 };
  }

  getStats(): DynamicContextCacheStats {
    const res: DynamicContextCacheStats = {
      hits: this.stats.hits,
      misses: this.stats.misses,
      invalidations: this.stats.invalidations,
    };
    if (this.stats.ttlExpirations) {
      res.ttlExpirations = this.stats.ttlExpirations;
    }
    return res;
  }
}

