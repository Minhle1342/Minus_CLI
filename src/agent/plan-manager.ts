import { Session } from '../session/session.js';
import { classifyToolEvidence, type EvidenceKind, isToolResultFailure } from './completion-evidence.js';

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
export type PlanEvidenceOutcome = 'success' | 'failure';

export interface PlanEvidence {
  toolName: string;
  kind: EvidenceKind;
  outcome: PlanEvidenceOutcome;
  summary: string;
  recordedAt: string;
  seq?: number;
  permissionRequestId?: string;
}

export type PlanTaskRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface PlanTask {
  id: number;
  title: string;
  acceptanceCriteria: string;
  status: TaskStatus;
  notes?: string;
  evidence: PlanEvidence[];
  dependsOn: number[];
  parentId?: number;
  readSet: string[];
  writeSet: string[];
  symbols: string[];
  parallelizable: boolean;
  priority: number;
  estimatedCost: number;
  risk: PlanTaskRisk;
  lastMutationSeq: number;
  permissionBlocker?: string;
}

export interface PlanTaskInput {
  id?: number;
  title: string;
  acceptanceCriteria?: string;
  dependsOn?: number[];
  parentId?: number;
  readSet?: string[];
  writeSet?: string[];
  symbols?: string[];
  parallelizable?: boolean;
  priority?: number;
  estimatedCost?: number;
  risk?: PlanTaskRisk;
}

export interface PlanTaskBlocker {
  taskId: number;
  dependencyIds: number[];
  failedDependencyIds: number[];
  permissionBlocker?: string;
}

export interface PlanTaskGraph {
  nodes: PlanTask[];
  edges: Array<{ from: number; to: number }>;
  readyTaskIds: number[];
  blocked: PlanTaskBlocker[];
  criticalPath: number[];
  parallelBatches: number[][];
}

export interface PlanRequirements {
  turn?: number;
  goal: string;
  required: boolean;
  minimumTasks: number;
  maximumTasks: number;
  verificationRequired: boolean;
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'SKIPPED']);
const VALID_STATUSES = new Set<TaskStatus>(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED']);
const PLAN_TOOL_NAMES = new Set(['create_plan', 'update_plan_task']);
const CODE_CHANGE_PATTERN = /\b(implement|implementation|refactor|fix|upgrade|migrate|migration|add\s+(?:a\s+)?feature|modify\s+code|change\s+code|update\s+code)\b|chỉnh\s+sửa\s+code|sửa\s+code|sửa\s+lỗi|khắc\s+phục|triển\s+khai|tái\s+cấu\s+trúc|thêm\s+tính\s+năng|nâng\s+cấp|cập\s+nhật\s+code/iu;
const VERIFICATION_PATTERN = /\b(test|tests|testing|verify|verification|validate|build|compile|lint)\b|kiểm\s+thử|kiểm\s+chứng|xác\s+minh|biên\s+dịch/iu;

function cloneTask(task: PlanTask): PlanTask {
  return {
    ...task,
    evidence: task.evidence.map((item) => ({ ...item })),
    dependsOn: [...task.dependsOn],
    readSet: [...task.readSet],
    writeSet: [...task.writeSet],
    symbols: [...task.symbols],
  };
}

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleSimilarity(left: string, right: string): number {
  const leftNormalized = normalizeComparableText(left);
  const rightNormalized = normalizeComparableText(right);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) {
    return Math.min(leftNormalized.length, rightNormalized.length)
      / Math.max(leftNormalized.length, rightNormalized.length);
  }

  const leftTokens = new Set(leftNormalized.split(' ').filter(Boolean));
  const rightTokens = new Set(rightNormalized.split(' ').filter(Boolean));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function summarizeToolResult(result: Record<string, any>, outcome: PlanEvidenceOutcome): string {
  if (outcome === 'failure') {
    return String(result.errorCode || result.error || 'tool reported a failure').slice(0, 240);
  }
  if (typeof result.exitCode === 'number') return `exitCode=${result.exitCode}`;
  if (typeof result.success === 'boolean') return `success=${result.success}`;
  if (typeof result.message === 'string') return result.message.slice(0, 240);
  return `observed result fields: ${Object.keys(result).slice(0, 8).join(', ') || 'none'}`;
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim().replaceAll('\\', '/')).filter(Boolean))];
}

function normalizeRisk(value: unknown): PlanTaskRisk {
  const normalized = String(value || 'MEDIUM').toUpperCase();
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(normalized)
    ? normalized as PlanTaskRisk
    : 'MEDIUM';
}

