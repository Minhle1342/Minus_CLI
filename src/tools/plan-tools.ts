import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { PlanManager, TaskStatus } from '../agent/plan-manager.js';

type PlanTaskInput = { id?: number; title: string };

function normalizePlanTasks(rawTasks: unknown[]): { tasks?: PlanTaskInput[]; error?: string } {
  const tasks: PlanTaskInput[] = [];

  for (let index = 0; index < rawTasks.length; index += 1) {
    const rawTask = rawTasks[index];

    if (typeof rawTask === 'string') {
      const title = rawTask.trim();
      if (!title) {
        return { error: `Phần tử tasks[${index}] phải là chuỗi không rỗng.` };
      }
      tasks.push({ title });
      continue;
    }

    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      return { error: `Phần tử tasks[${index}] phải là chuỗi hoặc object có title.` };
    }

    const candidate = rawTask as Record<string, unknown>;
    if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
      return { error: `Phần tử tasks[${index}].title phải là chuỗi không rỗng.` };
    }

    let id: number | undefined;
    if (candidate.id !== undefined) {
      const parsedId = Number(candidate.id);
      if (!Number.isInteger(parsedId) || parsedId < 1) {
        return { error: `Phần tử tasks[${index}].id phải là số nguyên dương.` };
      }
      id = parsedId;
    }

    tasks.push(id === undefined
      ? { title: candidate.title.trim() }
      : { id, title: candidate.title.trim() });
  }

  return { tasks };
}

/**
 * Tool: create_plan
 * Cho phép LLM khởi tạo Plan Tree phân rã nhiệm vụ
 */
export function createPlanTool(planManager: PlanManager): ToolDefinition {
  return {
    name: 'create_plan',
    description: 'Tạo cây kế hoạch (Plan Tree) gồm danh sách các bước thực hiện có cấu trúc cho tác vụ coding phức tạp.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        tasks: {
          type: Type.ARRAY,
          description: 'Danh sách các nhiệm vụ cụ thể theo thứ tự thực hiện.',
          items: {
            type: Type.OBJECT,
            properties: {
              id: {
                type: Type.NUMBER,
                description: 'Số thứ tự của bước (1, 2, 3,...)',
              },
              title: {
                type: Type.STRING,
                description: 'Tiêu đề ngắn gọn mô tả bước này (vd: "Phân tích file bug", "Viết Unit Test", "Sửa code", "Chạy npm test")',
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
          error: 'Tham số "tasks" phải là một mảng danh sách các nhiệm vụ.',
          errorCode: 'INVALID_ARGS',
        };
      }

      const normalized = normalizePlanTasks(args.tasks);
      if (!normalized.tasks) {
        return { error: normalized.error, errorCode: 'INVALID_ARGS' };
      }

      const tasks = planManager.createPlan(normalized.tasks);
      return {
        message: `Đã khởi tạo kế hoạch thành công gồm ${tasks.length} bước.`,
        tasks,
      };
    },
  };
}

/**
 * Tool: update_plan_task
 * Cho phép LLM cập nhật tiến độ từng bước
 */
export function createUpdatePlanTaskTool(planManager: PlanManager): ToolDefinition {
  return {
    name: 'update_plan_task',
    description: 'Cập nhật trạng thái của một bước trong kế hoạch (PENDING, IN_PROGRESS, COMPLETED, FAILED, SKIPPED).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: {
          type: Type.NUMBER,
          description: 'ID số thứ tự của bước cần cập nhật.',
        },
        status: {
          type: Type.STRING,
          description: 'Trạng thái mới: "COMPLETED", "IN_PROGRESS", "FAILED", "SKIPPED".',
        },
        notes: {
          type: Type.STRING,
          description: 'Ghi chú bổ sung hoặc kết quả đạt được sau bước này.',
        },
      },
      required: ['id', 'status'],
    },
    async execute(args) {
      const id = Number(args.id);
      const status = String(args.status).toUpperCase() as TaskStatus;
      const updated = planManager.updateTask(id, status, args.notes);
      if (!updated) {
        return { error: `Không tìm thấy bước với ID = ${id} trong kế hoạch.` };
      }
      return {
        message: `Đã cập nhật bước #${id} sang trạng thái "${status}".`,
        task: updated,
        progress: planManager.getProgress(),
      };
    },
  };
}
