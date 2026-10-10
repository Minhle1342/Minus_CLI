import { Session } from '../session/session.js';
import type { EffectOutcome, EffectState } from '../session/session.js';

/**
 * Durable lifecycle for tools that can change the workspace or external
 * state. The ledger intentionally records intent before execution so crash
 * recovery never mistakes an unobserved effect for a successful one.
 */
export class EffectLedger {
  private sessions = new Map<string, Session>();
  private counters = new Map<string, number>();
  private activeSessionId?: string;

  bindSession(session: Session): void {
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
  }

  /** Drop per-session ledger state (session deleted/pruned). Active pointer falls back. */
  evictSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.counters.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      const next = this.sessions.keys().next();
      this.activeSessionId = next.done ? undefined : next.value;
    }
  }

  private resolve(sessionId?: string): Session {
    const session = this.peek(sessionId);
    if (!session) throw new Error('EffectLedger must be bound to a session.');
    return session;
  }

  private peek(sessionId?: string): Session | undefined {
    const id = sessionId ?? this.activeSessionId;
    return id ? this.sessions.get(id) : undefined;
  }

  private scopedId(sessionId: string): string {
    const next = this.counters.get(sessionId) || 0;
    this.counters.set(sessionId, next + 1);
    return `effect-${Date.now()}-${next}`;
  }

  prepare(toolName: string, toolCallId: string, reversible = true, sessionId?: string): EffectState {
    const session = this.resolve(sessionId);
    const effect: EffectState = {
      id: this.scopedId(session.id),
      toolName,
      toolCallId,
      status: 'prepared',
      reversible,
      preparedAt: new Date().toISOString(),
    };
    session.append('effect/change', { effect, reason: 'prepared' });
    return { ...effect };
  }

  attachCheckpoint(effectId: string, checkpointId?: string, sessionId?: string): EffectState | undefined {
    return this.transition(effectId, {
      checkpointId,
      reversible: Boolean(checkpointId),
      reason: checkpointId ? 'checkpoint-attached' : 'no-reversible-checkpoint',
    }, sessionId);
  }

  commit(effectId: string, outcome: EffectOutcome = 'success', reason = 'tool-result-recorded', sessionId?: string): EffectState | undefined {
    return this.transition(effectId, {
      status: 'committed',
      outcome,
      completedAt: new Date().toISOString(),
      reason,
    }, sessionId);
  }

  fail(effectId: string, reason: string, outcome: EffectOutcome = 'unknown', sessionId?: string): EffectState | undefined {
    return this.transition(effectId, {
      status: 'failed',
      outcome,
      completedAt: new Date().toISOString(),
      reason,
    }, sessionId);
  }

  rollback(effectId: string, reason = 'operator-rollback', sessionId?: string): EffectState | undefined {
    const current = this.get(effectId, sessionId);
    if (!current || !current.reversible || current.status !== 'committed') return undefined;
    return this.transition(effectId, {
      status: 'rolledback',
      completedAt: new Date().toISOString(),
      reason,
    }, sessionId);
  }

  rollbackByCheckpoint(checkpointId: string, reason = 'operator-rollback', sessionId?: string): EffectState | undefined {
    const effect = this.peek(sessionId)?.getEffectStates().find(
      (candidate) => candidate.checkpointId === checkpointId && candidate.status === 'committed',
    );
    return effect ? this.rollback(effect.id, reason, sessionId) : undefined;
  }

  get(effectId: string, sessionId?: string): EffectState | undefined {
    return this.peek(sessionId)?.getEffectStates().find((effect) => effect.id === effectId);
  }

  list(sessionId?: string): EffectState[] {
    return this.peek(sessionId)?.getEffectStates() || [];
  }

  private transition(effectId: string, changes: Partial<EffectState> & { reason: string }, sessionId?: string): EffectState | undefined {
    const session = this.resolve(sessionId);
    const current = session.getEffectStates().find((effect) => effect.id === effectId);
    if (!current) return undefined;
    const { reason, ...stateChanges } = changes;
    const next: EffectState = { ...current, ...stateChanges };
    session.append('effect/change', { effect: next, reason });
    return { ...next };
  }
}
