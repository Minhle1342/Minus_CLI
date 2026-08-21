import { Session } from '../session/session.js';

export type AgentHookEvent =
  | 'agent/turn-start'
  | 'agent/pre-step'
  | 'agent/request'
  | 'agent/after-step'
  | 'agent/turn-stopping';

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

export interface AgentHookHandlers {
  'agent/turn-start'?: AgentHookHandler;
  'agent/pre-step'?: AgentHookHandler;
  'agent/request'?: AgentHookHandler;
  'agent/after-step'?: AgentHookHandler;
  'agent/turn-stopping'?: AgentHookHandler;
}

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

  async run(event: AgentHookEvent, context: AgentHookContext): Promise<{ allow: boolean; reason?: string }> {
    for (const hook of [...this.hooks]) {
      const handler = hook.handlers[event];
      if (!handler) continue;

      const result = await handler(context);
      const decision = normalizeDecision(result);
      if (!decision.allow) {
        return { allow: false, reason: decision.reason || `Rejected by agent hook "${hook.id}".` };
      }
    }

    return { allow: true };
  }
}

function normalizeDecision(result: AgentHookResult): { allow: boolean; reason?: string } {
  if (result === false) return { allow: false };
  if (typeof result === 'object' && result !== null) {
    return { allow: result.allow !== false, reason: result.reason };
  }
  return { allow: true };
}
