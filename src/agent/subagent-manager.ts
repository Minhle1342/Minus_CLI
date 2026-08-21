import type { AgentLoop } from './agent-loop.js';
import { AgentRegistry } from './agent-registry.js';
import { Session } from '../session/session.js';
import type { DelegationState } from '../session/session.js';

export type SubagentStatus = DelegationState['status'];
export type SubagentHandle = DelegationState;

export interface SubagentOptions {
  maxSteps?: number;
  toolNames?: string[];
}

export type SubagentFactory = (
  agentId: string,
  session: Session,
  options: SubagentOptions,
  signal: AbortSignal,
) => AgentLoop;

/**
 * Provider seam for delegated/background agents.
 * The parent receives a handle immediately and the handle is also written to
 * the parent session event log, so completion survives process boundaries.
 */
export class SubagentManager {
  private handles = new Map<string, { handle: SubagentHandle; controller: AbortController }>();
  private counter = 0;
  private boundSession?: Session;
  private boundSessionId?: string;

  constructor(
    private readonly agents: AgentRegistry,
    private readonly factory: SubagentFactory,
    private readonly persistSession?: (session: Session) => Promise<void>,
  ) {}

  bindSession(session: Session): void {
    if (this.boundSessionId === session.id) {
      this.boundSession = session;
      return;
    }

    this.boundSession = session;
    this.boundSessionId = session.id;

    for (const state of session.getDelegationStates()) {
      const existing = this.handles.get(state.id);
      if (existing?.handle.status === 'running') continue;

      const controller = new AbortController();
      const recovered: SubagentHandle = { ...state };
      if (recovered.status === 'running') {
        recovered.status = 'stopped';
        recovered.error = 'Owner process restarted before subagent completed.';
        recovered.finishedAt = new Date().toISOString();
        this.recordState(recovered);
      }

      this.handles.set(state.id, { handle: recovered, controller });
      this.agents.register(state.id, `Subagent: ${state.objective.slice(0, 60)}`);
      this.agents.update(state.id, {
        status: this.registryStatus(recovered.status),
        sessionId: recovered.sessionId,
      });
    }
  }

  start(objective: string, options: SubagentOptions = {}): SubagentHandle {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Subagent objective must not be empty.');
    if (!this.boundSession) throw new Error('SubagentManager must be bound to a parent session.');

    const id = `subagent-${Date.now()}-${this.counter++}`;
    const session = new Session(`session-${id}`);
    const controller = new AbortController();
    const handle: SubagentHandle = {
      id,
      sessionId: session.id,
      objective: cleanObjective,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.handles.set(id, { handle, controller });
    this.agents.register(id, `Subagent: ${cleanObjective.slice(0, 60)}`);
    this.agents.update(id, { status: 'running', sessionId: session.id });
    this.recordState(handle);

    this.launch(handle, session, options, controller);

    return { ...handle };
  }

  /** Resume a stopped/failed delegation only when an operator explicitly asks. */
  resume(id: string, options: SubagentOptions = {}): SubagentHandle | undefined {
    const entry = this.handles.get(id);
    if (!entry || !this.boundSession || (entry.handle.status !== 'stopped' && entry.handle.status !== 'failed')) {
      return undefined;
    }

    const session = new Session(`session-${id}-resume-${Date.now()}`);
    const controller = new AbortController();
    entry.controller = controller;
    entry.handle.sessionId = session.id;
    entry.handle.startedAt = new Date().toISOString();
    entry.handle.status = 'running';
    delete entry.handle.answer;
    delete entry.handle.error;
    delete entry.handle.finishedAt;
    this.agents.update(id, { status: 'running', sessionId: session.id });
    this.recordState(entry.handle);
    this.launch(entry.handle, session, options, controller);
    return { ...entry.handle };
  }

  get(id: string): SubagentHandle | undefined {
    const entry = this.handles.get(id);
    return entry ? { ...entry.handle } : undefined;
  }

  list(): SubagentHandle[] {
    return Array.from(this.handles.values()).map(({ handle }) => ({ ...handle }));
  }

  stop(id: string): boolean {
    const entry = this.handles.get(id);
    if (!entry || entry.handle.status !== 'running') return false;
    entry.controller.abort();
    entry.handle.status = 'stopped';
    entry.handle.error = 'Subagent stopped by request.';
    entry.handle.finishedAt = new Date().toISOString();
    this.agents.update(id, { status: 'stopped' });
    this.recordState(entry.handle);
    return true;
  }

  private finishFailure(handle: SubagentHandle, error: unknown): void {
    handle.status = 'failed';
    handle.error = error instanceof Error ? error.message : String(error);
    handle.finishedAt = new Date().toISOString();
    this.agents.update(handle.id, { status: 'error' });
    this.recordState(handle);
  }

  private launch(handle: SubagentHandle, session: Session, options: SubagentOptions, controller: AbortController): void {
    let loop: AgentLoop;
    try {
      loop = this.factory(handle.id, session, options, controller.signal);
    } catch (error: any) {
      this.finishFailure(handle, error);
      return;
    }

    void loop.submit(session, handle.objective, 'human', {
      maxSteps: options.maxSteps,
      signal: controller.signal,
    }).then((answer) => {
      if (controller.signal.aborted) {
        handle.status = 'stopped';
        handle.error = 'Subagent stopped by request.';
        this.agents.update(handle.id, { status: 'stopped' });
      } else {
        handle.status = 'completed';
        handle.answer = answer;
        this.agents.update(handle.id, { status: 'idle' });
      }
      handle.finishedAt = new Date().toISOString();
      this.recordState(handle);
    }).catch((error: any) => {
      if (controller.signal.aborted) {
        handle.status = 'stopped';
        handle.error = 'Subagent stopped by request.';
        this.agents.update(handle.id, { status: 'stopped' });
        handle.finishedAt = new Date().toISOString();
        this.recordState(handle);
      } else {
        this.finishFailure(handle, error);
      }
    });
  }

  private registryStatus(status: SubagentStatus): 'idle' | 'error' | 'stopped' | 'running' {
    if (status === 'completed') return 'idle';
    if (status === 'failed') return 'error';
    return status;
  }

  private recordState(handle: SubagentHandle): void {
    if (!this.boundSession) return;
    this.boundSession.append('agent/delegation', { delegation: { ...handle } });
    void this.persistSession?.(this.boundSession);
  }
}
