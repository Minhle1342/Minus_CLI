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
        },
        scope: {
          type: Type.STRING,
          description: 'Phạm vi: project (mặc định), session, hoặc goal.',
        },
        confidence: {
          type: Type.NUMBER,
          description: 'Độ tin cậy từ 0 đến 1 (mặc định 1).',
        },
        goalId: {
          type: Type.STRING,
          description: 'ID durable goal nếu memory thuộc scope goal.',
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
        },
        limit: {
          type: Type.NUMBER,
          description: 'Số memory tối đa trả về (mặc định 8).',
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