/**
 * Durable, turn-scoped execution plan state machine.
 *
 * The LLM proposes decomposition, while this class owns validation, legal
 * transitions, observed evidence, replay, and the model-facing active context.
 */
export class PlanManager {
  private tasks: PlanTask[] = [];
  private session?: Session;
  private activeTurn?: number;
  private goal = '';
  private planRequired = false;
  private verificationRequired = false;
  private evidenceSeq = 0;
  private lastMutationSeq = 0;

  bindSession(session: Session): void {
    if (this.session === session && this.tasks.length > 0) return;

    this.session = session;
    this.rehydrateFromSession();
  }

  /** Rehydrate plan state from the most recent valid session plan event. */
  rehydrateFromSession(): boolean {
    if (!this.session) return false;
    const planEvents = this.session
      .getEvents()
      .filter((event) => event.type === 'plan/change');

    for (let i = planEvents.length - 1; i >= 0; i--) {
      const event = planEvents[i];
      if (event.data.reason === 'cleared') {
        this.tasks = [];
        return false;
      }
      const plan = event.data.plan;
      if (Array.isArray(plan) && plan.length > 0) {
        this.activeTurn = event.data.planTurn ?? this.activeTurn;
        this.goal = event.data.planGoal || this.goal;
        this.planRequired = Boolean(event.data.planRequired);
        this.verificationRequired = Boolean(event.data.planVerificationRequired);
        this.evidenceSeq = Number(event.data.planEvidenceSeq || 0);
        this.lastMutationSeq = Number(event.data.planLastMutationSeq || 0);
        this.tasks = plan.map((task: any, index: number) => ({
          id: task.id,
          title: task.title,
          acceptanceCriteria: task.acceptanceCriteria || `Produce a verifiable result for: ${task.title}`,
          status: VALID_STATUSES.has(task.status as TaskStatus) ? (task.status as TaskStatus) : 'PENDING',
          ...(task.notes ? { notes: task.notes } : {}),
          dependsOn: Array.isArray(task.dependsOn)
            ? task.dependsOn.filter((id: unknown) => Number.isInteger(id))
            : (index > 0 ? [plan[index - 1].id] : []),
          ...(Number.isInteger(task.parentId) ? { parentId: task.parentId } : {}),
          readSet: normalizeStringList(task.readSet),
          writeSet: normalizeStringList(task.writeSet),
          symbols: normalizeStringList(task.symbols),
          parallelizable: Boolean(task.parallelizable),
          priority: Number.isFinite(task.priority) ? Number(task.priority) : 0,
          estimatedCost: Number.isFinite(task.estimatedCost) ? Math.max(1, Number(task.estimatedCost)) : 1,
          risk: normalizeRisk(task.risk),
          lastMutationSeq: Number(task.lastMutationSeq || 0),
          ...(task.permissionBlocker ? { permissionBlocker: String(task.permissionBlocker) } : {}),
          evidence: (task.evidence || []).map((item: any) => ({
            toolName: item.toolName,
            kind: item.kind || 'other',
            outcome: item.outcome === 'failure' ? 'failure' : 'success',
            summary: item.summary,
            recordedAt: item.recordedAt,
            ...(Number.isFinite(item.seq) ? { seq: Number(item.seq) } : {}),
            ...(item.permissionRequestId ? { permissionRequestId: String(item.permissionRequestId) } : {}),
          })),
        }));
        this.validateGraph(this.tasks);
        this.reconcileRunnableState();
        return true;
      }
    }
    return false;
  }

  /** Start a fresh plan boundary for a new user turn while preserving old events. */
  beginTurn(turn: number, userRequest: string): void {
    const goal = userRequest.trim();
    if (this.activeTurn === turn && this.goal === goal) return;

    this.activeTurn = turn;
    this.goal = goal;
    this.planRequired = this.inferPlanRequirement(goal);
    this.verificationRequired = this.inferVerificationRequirement(goal);
    this.tasks = [];
    this.evidenceSeq = 0;
    this.lastMutationSeq = 0;
    this.persist('turn-started');
  }

  getRequirements(): PlanRequirements {
    return {
      ...(this.activeTurn === undefined ? {} : { turn: this.activeTurn }),
      goal: this.goal,
      required: this.planRequired,
      minimumTasks: 1,
      maximumTasks: 20,
      verificationRequired: this.verificationRequired,
    };
  }

