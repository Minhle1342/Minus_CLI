import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { PlanManager, PlanTaskInput, TaskStatus } from '../agent/plan-manager.js';

const ALLOWED_TASK_STATUSES = new Set<TaskStatus>(['IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED']);

function normalizePlanTasks(rawTasks: unknown[]): { tasks?: PlanTaskInput[]; error?: string } {
  const tasks: PlanTaskInput[] = [];

  for (let index = 0; index < rawTasks.length; index += 1) {
    const rawTask = rawTasks[index];

    if (typeof rawTask === 'string') {
      const title = rawTask.trim();
      if (!title) return { error: `tasks[${index}] must be a non-empty string.` };
      tasks.push({ title });
      continue;
    }

    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      return { error: `tasks[${index}] must be a string or an object with a title.` };
    }

    const candidate = rawTask as Record<string, unknown>;
    if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
      return { error: `tasks[${index}].title must be a non-empty string.` };
    }

    let id: number | undefined;
    if (candidate.id !== undefined) {
      const parsedId = Number(candidate.id);
      if (!Number.isInteger(parsedId) || parsedId < 1) {
        return { error: `tasks[${index}].id must be a positive integer.` };
      }
      id = parsedId;
    }

    const acceptanceCriteria = typeof candidate.acceptanceCriteria === 'string'
      ? candidate.acceptanceCriteria.trim()
      : undefined;
    tasks.push({
      ...(id === undefined ? {} : { id }),
      title: candidate.title.trim(),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    });
  }

  return { tasks };
}

