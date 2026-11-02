import { Session } from '../session/session.js';

/** Events the AgentLoop acts on: a rejection stops the turn or the current step. */
export type AgentVetoEvent = 'agent/turn-start' | 'agent/pre-step' | 'agent/request';

/**
 * Events the AgentLoop only announces: every registered handler is notified and
 * a returned decision is ignored, so a veto here cannot mute other observers.
 */
export type AgentObserveEvent = 'agent/after-step' | 'agent/turn-stopping';

export type AgentHookEvent = AgentVetoEvent | AgentObserveEvent;

export interface AgentHookContext {
  session: Session;
  turn: number;
  step?: number;
  maxSteps: number;
  isGoalMode: boolean;
  reason?: string;
  metadata: Record<string, unknown>;
}

export type AgentHookResult = void | boolean | { allow?: boolean; reason?: string };
export type AgentHookHandler = (context: AgentHookContext) => AgentHookResult | Promise<AgentHookResult>;

/** Handler map keyed by the event union above — one source of truth for the event surface. */
export type AgentHookHandlers = Partial<Record<AgentHookEvent, AgentHookHandler>>;

interface RegisteredHook {
  id: string;
  priority: number;
  order: number;
  handlers: AgentHookHandlers;
}

/**
 * Ordered live extension point for the AgentLoop.
 *
 * Hooks are process-local by design. Anything a hook makes model-visible must
 * be appended to Session by the hook and is persisted by the loop before the
 * next model request.
 *
 * Scope: the kernel registry is shared with the loop that owns the kernel, so
 * hooks cover the main agent. Subagent loops are built without a kernel and get
 * their own empty registry — delegated steps never reach plugins registered here.
 */
export class AgentHookRegistry {
  private hooks: RegisteredHook[] = [];
  private nextOrder = 0;

  register(id: string, handlers: AgentHookHandlers, priority = 0): () => void {
    if (!id.trim()) throw new Error('Agent hook id must not be empty.');
    if (this.hooks.some((hook) => hook.id === id)) {
      throw new Error(`Agent hook "${id}" is already registered.`);
    }

    this.hooks.push({ id, priority, order: this.nextOrder++, handlers });
    this.hooks.sort((a, b) => a.priority - b.priority || a.order - b.order);
    return () => this.unregister(id);
  }

  unregister(id: string): boolean {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((hook) => hook.id !== id);
    return this.hooks.length !== before;
  }

  list(): string[] {
    return this.hooks.map((hook) => hook.id);
  }

  /**
   * Runs a veto event and returns the first rejection. A handler that throws is
   * isolated — later hooks still run — but it is not read as approval: a hook
   * that could not answer has not approved the step, so the event fails closed
   * with the hook id in the reason instead of crashing the turn.
   */
  async run(event: AgentVetoEvent, context: AgentHookContext): Promise<{ allow: boolean; reason?: string }> {
    let failure: string | undefined;
    for (const hook of [...this.hooks]) {
      const handler = hook.handlers[event];
      if (!handler) continue;

      let decision: { allow: boolean; reason?: string };
      try {
        decision = normalizeDecision(await handler(context));
      } catch (error) {
        const failureMessage = this.reportHandlerFailure(hook.id, event, error);
        if (!failure) failure = failureMessage;
        continue;
      }
      if (!decision.allow) {
        return { allow: false, reason: decision.reason || `Rejected by agent hook "${hook.id}".` };
      }
    }

    return failure ? { allow: false, reason: failure } : { allow: true };
  }

  /** Runs an observation event: every handler is notified, decisions are ignored. */
  async notify(event: AgentObserveEvent, context: AgentHookContext): Promise<void> {
    for (const hook of [...this.hooks]) {
      const handler = hook.handlers[event];
      if (!handler) continue;

      try {
        await handler(context);
      } catch (error) {
        this.reportHandlerFailure(hook.id, event, error);
      }
    }
  }

  private reportHandlerFailure(id: string, event: AgentHookEvent, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Agent hook "${id}" failed on ${event}: ${detail}`;
    console.warn(message);
    return message;
  }
}

function normalizeDecision(result: AgentHookResult): { allow: boolean; reason?: string } {
  if (result === false) return { allow: false };
  if (typeof result === 'object' && result !== null) {
    return { allow: result.allow !== false, reason: result.reason };
  }
  return { allow: true };
}
