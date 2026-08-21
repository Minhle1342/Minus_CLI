import { Session } from './session.js';
import { SessionPersistence } from './session-persistence.js';

/**
 * Session capability exposed to the Kernel.
 *
 * It owns session discovery, loading, branching and persistence while the
 * Session object itself remains a small event-sourced aggregate. Keeping this
 * boundary separate lets plugins and agents use sessions without reaching
 * into CLI-specific active-session state.
 */
export class SessionManager {
  private persistence: SessionPersistence;
  private sessions = new Map<string, Session>();

  constructor(workspaceDir: string) {
    this.persistence = new SessionPersistence(workspaceDir);
  }

  register(session: Session): Session {
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async load(id: string): Promise<Session | undefined> {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const loaded = await this.persistence.load(id);
    if (loaded) this.register(loaded);
    return loaded;
  }

  async create(id?: string): Promise<Session> {
    if (id && (this.sessions.has(id) || await this.persistence.load(id))) {
      throw new Error(`Session "${id}" đã tồn tại.`);
    }
    const session = this.register(new Session(id));
    await this.save(session);
    return session;
  }

  async save(session: Session): Promise<void> {
    this.register(session);
    await this.persistence.save(session);
  }

  async fork(parent: Session | string, boundarySeq?: number, childId?: string): Promise<Session> {
    const parentSession = typeof parent === 'string' ? await this.load(parent) : parent;
    if (!parentSession) throw new Error(`Session "${parent}" không tồn tại.`);
    const child = this.register(parentSession.fork(boundarySeq, childId));
    await this.save(child);
    return child;
  }

  async list(): Promise<string[]> {
    return this.persistence.list();
  }

  getPath(id: string): string {
    return this.persistence.getSessionPath(id);
  }

  setWorkspace(workspaceDir: string): void {
    this.persistence = new SessionPersistence(workspaceDir);
    this.sessions.clear();
  }
}
