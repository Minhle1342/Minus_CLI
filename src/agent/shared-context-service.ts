import crypto from 'crypto';

export interface SharedContextEntry<T = unknown> {
  key: string;
  value: T;
  versionHash: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Shared context service enabling multi-agent state sharing
 * with Optimistic Concurrency Control (OCC) via content hashes.
 */
export class SharedContextService {
  private store = new Map<string, SharedContextEntry>();

  get<T>(key: string): SharedContextEntry<T> | undefined {
    const entry = this.store.get(key);
    return entry ? { ...(entry as SharedContextEntry<T>) } : undefined;
  }

  set<T>(key: string, value: T, agentId: string, expectedVersionHash?: string): SharedContextEntry<T> {
    const existing = this.store.get(key);

    if (expectedVersionHash !== undefined) {
      if (!existing) {
        throw new Error(`Optimistic locking failed: Key '${key}' does not exist.`);
      }
      if (existing.versionHash !== expectedVersionHash) {
        throw new Error(
          `Optimistic concurrency conflict on key '${key}': Expected version '${expectedVersionHash}', found '${existing.versionHash}'.`,
        );
      }
    } else if (existing && expectedVersionHash === undefined) {
      // If updating without version check when it exists, we allow it or can enforce strict OCC.
      // For safety in multi-agent, let's make expectedVersionHash optional for first write, but recommended.
    }

    const serialized = JSON.stringify(value);
    const versionHash = crypto.createHash('sha256').update(serialized).digest('hex');
    const updatedAt = new Date().toISOString();

    const entry: SharedContextEntry<T> = {
      key,
      value,
      versionHash,
      updatedAt,
      updatedBy: agentId,
    };

    this.store.set(key, entry);
    return { ...entry };
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  listKeys(): string[] {
    return Array.from(this.store.keys());
  }
}