/** Create a semantically validated execution plan for the current user turn. */
export function createPlanTool(planManager: PlanManager): ToolDefinition {
  return {
    name: 'create_plan',
    description: 'Create a 3-7 step execution plan for complex coding work. Each task must be atomic, must not repeat the user request, and code changes must end with an explicit test/build verification step.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tasks: {
          type: Type.ARRAY,
          description: 'Ordered atomic tasks. Do not submit one task that merely restates the request.',
          items: {
            type: Type.OBJECT,
            properties: {
              id: {
                type: Type.NUMBER,
                description: 'Stable positive step number.',
              },
              title: {
                type: Type.STRING,
                description: 'Concrete action for this step, such as inspect affected files, reproduce the bug, implement the fix, or run relevant tests.',
              },
              acceptanceCriteria: {
                type: Type.STRING,
                description: 'Observable condition proving this step is complete. If omitted, the harness derives a conservative criterion from the title.',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
    async execute(args) {
      if (!args.tasks || !Array.isArray(args.tasks) || args.tasks.length === 0) {
        return {
          error: '"tasks" must be a non-empty array of execution steps.',
          errorCode: 'INVALID_ARGS',
        };
      }

      const normalized = normalizePlanTasks(args.tasks);
      if (!normalized.tasks) {
        return { error: normalized.error, errorCode: 'INVALID_ARGS' };
      }

      try {
        const tasks = planManager.createPlan(normalized.tasks);
        return {
          message: `Created an execution plan with ${tasks.length} steps.`,
          tasks,
          requirements: planManager.getRequirements(),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          errorCode: 'PLAN_VALIDATION_FAILED',
          retryable: true,
          requirements: planManager.getRequirements(),
        };
      }
    },
  };
}

/** Advance only the currently active task after observed execution evidence. */
export function createUpdatePlanTaskTool(planManager: PlanManager): ToolDefinition {
  return {
    name: 'update_plan_task',
    description: 'Update only the active execution-plan task. COMPLETED requires successful tool evidence observed by the harness; FAILED/SKIPPED require a concrete explanation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: {
          type: Type.NUMBER,
          description: 'ID of the active step.',
        },
        status: {
          type: Type.STRING,
          description: 'New status: IN_PROGRESS, COMPLETED, FAILED, or SKIPPED.',
        },
        notes: {
          type: Type.STRING,
          description: 'Concrete result, blocker, or skip reason.',
        },
        evidence: {
          type: Type.STRING,
          description: 'Concise explanation of the observed result. It annotates but cannot replace an actual tool result.',
        },
      },
      required: ['id', 'status'],
    },
    async execute(args) {
      const id = Number(args.id);
      const status = String(args.status).toUpperCase() as TaskStatus;
      if (!Number.isInteger(id) || id < 1 || !ALLOWED_TASK_STATUSES.has(status)) {
        return {
          error: 'id must be a positive integer and status must be IN_PROGRESS, COMPLETED, FAILED, or SKIPPED.',
          errorCode: 'INVALID_ARGS',
        };
      }

      // Rehydrate plan from session if planManager has no plan currently in memory
      if (!planManager.hasPlan()) {
        planManager.rehydrateFromSession();
      }

      let updated;
      try {
        updated = planManager.updateTask(id, status, args.evidence || args.notes);
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        let hint = 'Execute a tool matching the task acceptance criteria before marking it complete.';
        if (errorMsg.includes('inspection evidence')) {
          hint = 'This step requires inspection evidence. Call inspection tools (e.g. read_file, search_codebase_fast, list_files, inspect_symbol) before marking COMPLETED.';
        } else if (errorMsg.includes('mutation evidence')) {
          hint = 'This step requires code mutation evidence. Call mutation tools (e.g. replace_text, apply_patch, create_file, write_file) before marking COMPLETED.';
        } else if (errorMsg.includes('verification evidence')) {
          hint = 'This step requires test/build verification evidence. Call run_command (to run tests or build) or get_diagnostics before marking COMPLETED.';
        }
        return {
          error: errorMsg,
          errorCode: 'PLAN_TRANSITION_REJECTED',
          retryable: true,
          hint,
          activeTask: planManager.getActiveTask(),
        };
      }

      if (!updated) {
        if (!planManager.hasPlan()) {
          // Antigravity & Codex resilience pattern: Auto-recover/initialize plan from context if possible
          const fallbackTitle = (typeof args.evidence === 'string' && args.evidence.trim())
            || (typeof args.notes === 'string' && args.notes.trim())
            || `Task #${id}`;
          try {
            planManager.createPlan([
              { id, title: fallbackTitle, acceptanceCriteria: `Observable result for: ${fallbackTitle}` },
            ]);
            updated = planManager.updateTask(id, status, args.evidence || args.notes);
            return {
              message: `Execution plan auto-initialized with step #${id} and updated to ${status}.`,
              task: updated,
              progress: planManager.getProgress(),
              recovered: true,
            };
          } catch {
            return {
              error: 'No execution plan has been created in this session. Call "create_plan" first to define execution steps, or skip calling "update_plan_task" for simple single-step tasks.',
              errorCode: 'NO_PLAN_EXISTS',
              hint: 'Call create_plan first with a tasks array: [{ title: "Inspect code" }, { title: "Implement fix" }, { title: "Run verification" }].',
            };
          }
        }

        const existingTasks = planManager.getTasks();
        // If task ID is not found, dynamically register it if under limit (Codex/Antigravity dynamic expansion)
        if (existingTasks.length < 7 && !existingTasks.some((t) => t.id === id)) {
          const fallbackTitle = (typeof args.evidence === 'string' && args.evidence.trim())
            || (typeof args.notes === 'string' && args.notes.trim())
            || `Task #${id}`;
          try {
            planManager.addTask({ id, title: fallbackTitle, acceptanceCriteria: `Observable result for: ${fallbackTitle}` });
            updated = planManager.updateTask(id, status, args.evidence || args.notes);
            return {
              message: `Added and updated step #${id} to ${status}.`,
              task: updated,
              progress: planManager.getProgress(),
            };
          } catch {
            // fall through to standard error reporting
          }
        }

        const availableIds = existingTasks.map((t) => `#${t.id}: "${t.title}" (${t.status})`).join(', ');
        const activeTask = planManager.getActiveTask();
        return {
          error: `No plan step with id ${id} exists. Available step IDs: [${availableIds}].`,
          errorCode: 'PLAN_TASK_NOT_FOUND',
          activeStepId: activeTask?.id,
          hint: activeTask ? `Currently active step is #${activeTask.id} ("${activeTask.title}"). Pass id: ${activeTask.id}.` : 'No active step exists.',
        };
      }

      return {
        message: `Updated step #${id} to ${status}.`,
        task: updated,
        progress: planManager.getProgress(),
      };
    },
  };
}
