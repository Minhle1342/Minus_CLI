import { Session } from '../session/session.js';
import type { EffectOutcome, EffectState } from '../session/session.js';

/**
 * Durable lifecycle for tools that can change the workspace or external
 * state. The ledger intentionally records intent before execution so crash
 * recovery never mistakes an unobserved effect for a successful one.
 */
export class EffectLedger {
  private session?: Session;
  private counter = 0;

  bindSession(session: Session): void {
    this.session = session;
  }

  prepare(toolName: string, toolCallId: string, reversible = true): EffectState {
    if (!this.session) throw new Error('EffectLedger must be bound to a session.');
    const effect: EffectState = {
      id: `effect-${Date.now()}-${this.counter++}`,
      toolName,
      toolCallId,
      status: 'prepared',
      reversible,
      preparedAt: new Date().toISOString(),
    };
    this.session.append('effect/change', { effect, reason: 'prepared' });
    return { ...effect };
  }

  attachCheckpoint(effectId: string, checkpointId?: string): EffectState | undefined {
    return this.transition(effectId, {
      checkpointId,
      reversible: Boolean(checkpointId),
      reason: checkpointId ? 'checkpoint-attached' : 'no-reversible-checkpoint',
    });
  }

  commit(effectId: string, outcome: EffectOutcome = 'success', reason = 'tool-result-recorded'): EffectState | undefined {
    return this.transition(effectId, {
      status: 'committed',
      outcome,
      completedAt: new Date().toISOString(),
      reason,
    });
  }

  fail(effectId: string, reason: string, outcome: EffectOutcome = 'unknown'): EffectState | undefined {
    return this.transition(effectId, {
      status: 'failed',
      outcome,
      completedAt: new Date().toISOString(),
      reason,
    });
  }

  rollback(effectId: string, reason = 'operator-rollback'): EffectState | undefined {
    const current = this.get(effectId);
    if (!current || !current.reversible || current.status !== 'committed') return undefined;
    return this.transition(effectId, {
      status: 'rolledback',
      completedAt: new Date().toISOString(),
      reason,
    });
  }

  rollbackByCheckpoint(checkpointId: string, reason = 'operator-rollback'): EffectState | undefined {
    const effect = this.session?.getEffectStates().find(
      (candidate) => candidate.checkpointId === checkpointId && candidate.status === 'committed',
    );
    return effect ? this.rollback(effect.id, reason) : undefined;
  }

  get(effectId: string): EffectState | undefined {
    return this.session?.getEffectStates().find((effect) => effect.id === effectId);
  }

  list(): EffectState[] {
    return this.session?.getEffectStates() || [];
  }

  private transition(effectId: string, changes: Partial<EffectState> & { reason: string }): EffectState | undefined {
    if (!this.session) throw new Error('EffectLedger must be bound to a session.');
    const current = this.get(effectId);
    if (!current) return undefined;
    const { reason, ...stateChanges } = changes;
    const next: EffectState = { ...current, ...stateChanges };
    this.session.append('effect/change', { effect: next, reason });
    return { ...next };
  }
}
