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
    description: 'Save an important piece of information, lesson or convention to the project long-term memory (.codingagent/project-memory.json).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Identifying keyword for this knowledge (e.g. "test_framework", "coding_style", "build_gotcha")',
        },
        insight: {
          type: Type.STRING,
          description: 'Detailed content of the lesson or convention to remember for future runs.',
        },
        category: {
          type: Type.STRING,
          description: 'Category: "convention", "architecture", "gotcha", "rule", "insight", "episodic".',
          enum: ['convention', 'architecture', 'gotcha', 'rule', 'insight', 'episodic'],
        },
        scope: {
          type: Type.STRING,
          description: 'Scope: project (default), session, or goal.',
          enum: ['project', 'session', 'goal'],
        },
        confidence: {
          type: Type.NUMBER,
          description: 'Confidence from 0 to 1. Model-created memories default to 0.5 and are only auto-injected above threshold.',
          minimum: 0,
          maximum: 1,
        },
        goalId: {
          type: Type.STRING,
          description: 'Durable goal ID if the memory belongs to a goal scope.',
        },
        expiresAt: {
          type: Type.STRING,
          description: 'Optional ISO-8601 expiry time. Model-created memories expire after 30 days by default.',
        },
      },
      required: ['key', 'insight'],
    },
    async execute(args) {
      const key = String(args.key || '').trim();
      const insight = String(args.insight || '').trim();
      const category = args.category || 'convention';

      if (!key || !insight) {
        return { error: 'The "key" and "insight" parameters are required.' };
      }

      const saved = await memoryManager.saveInsight(key, insight, category, {
        scope: args.scope || 'project',
        confidence: args.confidence,
        goalId: args.goalId,
        expiresAt: args.expiresAt,
        source: 'model',
      });
      return {
        message: `Saved knowledge "${key}" to Long-term Memory successfully.`,
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
    description: 'Read the project overview of architecture, scripts, and recorded lessons from the project long-term memory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Optional search keyword to filter saved lessons.',
        },
        scope: {
          type: Type.STRING,
          description: 'Filter by project, session, goal; leave empty to search all scopes.',
          enum: ['project', 'session', 'goal'],
        },
        limit: {
          type: Type.NUMBER,
          description: 'Maximum number of memories to return (default 8).',
          minimum: 1,
          maximum: 100,
        },
        minConfidence: {
          type: Type.NUMBER,
          description: 'Minimum confidence threshold from 0 to 1.',
          minimum: 0,
          maximum: 1,
        },
        includeContested: {
          type: Type.BOOLEAN,
          description: 'Enable only when auditing contested memories; default false.',
        },
        includeExpired: {
          type: Type.BOOLEAN,
          description: 'Enable only when auditing expired memories; default false.',
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
