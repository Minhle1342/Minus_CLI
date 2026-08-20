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

      const saved = await memoryManager.saveInsight(key, insight, category);
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
      },
    },
    async execute(args) {
      const data = memoryManager.getMemoryData();
      const query = String(args.query || '').toLowerCase().trim();

      let filteredInsights = data.learnedInsights;
      if (query) {
        filteredInsights = data.learnedInsights.filter(
          (i) => i.key.toLowerCase().includes(query) || i.insight.toLowerCase().includes(query)
        );
      }

      return {
        projectName: data.projectName,
        projectType: data.projectType,
        scripts: data.scripts,
        keyDirectories: data.keyDirectories,
        codingConventions: data.codingConventions,
        learnedInsights: filteredInsights,
        digest: memoryManager.getProjectDigest(),
      };
    },
  };
}
