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
}

export interface PlanTask {
  id: number;
  title: string;
  acceptanceCriteria: string;
  status: TaskStatus;
  notes?: string;
  evidence: PlanEvidence[];
}

export interface PlanTaskInput {
  id?: number;
  title: string;
  acceptanceCriteria?: string;
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

  bindSession(session: Session): void {
    if (this.session === session) return;

    this.session = session;
    const planEvent = session
      .getEvents()
      .filter((event) => event.type === 'plan/change')
      .at(-1);
    this.activeTurn = planEvent?.data.planTurn;
    this.goal = planEvent?.data.planGoal || '';
    this.planRequired = Boolean(planEvent?.data.planRequired);
    this.verificationRequired = Boolean(planEvent?.data.planVerificationRequired);
    this.tasks = (planEvent?.data.plan || []).map((task) => ({
      id: task.id,
      title: task.title,
      acceptanceCriteria: task.acceptanceCriteria || `Produce a verifiable result for: ${task.title}`,
      status: VALID_STATUSES.has(task.status as TaskStatus) ? task.status as TaskStatus : 'PENDING',
      ...(task.notes ? { notes: task.notes } : {}),
      evidence: (task.evidence || []).map((item) => ({
        toolName: item.toolName,
        kind: item.kind || 'other',
        outcome: item.outcome === 'failure' ? 'failure' : 'success',
        summary: item.summary,
        recordedAt: item.recordedAt,
      })),
    }));
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
    this.persist('turn-started');
  }

  getRequirements(): PlanRequirements {
    return {
      ...(this.activeTurn === undefined ? {} : { turn: this.activeTurn }),
      goal: this.goal,
      required: this.planRequired,
      minimumTasks: 1,
      maximumTasks: 7,
      verificationRequired: this.verificationRequired,
    };
  }

  createPlan(tasks: PlanTaskInput[]): PlanTask[] {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Plan requires at least one task.');
    }
    if (tasks.length > 7) {
      throw new Error('Plan must contain at most 7 atomic tasks.');
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
        status: index === 0 ? 'IN_PROGRESS' : 'PENDING',
        evidence: [],
      };
    });

    this.tasks = normalizedTasks;
    this.persist('created');
    return this.getTasks();
  }

  /** Attach durable evidence from an actually observed non-planning tool result. */
  recordToolEvidence(toolName: string, args: Record<string, any>, result: Record<string, any>): void {
    if (!this.hasPlan() || PLAN_TOOL_NAMES.has(toolName)) return;
    const activeTask = this.getActiveTaskReference();
    if (!activeTask) return;

    const outcome: PlanEvidenceOutcome = isToolResultFailure(result) ? 'failure' : 'success';
    const kinds = classifyToolEvidence(toolName, args, result);
    for (const kind of kinds.length > 0 ? kinds : ['other' as EvidenceKind]) {
      activeTask.evidence.push({
        toolName,
        kind,
        outcome,
        summary: summarizeToolResult(result, outcome),
        recordedAt: new Date().toISOString(),
      });
    }
    activeTask.evidence = activeTask.evidence.slice(-12);
    this.persist('evidence-recorded');
  }

  updateTask(id: number, status: TaskStatus, notes?: string): PlanTask | null {
    if (!Number.isInteger(id) || id < 1 || !VALID_STATUSES.has(status)) {
      throw new Error('Task id/status is invalid.');
    }
    const taskIndex = this.tasks.findIndex((task) => task.id === id);
    if (taskIndex < 0) return null;

    const task = this.tasks[taskIndex];
    const activeTask = this.getActiveTaskReference();
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new Error(`Task #${id} is already terminal (${task.status}) and cannot be reopened.`);
    }
    if (activeTask && activeTask.id !== id) {
      throw new Error(`Task #${activeTask.id} is the only active task. Finish it before updating task #${id}.`);
    }
    if (status === 'PENDING') {
      throw new Error('An active task cannot be moved backwards to PENDING.');
    }
    if (status === 'IN_PROGRESS') {
      return cloneTask(task);
    }

    const normalizedNotes = typeof notes === 'string' ? notes.trim() : '';
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

    const nextPending = this.tasks.slice(taskIndex + 1).find((candidate) => candidate.status === 'PENDING');
    if (nextPending) nextPending.status = 'IN_PROGRESS';

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

  hasPlan(): boolean {
    return this.tasks.length > 0;
  }

  getProgress(): { total: number; completed: number; inProgress: number; pending: number; failed: number; skipped: number } {
    return {
      total: this.tasks.length,
      completed: this.tasks.filter((task) => task.status === 'COMPLETED').length,
      inProgress: this.tasks.filter((task) => task.status === 'IN_PROGRESS').length,
      pending: this.tasks.filter((task) => task.status === 'PENDING').length,
      failed: this.tasks.filter((task) => task.status === 'FAILED').length,
      skipped: this.tasks.filter((task) => task.status === 'SKIPPED').length,
    };
  }

  getCompletionBlocker(): string | undefined {
    if (!this.hasPlan()) return undefined;
    const unfinished = this.tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
    if (unfinished.length === 0) return undefined;
    const active = unfinished.find((task) => task.status === 'IN_PROGRESS') || unfinished[0];
    return `Execution plan is incomplete: ${unfinished.length} task(s) remain; active task is #${active.id} "${active.title}".`;
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
      return `${task.id}. [${task.status}] ${task.title}\n   Acceptance: ${task.acceptanceCriteria}\n   Observed evidence: ${evidence}`;
    });
    const active = this.getActiveTaskReference();
    return [
      '[DYNAMIC EXECUTION PLAN - AUTHORITATIVE TURN STATE]',
      `Turn: ${requirements.turn ?? 'unscoped'}`,
      `Goal: ${requirements.goal || '(not captured)'}`,
      ...lines,
      active
        ? `ACTIVE TASK: Work toward #${active.id}. Update status via update_plan_task as milestones complete.`
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
    this.persist('cleared');
  }

  private getActiveTaskReference(): PlanTask | undefined {
    return this.tasks.find((task) => task.status === 'IN_PROGRESS');
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
    return task.evidence.some((item) => item.outcome === 'success' && (required === 'any' || item.kind === required));
  }

  private persist(reason: string): void {
    this.session?.append('plan/change', {
      reason,
      planTurn: this.activeTurn,
      planGoal: this.goal,
      planRequired: this.planRequired,
      planVerificationRequired: this.verificationRequired,
      plan: this.tasks.map(cloneTask),
    });
  }
}
