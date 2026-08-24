import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { SharedContextService } from '../agent/shared-context-service.js';

/**
 * Tool: read_shared_context
 * Đọc dữ liệu từ Blackboard Memory chia sẻ giữa các Agent
 */
export function createReadSharedContextTool(sharedContext: SharedContextService): ToolDefinition {
  return {
    name: 'read_shared_context',
    description: 'Đọc dữ liệu từ bộ nhớ chia sẻ chung (Shared Blackboard Context) giữa các Subagents hoặc liệt kê toàn bộ keys kèm versionHash.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Khóa cần đọc trong shared context. Nếu để trống, trả về danh sách toàn bộ các keys có sẵn.',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const key = args.key ? String(args.key).trim() : undefined;

      if (!key) {
        const keys = sharedContext.listKeys();
        const entries = keys.map((k) => sharedContext.get(k));
        return {
          success: true,
          count: keys.length,
          keys,
          entries,
        };
      }

      const entry = sharedContext.get(key);
      if (!entry) {
        return {
          success: false,
          key,
          error: `Không tìm thấy key '${key}' trong shared context.`,
        };
      }

      return {
        success: true,
        entry,
      };
    },
  };
}

/**
 * Tool: write_shared_context
 * Ghi hoặc cập nhật dữ liệu vào Blackboard Memory với Khóa Lạc Quan (OCC)
 */
export function createWriteSharedContextTool(sharedContext: SharedContextService): ToolDefinition {
  return {
    name: 'write_shared_context',
    description: 'Ghi hoặc cập nhật dữ liệu vào bộ nhớ chia sẻ chung (Shared Blackboard) giữa các agents với cơ chế Optimistic Concurrency Control (OCC) chống xung đột ghi đè.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Khóa dữ liệu cần lưu (ví dụ: "api_contracts", "design_tokens", "backend_endpoints").',
        },
        value: {
          type: Type.STRING,
          description: 'Dữ liệu cần lưu (chuỗi hoặc JSON stringified).',
        },
        agentId: {
          type: Type.STRING,
          description: 'Định danh của Agent thực hiện ghi (mặc định: "agent").',
        },
        expectedVersionHash: {
          type: Type.STRING,
          description: 'Mã băm phiên bản kỳ vọng (OCC versionHash) để đảm bảo không bị Agent khác ghi đè giữa chừng.',
        },
      },
      required: ['key', 'value'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const key = String(args.key || '').trim();
      const rawValue = args.value;
      const agentId = String(args.agentId || 'agent').trim();
      const expectedVersionHash = args.expectedVersionHash ? String(args.expectedVersionHash).trim() : undefined;

      if (!key) {
        return { error: 'Tham số "key" là bắt buộc.' };
      }
      if (rawValue === undefined) {
        return { error: 'Tham số "value" là bắt buộc.' };
      }

      let parsedValue: any = rawValue;
      if (typeof rawValue === 'string') {
        try {
          parsedValue = JSON.parse(rawValue);
        } catch {
          parsedValue = rawValue;
        }
      }

      try {
        const entry = sharedContext.set(key, parsedValue, agentId, expectedVersionHash);
        return {
          success: true,
          message: `Đã ghi thành công key '${key}' vào shared context.`,
          entry,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          conflict: err.message.includes('Optimistic concurrency conflict'),
        };
      }
    },
  };
}