  createPlan(tasks: PlanTaskInput[]): PlanTask[] {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Plan requires at least one task.');
    }
    if (tasks.length > 20) {
      throw new Error('Plan must contain at most 20 atomic tasks.');
    }

    const ids = new Set<number>();
    const titles = new Set<string>();
    const normalizedTasks = tasks.map((task, index): PlanTask => {
      if (!task || typeof task !== 'object' || typeof task.title !== 'string' || !task.title.trim()) {
        throw new Error(`Invalid plan task at index ${index}: title must be a non-empty string.`);
      }
      if (task.id !== undefined && (!Number.isInteger(task.id) || task.id < 1)) {
        throw new Error(`Invalid plan task at index ${index}: id must be a positive integer.`);
      }

      const id = task.id ?? index + 1;
      const title = task.title.trim();
      const comparableTitle = normalizeComparableText(title);
      if (ids.has(id)) throw new Error(`Duplicate plan task id: ${id}.`);
      if (titles.has(comparableTitle)) throw new Error(`Duplicate plan task title: "${title}".`);
      ids.add(id);
      titles.add(comparableTitle);

      return {
        id,
        title,
        acceptanceCriteria: task.acceptanceCriteria?.trim()
          || `Produce an observable, verifiable result for: ${title}`,
        status: 'PENDING',
        evidence: [],
        dependsOn: task.dependsOn === undefined
          ? (index > 0 ? [tasks[index - 1].id ?? index] : [])
          : [...new Set(task.dependsOn.map(Number))],
        ...(task.parentId === undefined ? {} : { parentId: Number(task.parentId) }),
        readSet: normalizeStringList(task.readSet),
        writeSet: normalizeStringList(task.writeSet),
        symbols: normalizeStringList(task.symbols),
        parallelizable: Boolean(task.parallelizable),
        priority: Number.isFinite(task.priority) ? Number(task.priority) : 0,
        estimatedCost: Number.isFinite(task.estimatedCost) ? Math.max(1, Number(task.estimatedCost)) : 1,
        risk: normalizeRisk(task.risk),
        lastMutationSeq: this.lastMutationSeq,
      };
    });

