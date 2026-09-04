import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { ToolRegistry } from './registry.js';

/**
 * createDiscoverToolsTool - Meta-tool cho phép Agent khám phá các công cụ có sẵn trong hệ thống
 * theo nguyên lý Progressive Disclosure.
 */
export function createDiscoverToolsTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'discover_tools',
    description: 'Search and discover available tools in the registry by keyword or category when a specific capability is needed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Keyword or intent to search for tools (e.g. "git commit", "memory", "subagent", "search code").',
        },
        category: {
          type: Type.STRING,
          description: 'Optional category filter: filesystem, search, shell, planning, memory, subagent, repomix, git, approval, review.',
        },
      },
      required: ['query'],
    },
    async execute(args: Record<string, any>) {
      const query = String(args.query || '').trim().toLowerCase();
      const category = args.category ? String(args.category).toLowerCase() : undefined;

      // Nạp động công cụ Game/Unity nếu Agent tìm kiếm khả năng này
      if (
        query.includes('game') || query.includes('unity') || query.includes('tilemap') ||
        query.includes('sprite') || query.includes('physics') || query.includes('prefab') ||
        category?.includes('game')
      ) {
        if (typeof (registry as any).registerGameTools === 'function') {
          (registry as any).registerGameTools();
        }
      }

      const allTools = registry.getAll();

      const matched = allTools.filter((t) => {
        const matchesCategory = !category || t.name.toLowerCase().includes(category) || t.description.toLowerCase().includes(category);
        const matchesQuery = !query || t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query);
        return matchesCategory && matchesQuery;
      });

      return {
        query: args.query,
        matchedCount: matched.length,
        tools: matched.map((t) => ({
          name: t.name,
          description: t.description,
          parameterNames: Object.keys(t.parameters?.properties || {}),
        })),
        hint: 'Mention the desired tool name in your next thought/action to prioritize its retrieval.',
      };
    },
  };
}