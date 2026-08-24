import { GoalPhase, GoalState, Session } from '../session/session.js';
import type { PlanManager } from './plan-manager.js';

/**
 * Durable goal lifecycle and continuation authority.
 *
 * The goal snapshot is persisted in the session event log. `armed` is
 * deliberately process-local: loading an active goal never starts work by
 * itself after a restart. A user must explicitly resume it.
 */
export class GoalManager {
  private session?: Session;
  private state?: GoalState;
  private armed = false;

  bindSession(session: Session): void {
    this.session = session;
    this.rehydrateFromSession();
  }

  rehydrateFromSession(): void {
    if (!this.session) return;
    const latest = this.session
      .getEvents()
      .filter((event) => event.type === 'goal/change' && event.data.goal !== undefined)
      .at(-1);
    if (latest?.data.goal) {
      this.state = cloneGoal(latest.data.goal);
    }
  }

  getState(): GoalState | undefined {
    if (this.session) {
      this.rehydrateFromSession();
    }
    return this.state ? cloneGoal(this.state) : undefined;
  }

  isArmed(): boolean {
    return this.armed;
  }

  create(objective: string, maxRounds = 32): GoalState {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Goal objective must not be empty.');
    if (!this.session) throw new Error('GoalManager must be bound to a session.');
    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error('Goal maxRounds must be a positive integer.');
    }

    const now = new Date().toISOString();
    this.state = {
      id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      objective: cleanObjective,
      phase: 'active',
      roundsStarted: 0,
      maxRounds,
      createdAt: now,
      updatedAt: now,
    };
    this.armed = true;
    this.persist('created');
    return this.getState()!;
  }

  beginRound(): GoalState | undefined {
    if (!this.state || !this.armed) return undefined;
    if (this.state.phase !== 'active') {
      this.armed = false;
      return undefined;
    }
    if (this.state.roundsStarted >= this.state.maxRounds) {
      this.state = this.mutate({ phase: 'blocked', blocker: 'Goal round budget exhausted.' });
      this.armed = false;
      this.persist('round-budget-exhausted');
      return undefined;
    }

    this.state = this.mutate({ roundsStarted: this.state.roundsStarted + 1 });
    this.persist('round-started');
    return this.getState();
  }

  pause(blocker?: string): GoalState | undefined {
    return this.transition('paused', blocker, false);
  }

  resume(): GoalState | undefined {
    if (!this.state || this.state.phase === 'complete') return undefined;
    this.state = this.mutate({ phase: 'active', blocker: undefined });
    this.armed = true;
    this.persist('resumed');
    return this.getState();
  }

  block(reason: string): GoalState | undefined {
    return this.transition('blocked', reason.trim() || 'Blocked by operator.', false);
  }

  /**
   * Kiểm tra điều kiện hoàn thành mục tiêu (bắt buộc toàn bộ Plan phải COMPLETED nếu có plan)
   */
  canComplete(planManager?: PlanManager): { allowed: boolean; reason?: string } {
    if (!this.state) {
      return { allowed: false, reason: 'No active goal exists to complete.' };
    }
    if (planManager && planManager.hasPlan() && !planManager.isAllTasksCompleted()) {
      const blocker = planManager.getCompletionBlocker();
      return {
        allowed: false,
        reason: `Cannot complete goal: ${blocker || 'the associated execution plan has unfinished tasks.'}`,
      };
    }
    return { allowed: true };
  }

  complete(planManager?: PlanManager): GoalState | undefined {
    if (planManager) {
      const check = this.canComplete(planManager);
      if (!check.allowed) {
        throw new Error(check.reason);
      }
    }
    return this.transition('complete', undefined, false);
  }

  clear(): void {
    this.state = undefined;
    this.armed = false;
    if (this.session) {
      this.session.append('goal/change', { reason: 'cleared', goal: null });
    }
  }

  /** Explicitly allow one continuation attempt for an already active goal. */
  arm(): boolean {
    if (!this.state || this.state.phase !== 'active') return false;
    this.armed = true;
    return true;
  }

  disarm(): void {
    this.armed = false;
  }

  private transition(phase: GoalPhase, blocker: string | undefined, armed: boolean): GoalState | undefined {
    if (!this.state) return undefined;
    this.state = this.mutate({ phase, blocker });
    this.armed = armed;
    this.persist(`phase-${phase}`);
    return this.getState();
  }

  private mutate(changes: Partial<GoalState>): GoalState {
    return {
      ...this.state!,
      ...changes,
      revision: this.state!.revision + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  private persist(reason: string): void {
    if (!this.session || !this.state) return;
    this.session.append('goal/change', {
      reason,
      goal: this.state,
    });
  }
}

function cloneGoal(goal: GoalState): GoalState {
  return { ...goal };
}