    this.validateGraph(normalizedTasks);
    this.tasks = normalizedTasks;
    this.reconcileRunnableState();
    this.persist('created');
    return this.getTasks();
  }

  /** Dynamically add a task to an existing in-flight plan. */
  addTask(task: PlanTaskInput): PlanTask {
    if (this.tasks.length >= 20) {
      throw new Error('Plan already contains the maximum of 20 tasks.');
    }
    const id = task.id !== undefined && Number.isInteger(task.id) && task.id > 0
      ? task.id
      : (Math.max(0, ...this.tasks.map((t) => t.id)) + 1);
    if (this.tasks.some((t) => t.id === id)) {
      throw new Error(`Duplicate plan task id: ${id}.`);
    }
    const title = task.title?.trim() || `Step ${id}`;
    const newTask: PlanTask = {
      id,
      title,
      acceptanceCriteria: task.acceptanceCriteria?.trim() || `Produce an observable, verifiable result for: ${title}`,
      status: 'PENDING',
      evidence: [],
      dependsOn: task.dependsOn === undefined
        ? (this.tasks.length > 0 ? [this.tasks[this.tasks.length - 1].id] : [])
        : [...new Set(task.dependsOn.map(Number))],
      ...(task.parentId === undefined ? {} : { parentId: Number(task.parentId) }),
      readSet: normalizeStringList(task.readSet),
      writeSet: normalizeStringList(task.writeSet),
      symbols: normalizeStringList(task.symbols),
      parallelizable: Boolean(task.parallelizable),
      priority: Number.isFinite(task.priority) ? Number(task.priority) : 0,
      estimatedCost: Number.isFinite(task.estimatedCost) ? Math.max(1, Number(task.estimatedCost)) : 1,
      risk: normalizeRisk(task.risk),
      lastMutationSeq: this.lastMutationSeq,
    };
    const candidateTasks = [...this.tasks, newTask];
    this.validateGraph(candidateTasks);
    this.tasks = candidateTasks;
    this.reconcileRunnableState();
    this.persist('task-added');
    return cloneTask(newTask);
  }

  /** Attach durable evidence from an actually observed non-planning tool result. */
  recordToolEvidence(
    toolName: string,
    args: Record<string, any>,
    result: Record<string, any>,
    permission?: { granted?: boolean; requestId?: string },
  ): void {
    if (!this.hasPlan() || PLAN_TOOL_NAMES.has(toolName)) return;
    const activeTask = this.selectEvidenceTask(toolName, args);
    if (!activeTask) return;

    this.evidenceSeq += 1;
    const outcome: PlanEvidenceOutcome = isToolResultFailure(result) ? 'failure' : 'success';
    const kinds = classifyToolEvidence(toolName, args, result);
    if (kinds.includes('mutation') && outcome === 'success') {
      this.lastMutationSeq = this.evidenceSeq;
      activeTask.lastMutationSeq = this.evidenceSeq;
      for (const task of this.tasks) {
        if (task.status === 'PENDING' || task.status === 'IN_PROGRESS') {
          task.evidence = task.evidence.filter((item) => item.kind !== 'verification' || (item.seq || 0) > this.lastMutationSeq);
        }
      }
    }
    if (['APPROVAL_REQUIRED', 'PERMISSION_DENIED', 'PERMISSION_ERROR'].includes(String(result.errorCode || ''))) {
      activeTask.permissionBlocker = String(result.error || result.errorCode);
    } else if (permission?.granted) {
      delete activeTask.permissionBlocker;
    }
    for (const kind of kinds.length > 0 ? kinds : ['other' as EvidenceKind]) {
      activeTask.evidence.push({
        toolName,
        kind,
        outcome,
        summary: summarizeToolResult(result, outcome),
        recordedAt: new Date().toISOString(),
        seq: this.evidenceSeq,
        ...(permission?.requestId ? { permissionRequestId: permission.requestId } : {}),
      });
    }
    activeTask.evidence = activeTask.evidence.slice(-12);
    this.persist('evidence-recorded');
  }

  updateTask(id: number, status: TaskStatus, notes?: string): PlanTask | null {
    if (!Number.isInteger(id) || id < 1 || !VALID_STATUSES.has(status)) {
      throw new Error('Task id/status is invalid.');
    }
    if (this.tasks.length === 0) {
      this.rehydrateFromSession();
    }
    const taskIndex = this.tasks.findIndex((task) => task.id === id);
    if (taskIndex < 0) return null;

    const task = this.tasks[taskIndex];
    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status === status) {
        if (notes && typeof notes === 'string') task.notes = notes.trim();
        return cloneTask(task);
      }
      throw new Error(`Task #${id} is already terminal (${task.status}) and cannot be reopened.`);
    }

    const normalizedNotes = typeof notes === 'string' ? notes.trim() : '';

    if (status === 'IN_PROGRESS') {
      const blocker = this.blockerFor(task);
      if (blocker.dependencyIds.length > 0 || blocker.failedDependencyIds.length > 0) {
        throw new Error(
          `Task #${id} is blocked by dependencies: ${[...blocker.dependencyIds, ...blocker.failedDependencyIds].join(', ')}.`,
        );
      }
      const running = this.tasks.filter((candidate) => candidate.status === 'IN_PROGRESS' && candidate.id !== id);
      const conflict = running.find((candidate) => !this.canRunConcurrently(candidate, task));
      if (conflict) {
        throw new Error(`Task #${id} cannot run concurrently with active task #${conflict.id}; dependency or write-set conflict detected.`);
      }
      task.status = 'IN_PROGRESS';
      if (normalizedNotes) task.notes = normalizedNotes;
      this.persist('task-started');
      return cloneTask(task);
    }

    if (status === 'PENDING') {
      throw new Error('An active task cannot be moved backwards to PENDING.');
    }

    if (task.status !== 'IN_PROGRESS') {
      throw new Error(`Task #${id} must be IN_PROGRESS before it can move to ${status}.`);
    }

    if (
      status === 'COMPLETED'
      && this.activeTurn !== undefined
      && !this.hasRequiredEvidence(task)
    ) {
      throw new Error(`Task #${id} cannot be completed before matching successful ${this.requiredEvidenceKind(task)} evidence is observed.`);
    }
    if ((status === 'FAILED' || status === 'SKIPPED') && !normalizedNotes) {
      throw new Error(`${status} requires notes explaining the concrete blocker or skip reason.`);
    }
    task.status = status;
    if (normalizedNotes) task.notes = normalizedNotes;

    this.reconcileRunnableState();

    this.persist('updated');
    return cloneTask(task);
  }

  getTasks(): PlanTask[] {
    return this.tasks.map(cloneTask);
  }

  getActiveTask(): PlanTask | undefined {
    const task = this.getActiveTaskReference();
    return task ? cloneTask(task) : undefined;
  }

  getActiveTasks(): PlanTask[] {
    return this.tasks.filter((task) => task.status === 'IN_PROGRESS').map(cloneTask);
  }

  getReadyTasks(): PlanTask[] {
    return this.tasks
      .filter((task) => task.status === 'PENDING' && this.isDependencySatisfied(task) && !task.permissionBlocker)
      .sort((left, right) => this.compareSchedulingPriority(left, right))
      .map(cloneTask);
  }

  getBlockedTasks(): PlanTaskBlocker[] {
    return this.tasks
      .filter((task) => task.status === 'PENDING' || Boolean(task.permissionBlocker))
      .map((task) => this.blockerFor(task))
      .filter((blocker) => blocker.dependencyIds.length > 0 || blocker.failedDependencyIds.length > 0 || blocker.permissionBlocker);
  }

  getTaskGraph(): PlanTaskGraph {
    return {
      nodes: this.getTasks(),
      edges: this.tasks.flatMap((task) => task.dependsOn.map((dependencyId) => ({ from: dependencyId, to: task.id }))),
      readyTaskIds: this.getReadyTasks().map((task) => task.id),
      blocked: this.getBlockedTasks(),
      criticalPath: this.getCriticalPath(),
      parallelBatches: this.getParallelBatches(),
    };
  }

  /** Lấy task chưa hoàn thành kế tiếp (đang IN_PROGRESS hoặc PENDING đầu tiên) */
  getNextIncompleteTask(): PlanTask | undefined {
    const active = this.getActiveTaskReference();
    if (active) return cloneTask(active);
    const pending = this.getReadyTasks()[0] || this.tasks.find((task) => task.status === 'PENDING');
    return pending ? cloneTask(pending) : undefined;
  }

  /** Kiểm tra xem toàn bộ các task trong plan đã ở trạng thái terminal hợp lệ (COMPLETED hoặc SKIPPED) chưa */
  isAllTasksCompleted(): boolean {
    if (this.tasks.length === 0) return false;
    return this.tasks.every((task) => task.status === 'COMPLETED' || task.status === 'SKIPPED');
  }

  /** Lấy danh sách các task chưa hoàn thành */
  getIncompleteTasks(): PlanTask[] {
    return this.tasks.filter((task) => !TERMINAL_STATUSES.has(task.status)).map(cloneTask);
  }

  /** Ép buộc hoặc cập nhật yêu cầu phải có Plan */
  setPlanRequired(required: boolean, reason?: string): void {
    this.planRequired = required;
    this.persist(reason || (required ? 'plan-mandated' : 'plan-optional'));
  }

  hasPlan(): boolean {
    return this.tasks.length > 0;
  }

  getProgress(): { total: number; completed: number; inProgress: number; pending: number; blocked: number; failed: number; skipped: number } {
    return {
      total: this.tasks.length,
      completed: this.tasks.filter((task) => task.status === 'COMPLETED').length,
      inProgress: this.tasks.filter((task) => task.status === 'IN_PROGRESS').length,
      pending: this.tasks.filter((task) => task.status === 'PENDING').length,
      blocked: this.getBlockedTasks().length,
      failed: this.tasks.filter((task) => task.status === 'FAILED').length,
      skipped: this.tasks.filter((task) => task.status === 'SKIPPED').length,
    };
  }

  getCompletionBlocker(): string | undefined {
    if (!this.hasPlan()) return undefined;
    const unfinished = this.tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
    if (unfinished.length === 0) return undefined;
    const active = unfinished.find((task) => task.status === 'IN_PROGRESS');
    const blocked = this.getBlockedTasks();
    if (!active && blocked.length > 0) {
      return `Execution plan is graph-blocked: ${blocked.length} task(s) await dependencies or permission; ${unfinished.length} task(s) remain.`;
    }
    const next = active || this.getReadyTasks()[0] || unfinished[0];
    return `Execution plan is incomplete: ${unfinished.length} task(s) remain; active/next task is #${next.id} "${next.title}".`;
  }

  renderExecutionContext(): string {
    const requirements = this.getRequirements();
    if (!this.hasPlan()) {
      return [
        '[DYNAMIC EXECUTION PLAN]',
        `Turn: ${requirements.turn ?? 'unscoped'}`,
        `Goal: ${requirements.goal || '(not captured)'}`,
        requirements.required
          ? `PLAN REQUIRED: call create_plan with ${requirements.minimumTasks}-${requirements.maximumTasks} atomic steps before doing multi-step work or answering finally.`
          : 'No plan exists. A plan is optional for a genuinely single-step request.',
        'Never use one task that merely restates the user request.',
      ].join('\n');
    }

    const lines = this.tasks.map((task) => {
      const evidence = task.evidence.length > 0
        ? task.evidence.map((item) => `${item.toolName}:${item.kind}:${item.outcome}`).join(', ')
        : 'none';
      const blocker = this.blockerFor(task);
      const graphState = blocker.failedDependencyIds.length > 0
        ? `BLOCKED_BY_FAILED(${blocker.failedDependencyIds.join(',')})`
        : blocker.dependencyIds.length > 0
          ? `WAITING_FOR(${blocker.dependencyIds.join(',')})`
          : task.permissionBlocker
            ? 'AWAITING_PERMISSION'
            : task.status === 'PENDING' ? 'READY' : task.status;
      return `${task.id}. [${task.status}; ${graphState}] ${task.title}\n   Depends on: ${task.dependsOn.join(', ') || 'none'}; parent=${task.parentId ?? 'none'}; priority=${task.priority}; risk=${task.risk}; parallel=${task.parallelizable}\n   Code anchors: files=${[...task.readSet, ...task.writeSet].join(', ') || 'none'}; symbols=${task.symbols.join(', ') || 'none'}\n   Acceptance: ${task.acceptanceCriteria}\n   Observed evidence: ${evidence}`;
    });
    const activeTasks = this.getActiveTasks();
    const graph = this.getTaskGraph();
    return [
      '[DYNAMIC EXECUTION PLAN - AUTHORITATIVE TURN STATE]',
      `Turn: ${requirements.turn ?? 'unscoped'}`,
      `Goal: ${requirements.goal || '(not captured)'}`,
      `Critical path: ${graph.criticalPath.join(' -> ') || 'none'}`,
      `Ready tasks: ${graph.readyTaskIds.join(', ') || 'none'}; safe parallel batches: ${graph.parallelBatches.map((batch) => `[${batch.join(',')}]`).join(' ') || 'none'}`,
      ...lines,
      activeTasks.length > 0
        ? `ACTIVE TASKS: ${activeTasks.map((task) => `#${task.id}`).join(', ')}. Work only on graph-ready tasks and update status via update_plan_task.`
        : 'All tasks are completed.',
    ].join('\n');
  }

  private inferPlanRequirement(goal: string): boolean {
    const text = normalizeComparableText(goal);
    if (!text) return false;
    return (
      /\b(implement|refactor|fix|migrate|integrate|build|create|sua|trien khai)\b/.test(text)
      && /\b(and|then|after|verify|tests?|build|lint|multi|steps?|kiem chung)\b/.test(text)
    );
  }

  private inferVerificationRequirement(goal: string): boolean {
    const text = normalizeComparableText(goal);
    if (!text) return false;
    return /\b(verify|test|tests|build|typecheck|lint|kiem chung|kiem thu)\b/.test(text);
  }

  buildContinuationPrompt(blocker = this.getCompletionBlocker()): string {
    return `[SYSTEM PLAN CONTINUATION]: ${blocker || 'The execution plan requires more work.'}\n${this.renderExecutionContext()}\nContinue now with the required tool call; do not return another progress-only message.`;
  }

  clear(): void {
    this.tasks = [];
    this.evidenceSeq = 0;
    this.lastMutationSeq = 0;
    this.persist('cleared');
  }

  private getActiveTaskReference(): PlanTask | undefined {
    return this.tasks
      .filter((task) => task.status === 'IN_PROGRESS')
      .sort((left, right) => this.compareSchedulingPriority(left, right))[0];
  }

  private requiredEvidenceKind(task: PlanTask): EvidenceKind | 'any' {
    const text = normalizeComparableText(`${task.title} ${task.acceptanceCriteria}`);
    if (VERIFICATION_PATTERN.test(text)) return 'verification';
    if (/\b(commit|push|branch|stage|git)\b/.test(text)) return 'git';
    if (/\b(implement|fix|modify|change|write|create|refactor|sua|cap nhat|trien khai|tao)\b/.test(text)) return 'mutation';
    if (/\b(inspect|analyze|read|search|locate|trace|review|khao sat|phan tich|doc|tim)\b/.test(text)) return 'inspection';
    return 'any';
  }

  private hasRequiredEvidence(task: PlanTask): boolean {
    const required = this.requiredEvidenceKind(task);
    return task.evidence.some((item) => {
      if (item.outcome !== 'success' || (required !== 'any' && item.kind !== required)) return false;
      if (required === 'verification') return (item.seq || 0) > Math.max(task.lastMutationSeq, this.lastMutationSeq);
      return true;
    });
  }

  private validateGraph(tasks: PlanTask[]): void {
    const ids = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
      if (task.parentId !== undefined && (!ids.has(task.parentId) || task.parentId === task.id)) {
        throw new Error(`Task #${task.id} has invalid parentId ${task.parentId}.`);
      }
      for (const dependencyId of task.dependsOn) {
        if (!Number.isInteger(dependencyId) || !ids.has(dependencyId)) {
          throw new Error(`Task #${task.id} depends on missing task #${dependencyId}.`);
        }
        if (dependencyId === task.id) throw new Error(`Task #${task.id} cannot depend on itself.`);
      }
    }
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const visited = new Set<number>();
    const stack = new Set<number>();
    const visit = (id: number): void => {
      if (stack.has(id)) throw new Error(`Task dependency cycle detected involving task #${id}.`);
      if (visited.has(id)) return;
      stack.add(id);
      for (const dependencyId of taskById.get(id)?.dependsOn || []) visit(dependencyId);
      stack.delete(id);
      visited.add(id);
    };
    for (const task of tasks) visit(task.id);

    const parentVisited = new Set<number>();
    const parentStack = new Set<number>();
    const visitParent = (id: number): void => {
      if (parentStack.has(id)) throw new Error(`Task hierarchy cycle detected involving task #${id}.`);
      if (parentVisited.has(id)) return;
      parentStack.add(id);
      const parentId = taskById.get(id)?.parentId;
      if (parentId !== undefined) visitParent(parentId);
      parentStack.delete(id);
      parentVisited.add(id);
    };
    for (const task of tasks) visitParent(task.id);
  }

  private isDependencySatisfied(task: PlanTask): boolean {
    return task.dependsOn.every((dependencyId) => {
      const dependency = this.tasks.find((candidate) => candidate.id === dependencyId);
      return dependency?.status === 'COMPLETED' || dependency?.status === 'SKIPPED';
    });
  }

  private blockerFor(task: PlanTask): PlanTaskBlocker {
    const dependencies = task.dependsOn
      .map((dependencyId) => this.tasks.find((candidate) => candidate.id === dependencyId))
      .filter((dependency): dependency is PlanTask => Boolean(dependency));
    return {
      taskId: task.id,
      dependencyIds: dependencies
        .filter((dependency) => !TERMINAL_STATUSES.has(dependency.status))
        .map((dependency) => dependency.id),
      failedDependencyIds: dependencies
        .filter((dependency) => dependency.status === 'FAILED')
        .map((dependency) => dependency.id),
      ...(task.permissionBlocker ? { permissionBlocker: task.permissionBlocker } : {}),
    };
  }

  private reconcileRunnableState(): void {
    if (this.tasks.some((task) => task.status === 'IN_PROGRESS')) return;
    const next = this.tasks
      .filter((task) => task.status === 'PENDING' && this.isDependencySatisfied(task) && !task.permissionBlocker)
      .sort((left, right) => this.compareSchedulingPriority(left, right))[0];
    if (next) next.status = 'IN_PROGRESS';
  }

  private compareSchedulingPriority(left: PlanTask, right: PlanTask): number {
    const riskWeight: Record<PlanTaskRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    return right.priority - left.priority
      || riskWeight[right.risk] - riskWeight[left.risk]
      || right.estimatedCost - left.estimatedCost
      || left.id - right.id;
  }

  private canRunConcurrently(left: PlanTask, right: PlanTask): boolean {
    if (!left.parallelizable || !right.parallelizable) return false;
    if (this.hasDependencyPath(left.id, right.id) || this.hasDependencyPath(right.id, left.id)) return false;
    const conflicts = (writes: string[], accesses: string[]): boolean => writes.some((write) => accesses.some((access) => {
      const normalizedWrite = write.toLowerCase().replace(/\/$/, '');
      const normalizedAccess = access.toLowerCase().replace(/\/$/, '');
      return normalizedWrite === normalizedAccess
        || normalizedWrite.startsWith(`${normalizedAccess}/`)
        || normalizedAccess.startsWith(`${normalizedWrite}/`);
    }));
    return !conflicts(left.writeSet, [...right.readSet, ...right.writeSet])
      && !conflicts(right.writeSet, [...left.readSet, ...left.writeSet]);
  }

  /** Attribute tool evidence to the most relevant running DAG node. */
  private selectEvidenceTask(toolName: string, args: Record<string, any>): PlanTask | undefined {
    const active = this.tasks.filter((task) => task.status === 'IN_PROGRESS');
    if (active.length <= 1) return active[0];
    const candidatePaths = normalizeStringList([
      args.path,
      args.fromPath,
      args.toPath,
      ...(Array.isArray(args.paths) ? args.paths : []),
    ]).map((item) => item.toLowerCase());
    const candidateSymbols = normalizeStringList([
      args.symbol,
      args.symbolName,
      args.query,
    ]).map((item) => item.toLowerCase());
    const mutation = classifyToolEvidence(toolName, args, {}).includes('mutation');
    const score = (task: PlanTask): number => {
      const pathScore = (paths: string[], weight: number): number => paths.reduce((total, taskPath) => {
        const normalizedTaskPath = taskPath.toLowerCase().replace(/\/$/, '');
        return total + (candidatePaths.some((candidate) => candidate === normalizedTaskPath
          || candidate.endsWith(`/${normalizedTaskPath}`)
          || candidate.startsWith(`${normalizedTaskPath}/`)) ? weight : 0);
      }, 0);
      return pathScore(task.writeSet, mutation ? 12 : 6)
        + pathScore(task.readSet, 8)
        + task.symbols.reduce((total, symbol) => total + (candidateSymbols.some((candidate) => candidate.includes(symbol.toLowerCase())) ? 8 : 0), 0);
    };
    return [...active].sort((left, right) => score(right) - score(left) || this.compareSchedulingPriority(left, right))[0];
  }

  private hasDependencyPath(fromId: number, toId: number, seen = new Set<number>()): boolean {
    if (fromId === toId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    const dependents = this.tasks.filter((task) => task.dependsOn.includes(fromId));
    return dependents.some((dependent) => this.hasDependencyPath(dependent.id, toId, new Set(seen)));
  }

  private getCriticalPath(): number[] {
    const taskById = new Map(this.tasks.map((task) => [task.id, task]));
    const dependents = new Map<number, number[]>();
    for (const task of this.tasks) {
      for (const dependencyId of task.dependsOn) {
        const items = dependents.get(dependencyId) || [];
        items.push(task.id);
        dependents.set(dependencyId, items);
      }
    }
    const riskWeight: Record<PlanTaskRisk, number> = { LOW: 1, MEDIUM: 1.25, HIGH: 1.6, CRITICAL: 2 };
    const cache = new Map<number, { score: number; path: number[] }>();
    const longest = (id: number): { score: number; path: number[] } => {
      const cached = cache.get(id);
      if (cached) return cached;
      const task = taskById.get(id)!;
      const children = (dependents.get(id) || []).map(longest).sort((left, right) => right.score - left.score);
      const result = {
        score: task.estimatedCost * riskWeight[task.risk] + (children[0]?.score || 0),
        path: [id, ...(children[0]?.path || [])],
      };
      cache.set(id, result);
      return result;
    };
    const roots = this.tasks.filter((task) => task.dependsOn.length === 0);
    return roots.map((task) => longest(task.id)).sort((left, right) => right.score - left.score)[0]?.path || [];
  }

  private getParallelBatches(): number[][] {
    // Structural schedule (including completed nodes) is retained for audit and Dream learning.
    const remaining = new Map(this.tasks.map((task) => [task.id, task]));
    const satisfied = new Set<number>();
    const batches: number[][] = [];
    while (remaining.size > 0) {
      const candidates = [...remaining.values()]
        .filter((task) => task.dependsOn.every((dependencyId) => satisfied.has(dependencyId)))
        .sort((left, right) => this.compareSchedulingPriority(left, right));
      if (candidates.length === 0) break;
      const batch: PlanTask[] = [];
      for (const candidate of candidates) {
        if (batch.length === 0 || batch.every((member) => this.canRunConcurrently(member, candidate))) {
          batch.push(candidate);
        }
      }
      for (const task of batch) {
        remaining.delete(task.id);
        satisfied.add(task.id);
      }
      batches.push(batch.map((task) => task.id));
    }
    return batches;
  }

  private persist(reason: string): void {
    this.session?.append('plan/change', {
      reason,
      planTurn: this.activeTurn,
      planGoal: this.goal,
      planRequired: this.planRequired,
      planVerificationRequired: this.verificationRequired,
      planEvidenceSeq: this.evidenceSeq,
      planLastMutationSeq: this.lastMutationSeq,
      plan: this.tasks.map(cloneTask),
    });
  }
}
