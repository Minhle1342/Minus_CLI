import crypto from 'crypto';
import fs from 'fs/promises';

export interface SharedContextEntry<T = unknown> {
  key: string;
  value: T;
  versionHash: string;
  updatedAt: string;
  updatedBy: string;
  filePath?: string;
  fileHash?: string;
}

export interface SetSharedContextOptions {
  expectedVersionHash?: string;
  filePath?: string;
  expectedFileHash?: string;
  currentFileHash?: string;
}

/**
 * Shared context service enabling multi-agent state sharing
 * with Optimistic Concurrency Control (OCC) via content hashes and workspace file hashes.
 */
export class SharedContextService {
  private store = new Map<string, SharedContextEntry>();

  get<T>(key: string): SharedContextEntry<T> | undefined {
    const entry = this.store.get(key);
    return entry ? { ...(entry as SharedContextEntry<T>) } : undefined;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Ghi hoặc cập nhật dữ liệu vào Shared Context với cơ chế kiểm soát tương tranh OCC.
   * Hỗ trợ kiểm tra versionHash và/hoặc fileHash.
   */
  set<T>(
    key: string,
    value: T,
    agentId: string,
    expectedVersionOrOptions?: string | SetSharedContextOptions,
  ): SharedContextEntry<T> {
    const existing = this.store.get(key);

    const options: SetSharedContextOptions =
      typeof expectedVersionOrOptions === 'string'
        ? { expectedVersionHash: expectedVersionOrOptions }
        : expectedVersionOrOptions || {};

    const { expectedVersionHash, filePath, expectedFileHash, currentFileHash } = options;

    // 1. Kiểm tra OCC trên versionHash nội bộ
    if (expectedVersionHash !== undefined) {
      if (!existing) {
        throw new Error(`Optimistic locking failed: Key '${key}' does not exist.`);
      }
      if (existing.versionHash !== expectedVersionHash) {
        throw new Error(
          `Optimistic concurrency conflict on key '${key}': Expected version '${expectedVersionHash}', found '${existing.versionHash}'.`,
        );
      }
    }

    // 2. Kiểm tra OCC trên file hash của file ràng buộc (File-bound OCC)
    if (expectedFileHash !== undefined) {
      const activeFileHash = currentFileHash || (existing?.fileHash);
      if (activeFileHash && activeFileHash !== expectedFileHash) {
        throw new Error(
          `Optimistic concurrency conflict on file '${filePath || key}': Expected file hash '${expectedFileHash}', found '${activeFileHash}'.`,
        );
      }
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
      filePath,
      fileHash: currentFileHash || expectedFileHash || existing?.fileHash,
    };

    this.store.set(key, entry);
    return { ...entry };
  }

  /**
   * Ghi dữ liệu đồng thời xác thực file hash trực tiếp từ đĩa.
   */
  async setWithFileVerification<T>(
    key: string,
    value: T,
    agentId: string,
    filePath: string,
    expectedFileHash: string,
    workspaceRoot?: string,
  ): Promise<SharedContextEntry<T>> {
    const fullPath = workspaceRoot ? `${workspaceRoot}/${filePath}`.replace(/\\/g, '/') : filePath;
    let computedHash: string;
    try {
      const content = await fs.readFile(fullPath);
      computedHash = crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      throw new Error(`Cannot verify file hash: File '${filePath}' does not exist or cannot be read.`);
    }

    if (computedHash !== expectedFileHash) {
      throw new Error(
        `Optimistic concurrency conflict on file '${filePath}': Expected file hash '${expectedFileHash}', found '${computedHash}'.`,
      );
    }

    return this.set(key, value, agentId, {
      filePath,
      expectedFileHash,
      currentFileHash: computedHash,
    });
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  listKeys(): string[] {
    return Array.from(this.store.keys());
  }

  entries(): SharedContextEntry[] {
    return Array.from(this.store.values()).map((e) => ({ ...e }));
  }

  clear(): void {
    this.store.clear();
  }
}
