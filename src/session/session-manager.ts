import { Session } from './session.js';
import { SessionPersistence, type SessionPruneOptions, type SessionPruneResult } from './session-persistence.js';

/**
 * Session capability exposed to the Kernel.
 *
 * It owns session discovery, loading, branching and persistence while the
 * Session object itself remains a small event-sourced aggregate. Keeping this
 * boundary separate lets plugins and agents use sessions without reaching
 * into CLI-specific active-session state.
 *
 * Concurrency contract (parallel sessions):
 * - Identity map: at most one live Session object per id per manager epoch.
 *   Concurrent loads resolve to the SAME object, never divergent duplicates.
 * - Per-id async mutex serializes create/load/remove/prune for the same id,
 *   closing check-then-act races (double-create, double-load, delete-vs-save).
 * - Tombstones: a removed id stays dead — load/get return undefined and
 *   late saves are refused instead of resurrecting zombie files. Ids are
 *   unique-by-construction, so reuse after remove is rejected.
 * - save() itself is lock-free (persistence already serializes per-id
 *   appends); it only enforces tombstones before AND after flushing.
 */
export class SessionManager {
  private persistence: SessionPersistence;
  private sessions = new Map<string, Session>();
  private tombstoned = new Set<string>();
  private lockTails = new Map<string, Promise<void>>();
  private lockCounts = new Map<string, number>();

  constructor(workspaceDir: string) {
    this.persistence = new SessionPersistence(workspaceDir);
  }

  /** Serialize async work per session id (non-reentrant: never nest). */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lockTails.get(id) ?? Promise.resolve();
    this.lockCounts.set(id, (this.lockCounts.get(id) ?? 0) + 1);
    let done!: () => void;
    const mine = new Promise<void>((resolve) => { done = resolve; });
    this.lockTails.set(id, prev.then(() => mine, () => mine));
    try {
      await prev;
      return await fn();
    } finally {
      done();
      const left = (this.lockCounts.get(id) ?? 1) - 1;
      if (left <= 0) {
        this.lockCounts.delete(id);
        this.lockTails.delete(id);
      } else {
        this.lockCounts.set(id, left);
      }
    }
  }

  /**
   * Public per-session mutex for special flows that must not interleave with
   * other work on the same session (companion to the lock-free register()).
   * FIFO per id, non-reentrant: never nest calls for the same id.
   */
  async withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock(id, fn);
  }

  register(session: Session): Session {
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    if (this.tombstoned.has(id)) return undefined;
    return this.sessions.get(id);
  }

  async load(id: string): Promise<Session | undefined> {
    const fast = this.sessions.get(id);
    if (fast) return fast;
    if (this.tombstoned.has(id)) return undefined;
    return this.withLock(id, async () => {
      const cached = this.sessions.get(id);
      if (cached) return cached;
      if (this.tombstoned.has(id)) return undefined;
      const loaded = await this.persistence.load(id);
      if (loaded) this.register(loaded);
      return loaded;
    });
  }

  async create(id?: string): Promise<Session> {
    return this.storeNew(new Session(id));
  }

  /** Existence + tombstone check and first persist, atomically per id. */
  private async storeNew(session: Session): Promise<Session> {
    return this.withLock(session.id, async () => {
      if (this.tombstoned.has(session.id)) {
        throw new Error(`Session "${session.id}" was removed and cannot be reused.`);
      }
      if (this.sessions.has(session.id) || await this.persistence.load(session.id)) {
        throw new Error(`Session "${session.id}" already exists.`);
      }
      this.register(session);
      await this.save(session);
      return session;
    });
  }

  async save(session: Session): Promise<void> {
    if (this.tombstoned.has(session.id)) {
      throw new Error(`Cannot save removed session "${session.id}".`);
    }
    this.register(session);
    await this.persistence.save(session);
    if (this.tombstoned.has(session.id)) {
      // Removed (or pruned) mid-save: delete the just-resurrected file.
      this.sessions.delete(session.id);
      await this.persistence.remove(session.id).catch(() => false);
      throw new Error(`Session "${session.id}" was removed during save; recreated file deleted.`);
    }
  }

  async fork(parent: Session | string, boundarySeq?: number, childId?: string): Promise<Session> {
    const parentSession = typeof parent === 'string' ? await this.load(parent) : parent;
    if (!parentSession) throw new Error(`Session "${parent}" does not exist.`);
    const child = parentSession.fork(boundarySeq, childId);
    if (child.id === parentSession.id) {
      throw new Error(`Fork child id must differ from parent session "${parentSession.id}".`);
    }
    return this.storeNew(child);
  }

  async list(): Promise<string[]> {
    return this.persistence.list();
  }

  /** Xóa vĩnh viễn session (cache + file + tombstone chống hồi sinh). Idempotent. */
  async remove(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      this.sessions.delete(id);
      this.tombstoned.add(id);
      return this.persistence.remove(id);
    });
  }

  getPath(id: string): string {
    return this.persistence.getSessionPath(id);
  }

  setWorkspace(workspaceDir: string): void {
    // Đồng bộ nên nguyên tử với mọi op khác; in-flight ops hoàn tất trên
    // persistence object cũ đã capture, epoch mới bắt đầu sạch.
    this.persistence = new SessionPersistence(workspaceDir);
    this.sessions.clear();
    this.tombstoned.clear();
    this.lockTails.clear();
    this.lockCounts.clear();
  }

  /**
   * Tự động dọn dẹp các session cũ quá 2 tuần trong workspace
   */
  async pruneExpiredSessions(options?: SessionPruneOptions): Promise<SessionPruneResult> {
    const result = await this.persistence.pruneExpiredSessions(options);
    for (const id of result.deletedSessionIds) {
      await this.withLock(id, async () => {
        this.sessions.delete(id);
        this.tombstoned.add(id);
        try { options?.onEvict?.(id); } catch { /* evict best-effort, không chặn prune */ }
      });
    }
    return result;
  }
}
