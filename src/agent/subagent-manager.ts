import type { AgentLoop } from './agent-loop.js';
import { AgentRegistry } from './agent-registry.js';
import { Session } from '../session/session.js';
import type { DelegationState } from '../session/session.js';

export type SubagentStatus = DelegationState['status'];
export type SubagentHandle = DelegationState;

export interface SubagentOptions {
  maxSteps?: number;
  toolNames?: string[];
  brief?: string;
  modelName?: string;
  worktreePath?: string;
  capabilities?: string[];
  requiredCapabilities?: string[];
  priority?: 'high' | 'normal' | 'low';
  preferCostEfficient?: boolean;
  memoize?: boolean;
  maxBudgetTokens?: number;
  fileScope?: string[];
  verificationCommand?: string;
  /** Session cha sở hữu delegation (task nền ghi đúng log cha dù đã switch tab). */
  parentSessionId?: string;
}

export interface IsolatedTaskOptions {
  allowedTools?: string[];
  maxSteps?: number;
  verificationCommand?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IsolatedTaskResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  durationMs: number;
  error?: string;
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
  private handles = new Map<string, { handle: SubagentHandle; controller: AbortController; executionSession?: Session; parentSessionId?: string }>();
  private completionListeners = new Map<string, Array<(handle: SubagentHandle) => void>>();
  private counter = 0;
  private boundSession?: Session;
  private boundSessionId?: string;
  /** Registry session cha đã bind — resolve parent cho task nền sau khi switch. */
  private parentSessions = new Map<string, Session>();

  constructor(
    private readonly agents: AgentRegistry,
    private readonly factory: SubagentFactory,
    private readonly persistSession?: (session: Session) => Promise<void>,
  ) {}

