import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { PlanManager, TaskStatus } from '../agent/plan-manager.js';

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
        return { error: 'Tham số "tasks" phải là một mảng danh sách các nhiệm vụ.' };
      }
      const tasks = planManager.createPlan(args.tasks);
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
