export interface DynamicContextCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
}

/** Single-entry, task-local memo for expensive dynamic context assembly. */
export class DynamicContextCache<T> {
  private entry?: { key: string; value: T };
  private stats: DynamicContextCacheStats = { hits: 0, misses: 0, invalidations: 0 };

  get(key: string): T | undefined {
    if (this.entry?.key === key) {
      this.stats.hits += 1;
      return this.entry.value;
    }
    this.stats.misses += 1;
    return undefined;
  }

  set(key: string, value: T): void {
    this.entry = { key, value };
  }

  invalidate(): void {
    if (this.entry) this.stats.invalidations += 1;
    this.entry = undefined;
  }

  resetStats(): void {
    this.stats = { hits: 0, misses: 0, invalidations: 0 };
  }

  getStats(): DynamicContextCacheStats {
    return { ...this.stats };
  }
}