  bindSession(session: Session): void {
    this.parentSessions.set(session.id, session);
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

      this.handles.set(state.id, { handle: recovered, controller, parentSessionId: session.id });
      this.agents.register(state.id, `Subagent: ${state.objective.slice(0, 60)}`);
      this.agents.update(state.id, {
        status: this.registryStatus(recovered.status),
        sessionId: recovered.sessionId,
      });
    }
  }

  /** Drop parent registry entry (session deleted/pruned). Handles giữ parentSessionId để debug. */
  evictSession(sessionId: string): void {
    this.parentSessions.delete(sessionId);
  }

  start(objective: string, options: SubagentOptions = {}): SubagentHandle {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Subagent objective must not be empty.');
    const parentSessionId = options.parentSessionId ?? this.boundSession?.id;
    if (!parentSessionId) throw new Error('SubagentManager must be bound to a parent session.');
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
    this.handles.set(id, { handle, controller, parentSessionId });
    this.agents.register(id, `Subagent: ${cleanObjective.slice(0, 60)}`);
    this.agents.update(id, {
      status: 'running',
      sessionId: session.id,
      capabilities: options.capabilities || options.requiredCapabilities,
    });
    this.recordState(handle);

    this.launch(handle, session, options, controller);

    return { ...handle };
  }

  spawn(brief: string, options: SubagentOptions = {}): SubagentHandle {
    return this.start(brief, options);
  }

  /**
   * Phân bổ hoặc tạo mới một Agent chuyên trách dựa trên yêu cầu năng lực (Capability Matching)
   */
  allocateTask(objective: string, requiredCapabilities: string[] = [], options: SubagentOptions = {}): SubagentHandle {
    const cleanObjective = objective.trim();
    if (!cleanObjective) throw new Error('Subagent objective must not be empty.');

    // Kiểm tra xem có agent nào rảnh và đáp ứng toàn bộ requiredCapabilities không
    if (requiredCapabilities.length > 0) {
      const candidates = this.agents.list().filter((a) => {
        if (a.status !== 'idle') return false;
        if (!a.capabilities || a.capabilities.length === 0) return false;
        return requiredCapabilities.every((req) => a.capabilities!.includes(req));
      });

      if (candidates.length > 0) {
        const selected = candidates[0];
        const resumed = this.resume(selected.id, { ...options, brief: cleanObjective });
        if (resumed) return resumed;
      }
    }

    // Nếu không có agent sẵn có, tự động spawn agent mới với capabilities được gán
    return this.start(cleanObjective, {
      ...options,
      capabilities: requiredCapabilities.length > 0 ? requiredCapabilities : options.capabilities,
    });
  }

  /**
   * Tìm kiếm danh sách các agent phù hợp với capabilities
   */
  findAgentsByCapabilities(capabilities: string[]): import('./agent-registry.js').AgentRecord[] {
    return this.agents.findAgentsByCapabilities(capabilities);
  }

  /**
   * Đợi subagent hoàn thành một cách đồng bộ không cần vòng lặp polling
   */
  async waitFor(id: string, timeoutMs = 60000): Promise<SubagentHandle> {
    const entry = this.handles.get(id);
    if (!entry) {
      throw new Error(`Subagent '${id}' not found.`);
    }

    if (entry.handle.status !== 'running') {
      return { ...entry.handle };
    }

    return new Promise<SubagentHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for subagent '${id}' after ${timeoutMs}ms.`));
      }, timeoutMs);

      const listener = (h: SubagentHandle) => {
        cleanup();
        resolve(h);
      };

      const cleanup = () => {
        clearTimeout(timer);
        const listeners = this.completionListeners.get(id) || [];
        this.completionListeners.set(
          id,
          listeners.filter((l) => l !== listener)
        );
      };

      const existingListeners = this.completionListeners.get(id) || [];
      existingListeners.push(listener);
      this.completionListeners.set(id, existingListeners);
    });
  }

  /** Resume a stopped/failed delegation only when an operator explicitly asks. */
  resume(id: string, options: SubagentOptions = {}): SubagentHandle | undefined {
    const entry = this.handles.get(id);
    if (!entry || !this.boundSession || (entry.handle.status !== 'stopped' && entry.handle.status !== 'failed')) {
      return undefined;
    }
    entry.parentSessionId ??= options.parentSessionId ?? this.boundSession.id;

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

  getExecutionSession(id: string): Session | undefined {
    return this.handles.get(id)?.executionSession;
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
    this.notifyCompletion(entry.handle);
    return true;
  }

  /**
   * Dừng toàn bộ subagents đang chạy khi tác vụ cha bị hủy
   */
  stopAll(): number {
    let stoppedCount = 0;
    for (const [id, entry] of this.handles.entries()) {
      if (entry.handle.status === 'running') {
        entry.controller.abort();
        entry.handle.status = 'stopped';
        entry.handle.error = 'Subagent stopped due to parent task cancellation.';
        entry.handle.finishedAt = new Date().toISOString();
        this.agents.update(id, { status: 'stopped' });
        this.recordState(entry.handle);
        this.notifyCompletion(entry.handle);
        stoppedCount++;
      }
    }
    return stoppedCount;
  }

  /**
   * Satellite 5: Synchronous Subagent Task Delegation
   * Executes a bounded subtask in an isolated in-memory session.
   * Returns a compact summary (≤ 400 tokens / 1600 chars) and list of touched files
   * without polluting parent session history.
   */
  async executeIsolatedTask(
    task: string,
    options: IsolatedTaskOptions = {},
  ): Promise<IsolatedTaskResult> {
    const cleanTask = task.trim();
    if (!cleanTask) throw new Error('Task description must not be empty.');

    const startTime = Date.now();
    const id = `subtask-${Date.now()}-${this.counter++}`;
    const session = new Session(`session-${id}`);
    const controller = new AbortController();

    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const timeoutTimer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let childLoop: AgentLoop;
    try {
      childLoop = this.factory(id, session, {
        maxSteps: options.maxSteps ?? 6,
        toolNames: options.allowedTools,
        verificationCommand: options.verificationCommand,
      }, controller.signal);
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      return {
        success: false,
        summary: '',
        filesModified: [],
        durationMs: Date.now() - startTime,
        error: err.message,
      };
    }

    try {
      this.agents.register(id, `IsolatedTask: ${cleanTask.slice(0, 60)}`);
      this.agents.update(id, { status: 'running', sessionId: session.id });

      const rawAnswer = await childLoop.submit(session, cleanTask, 'human', {
        maxSteps: options.maxSteps ?? 6,
        signal: controller.signal,
      });

      clearTimeout(timeoutTimer);

      const filesModifiedSet = new Set<string>();
      for (const event of session.getEvents()) {
        if (event.type === 'tool/call') {
          const args = event.data?.args;
          if (args && typeof args === 'object') {
            for (const key of ['path', 'filePath', 'targetFile', 'TargetFile', 'target_path', 'file_path']) {
              if (typeof args[key] === 'string' && args[key].trim()) {
                filesModifiedSet.add(args[key].trim());
              }
            }
          }
        }
      }

      const maxSummaryChars = 1600;
      let summary = (rawAnswer || '').trim();
      if (summary.length > maxSummaryChars) {
        summary = `${summary.slice(0, maxSummaryChars)}\n\n[TRUNCATED: Subagent summary exceeded 1,600 chars]`;
      }

      this.agents.update(id, { status: 'idle' });

      return {
        success: !controller.signal.aborted,
        summary: summary || 'Subagent finished without explicit text response.',
        filesModified: Array.from(filesModifiedSet),
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      this.agents.update(id, { status: 'error' });
      return {
        success: false,
        summary: '',
        filesModified: [],
        durationMs: Date.now() - startTime,
        error: err.message,
      };
    }
  }

  private finishFailure(handle: SubagentHandle, error: unknown): void {
    handle.status = 'failed';
    handle.error = error instanceof Error ? error.message : String(error);
    handle.finishedAt = new Date().toISOString();
    this.agents.update(handle.id, { status: 'error' });
    this.recordState(handle);
    this.notifyCompletion(handle);
  }

  private notifyCompletion(handle: SubagentHandle): void {
    const listeners = this.completionListeners.get(handle.id) || [];
    for (const listener of listeners) {
      try {
        listener({ ...handle });
      } catch {}
    }
    this.completionListeners.delete(handle.id);
  }

  private launch(handle: SubagentHandle, session: Session, options: SubagentOptions, controller: AbortController): void {
    const entry = this.handles.get(handle.id);
    if (entry) entry.executionSession = session;
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
      this.notifyCompletion(handle);
    }).catch((error: any) => {
      if (controller.signal.aborted) {
        handle.status = 'stopped';
        handle.error = 'Subagent stopped by request.';
        this.agents.update(handle.id, { status: 'stopped' });
        handle.finishedAt = new Date().toISOString();
        this.recordState(handle);
        this.notifyCompletion(handle);
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
    // Ghi vào log của session CHA sở hữu delegation — không phải session đang bind
    // (task nền hoàn thành sau khi user đã switch tab).
    const parentId = this.handles.get(handle.id)?.parentSessionId;
    const parent = (parentId ? this.parentSessions.get(parentId) : undefined) ?? this.boundSession;
    if (!parent) return;
    parent.append('agent/delegation', { delegation: { ...handle } });
    void this.persistSession?.(parent);
  }
}
