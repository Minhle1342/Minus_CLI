import fs from 'node:fs/promises';
import path from 'node:path';
import { Session, SessionEvent, SessionSnapshot } from './session.js';

interface SessionFileHeader {
  kind: 'session';
  version: 1;
  id: string;
  createdAt: string;
}

interface PersistedSessionState {
  persistedSeq: number;
  fileSize: number;
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
  private persistedState = new Map<string, PersistedSessionState>();

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
    let state = this.persistedState.get(session.id);
    if (state) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size !== state.fileSize) state = undefined;
      } catch (error: any) {
        if (error?.code === 'ENOENT') state = undefined;
        else throw error;
      }
    }
    const existing = state ? undefined : await this.readFile(filePath);

    if (existing && existing.header.id !== session.id) {
      throw new Error(`Session file identity mismatch for ${session.id}.`);
    }

    const persistedSeq = state?.persistedSeq ?? existing?.events.at(-1)?.seq ?? 0;
    if (persistedSeq > session.seq) {
      throw new Error(`Persisted session is ahead of in-memory session: ${persistedSeq} > ${session.seq}.`);
    }

    const lines: string[] = [];
    if (!state && !existing) {
      const header: SessionFileHeader = {
        kind: 'session',
        version: 1,
        id: session.id,
        createdAt: session.createdAt,
      };
      lines.push(JSON.stringify(header));
    }

    for (const event of session.getEventsAfter(persistedSeq)) {
      lines.push(JSON.stringify(event));
    }

    if (lines.length > 0) {
      const payload = `${lines.join('\n')}\n`;
      await fs.appendFile(filePath, payload, 'utf8');
      this.persistedState.set(session.id, {
        persistedSeq: session.seq,
        fileSize: (state?.fileSize ?? existing?.fileSize ?? 0) + Buffer.byteLength(payload, 'utf8'),
      });
    } else if (!state && existing) {
      this.persistedState.set(session.id, {
        persistedSeq,
        fileSize: existing.fileSize,
      });
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
    this.persistedState.set(session.id, {
      persistedSeq: session.seq,
      fileSize: parsed.fileSize,
    });
    if (session.recoverInterrupted()) {
      (session as any).wasInterruptedAndRecovered = true;
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

  /**
   * Quét và tìm phiên làm việc dở dang gần nhất trong workspace (phục vụ tự động phát hiện khi mất activeSessionId)
   */
  async findLatestInterruptedSession(): Promise<{
    sessionId: string;
    updatedAt: string;
    goal?: string;
    phase?: string;
    incompleteTask?: string;
    reason?: string;
  } | undefined> {
    const sessionIds = await this.list();
    if (sessionIds.length === 0) return undefined;

    const candidates: Array<{
      sessionId: string;
      updatedAt: string;
      goal?: string;
      phase?: string;
      incompleteTask?: string;
      reason?: string;
      score: number;
    }> = [];

    for (const sessionId of sessionIds) {
      try {
        const parsed = await this.readFile(this.getSessionPath(sessionId));
        if (!parsed || parsed.events.length === 0) continue;

        const latestEvent = parsed.events.at(-1);
        const updatedAt = latestEvent?.createdAt || parsed.header.createdAt;

        // Check goal
        const goalEvent = parsed.events.filter((e) => e.type === 'goal/change' && e.data.goal).at(-1);
        let goalState = goalEvent?.data.goal;

        // Check plan
        const planEvent = parsed.events.filter((e) => e.type === 'plan/change' && Array.isArray(e.data.plan)).at(-1);
        const tasks = planEvent?.data.plan || [];
        const hasPlan = tasks.length > 0;
        const incompleteTask = tasks.find((t: any) => !['COMPLETED', 'FAILED', 'SKIPPED'].includes(t.status));
        const isAllPlanCompleted = hasPlan && !incompleteTask;

        // Check if there was an open turn or interrupted turn
        const lastTurnEnd = parsed.events.filter((e) => e.type === 'turn/end').at(-1);
        const wasTurnCompleted = lastTurnEnd?.data.reason === 'completed';
        const wasInterrupted = lastTurnEnd?.data.reason === 'interrupted' || (latestEvent?.type !== 'turn/end' && !wasTurnCompleted);

        // Auto-reconciliation: Nếu toàn bộ task trong plan đã hoàn tất hoặc turn cuối cùng đã completed bình thường không còn task dở dang
        if (goalState && (goalState.phase === 'active' || goalState.phase === 'paused')) {
          if (isAllPlanCompleted || (wasTurnCompleted && !incompleteTask)) {
            goalState = { ...goalState, phase: 'complete' };
          }
        }

        const isPausedGoal = (goalState?.phase === 'paused' || goalState?.phase === 'active') && !isAllPlanCompleted;
        const hasIncompletePlan = Boolean(incompleteTask);

        // Tuyệt đối không đánh dấu phiên gián đoạn nếu toàn bộ plan đã hoàn thành hoặc turn đã kết thúc thành công và không có task dở dang
        if ((isPausedGoal || hasIncompletePlan || wasInterrupted) && !isAllPlanCompleted && (!wasTurnCompleted || hasIncompletePlan)) {
          let score = 1;
          if (isPausedGoal) score += 10;
          if (hasIncompletePlan) score += 10;
          if (wasInterrupted) score += 5;

          candidates.push({
            sessionId,
            updatedAt,
            goal: goalState?.objective,
            phase: goalState?.phase,
            incompleteTask: incompleteTask ? `Task #${incompleteTask.id} "${incompleteTask.title}"` : undefined,
            reason: goalState?.blocker || (wasInterrupted ? 'Turn interrupted before normal completion' : undefined),
            score,
          });
        }
      } catch {}
    }

    if (candidates.length === 0) return undefined;

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const best = candidates[0];
    return {
      sessionId: best.sessionId,
      updatedAt: best.updatedAt,
      goal: best.goal,
      phase: best.phase,
      incompleteTask: best.incompleteTask,
      reason: best.reason,
    };
  }

  async remove(sessionId: string): Promise<boolean> {
    try {
      await fs.unlink(this.getSessionPath(sessionId));
      this.persistedState.delete(sessionId);
      return true;
    } catch {
      this.persistedState.delete(sessionId);
      return false;
    }
  }

  private async readFile(filePath: string): Promise<{ header: SessionFileHeader; events: SessionEvent[]; fileSize: number } | undefined> {
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

      return { header, events, fileSize: Buffer.byteLength(raw, 'utf8') };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
