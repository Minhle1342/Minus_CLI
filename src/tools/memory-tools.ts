import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';

/**
 * Tool: save_memory
 * Cho phép LLM ghi lại các kinh nghiệm, cấu trúc hoặc quy ước quan trọng vào bộ nhớ dài hạn của Repo
 */
export function createSaveMemoryTool(memoryManager: ProjectMemoryManager): ToolDefinition {
  return {
    name: 'save_memory',
    description: 'Lưu một thông tin, kinh nghiệm hoặc quy ước quan trọng vào bộ nhớ dài hạn của dự án (.codingagent/project-memory.json).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Từ khoá định danh cho kiến thức này (vd: "test_framework", "coding_style", "build_gotcha")',
        },
        insight: {
          type: Type.STRING,
          description: 'Nội dung chi tiết của kinh nghiệm hoặc quy ước cần ghi nhớ cho các lần chạy sau.',
        },
        category: {
          type: Type.STRING,
          description: 'Phân loại: "convention", "architecture", "gotcha", "rule".',
          enum: ['convention', 'architecture', 'gotcha', 'rule', 'insight'],
        },
        scope: {
          type: Type.STRING,
          description: 'Phạm vi: project (mặc định), session, hoặc goal.',
          enum: ['project', 'session', 'goal'],
        },
        confidence: {
          type: Type.NUMBER,
          description: 'Độ tin cậy từ 0 đến 1. Memory do model tạo mặc định 0.5 và chỉ được tự động inject khi đủ ngưỡng.',
          minimum: 0,
          maximum: 1,
        },
        goalId: {
          type: Type.STRING,
          description: 'ID durable goal nếu memory thuộc scope goal.',
        },
        expiresAt: {
          type: Type.STRING,
          description: 'Thời điểm hết hạn ISO-8601 tùy chọn. Memory do model tạo mặc định hết hạn sau 30 ngày.',
        },
      },
      required: ['key', 'insight'],
    },
    async execute(args) {
      const key = String(args.key || '').trim();
      const insight = String(args.insight || '').trim();
      const category = args.category || 'convention';

      if (!key || !insight) {
        return { error: 'Tham số "key" và "insight" là bắt buộc.' };
      }

      const saved = await memoryManager.saveInsight(key, insight, category, {
        scope: args.scope || 'project',
        confidence: args.confidence,
        goalId: args.goalId,
        expiresAt: args.expiresAt,
        source: 'model',
      });
      return {
        message: `Đã lưu kiến thức "${key}" vào Bộ nhớ dài hạn thành công.`,
        saved,
      };
    },
  };
}

/**
 * Tool: read_memory
 * Cho phép LLM đọc toàn bộ hoặc truy vấn bộ nhớ dài hạn của Repo
 */
export function createReadMemoryTool(memoryManager: ProjectMemoryManager): ToolDefinition {
  return {
    name: 'read_memory',
    description: 'Đọc thông tin tổng quan về kiến trúc, scripts, và các kinh nghiệm đã ghi nhớ từ bộ nhớ dài hạn của dự án.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Từ khoá tìm kiếm tuỳ chọn để lọc kinh nghiệm đã lưu.',
        },
        scope: {
          type: Type.STRING,
          description: 'Lọc theo project, session, goal; bỏ trống để tìm tất cả scope.',
          enum: ['project', 'session', 'goal'],
        },
        limit: {
          type: Type.NUMBER,
          description: 'Số memory tối đa trả về (mặc định 8).',
          minimum: 1,
          maximum: 100,
        },
        minConfidence: {
          type: Type.NUMBER,
          description: 'Ngưỡng độ tin cậy tối thiểu từ 0 đến 1.',
          minimum: 0,
          maximum: 1,
        },
        includeContested: {
          type: Type.BOOLEAN,
          description: 'Chỉ bật khi cần audit các memory đang tranh chấp; mặc định false.',
        },
        includeExpired: {
          type: Type.BOOLEAN,
          description: 'Chỉ bật khi cần audit memory đã hết hạn; mặc định false.',
        },
      },
    },
    async execute(args) {
      const data = memoryManager.getMemoryData();
      const query = String(args.query || '').toLowerCase().trim();
      const scope = args.scope ? String(args.scope) : undefined;
      const records = memoryManager.retrieve(query, {
        scopes: scope ? [scope as any] : undefined,
        limit: Number(args.limit) || 8,
        minConfidence: args.minConfidence === undefined ? undefined : Number(args.minConfidence),
        includeContested: args.includeContested === true,
        includeExpired: args.includeExpired === true,
      });

      return {
        projectName: data.projectName,
        projectType: data.projectType,
        scripts: data.scripts,
        keyDirectories: data.keyDirectories,
        codingConventions: data.codingConventions,
        learnedInsights: records.filter((item) => item.scope === 'project'),
        memories: records,
        digest: memoryManager.getProjectDigest(),
      };
    },
  };
}
