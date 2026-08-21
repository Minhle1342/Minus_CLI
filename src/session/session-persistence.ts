import fs from 'node:fs/promises';
import path from 'node:path';
import { Session, SessionEvent, SessionSnapshot } from './session.js';

interface SessionFileHeader {
  kind: 'session';
  version: 1;
  id: string;
  createdAt: string;
}

/**
 * Append-only JSONL persistence for sessions.
 *
 * The persistence layer deliberately knows nothing about LLM providers. It
 * stores the session event stream and can append only the events not already
 * flushed to disk.
 */
export class SessionPersistence {
  readonly sessionsDir: string;
  private saveQueues = new Map<string, Promise<void>>();

  constructor(workspaceDir: string) {
    this.sessionsDir = path.join(path.resolve(workspaceDir), '.codingagent', 'sessions');
  }

  getSessionPath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.jsonl`);
  }

  async save(session: Session): Promise<void> {
    const previous = this.saveQueues.get(session.id) || Promise.resolve();
    const current = previous.then(
      () => this.saveInternal(session),
      () => this.saveInternal(session),
    );
    this.saveQueues.set(session.id, current);
    try {
      await current;
    } finally {
      if (this.saveQueues.get(session.id) === current) {
        this.saveQueues.delete(session.id);
      }
    }
  }

  private async saveInternal(session: Session): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = this.getSessionPath(session.id);
    const existing = await this.readFile(filePath);

    if (existing && existing.header.id !== session.id) {
      throw new Error(`Session file identity mismatch for ${session.id}.`);
    }

    const persistedSeq = existing?.events.at(-1)?.seq || 0;
    if (persistedSeq > session.seq) {
      throw new Error(`Persisted session is ahead of in-memory session: ${persistedSeq} > ${session.seq}.`);
    }

    const lines: string[] = [];
    if (!existing) {
      const header: SessionFileHeader = {
        kind: 'session',
        version: 1,
        id: session.id,
        createdAt: session.createdAt,
      };
      lines.push(JSON.stringify(header));
    }

    for (const event of session.getEvents().filter((candidate) => candidate.seq > persistedSeq)) {
      lines.push(JSON.stringify(event));
    }

    if (lines.length > 0) {
      await fs.appendFile(filePath, `${lines.join('\n')}\n`, 'utf8');
    }
  }

  async load(sessionId: string): Promise<Session | undefined> {
    const parsed = await this.readFile(this.getSessionPath(sessionId));
    if (!parsed) return undefined;

    const snapshot: SessionSnapshot = {
      version: 1,
      id: parsed.header.id,
      createdAt: parsed.header.createdAt,
      events: parsed.events,
    };
    const session = Session.fromSnapshot(snapshot);
    if (session.recoverInterrupted()) {
      await this.save(session);
    }
    return session;
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name.slice(0, -'.jsonl'.length))
        .sort();
    } catch {
      return [];
    }
  }

  async remove(sessionId: string): Promise<boolean> {
    try {
      await fs.unlink(this.getSessionPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  private async readFile(filePath: string): Promise<{ header: SessionFileHeader; events: SessionEvent[] } | undefined> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return undefined;

      const header = JSON.parse(lines[0]) as SessionFileHeader;
      if (header.kind !== 'session' || header.version !== 1 || !header.id || !header.createdAt) {
        throw new Error(`Malformed session header in ${filePath}.`);
      }

      const events = lines.slice(1).map((line) => JSON.parse(line) as SessionEvent);
      for (let index = 0; index < events.length; index++) {
        if (events[index].seq !== index + 1) {
          throw new Error(`Non-contiguous session event sequence in ${filePath}.`);
        }
      }

      return { header, events };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
