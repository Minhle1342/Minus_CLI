import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { ToolRegistry } from './registry.js';

export interface ToolBundleInfo {
  bundleName: string;
  description: string;
  recommendedTools: string[];
  dependencyChain: string;
}

/**
 * Danh bạ Đồ thị Phụ thuộc Công cụ (Tool Dependency Graph / Bundles)
 * Cung cấp "Information Scent" để LLM nắm bắt được chuỗi công cụ tiền đề và kế thừa.
 */
export const TOOL_DEPENDENCY_BUNDLES: Record<string, ToolBundleInfo> = {
  inspection: {
    bundleName: 'Codebase Inspection & Architecture',
    description: 'Khảo sát cấu trúc codebase, phụ thuộc symbol và luồng thực thi',
    recommendedTools: ['search_codebase_fast', 'get_symbol_context_360', 'query_call_graph', 'get_route_map', 'read_file'],
    dependencyChain: 'search_codebase_fast -> get_symbol_context_360 -> query_call_graph -> read_file',
  },
  mutation: {
    bundleName: 'Surgical Mutation & Verification',
    description: 'Chỉnh sửa mã nguồn chính xác theo dải dòng/hash và kiểm chứng chẩn đoán',
    recommendedTools: ['read_file', 'replace_text', 'apply_patch', 'get_diagnostics'],
    dependencyChain: 'read_file (xác nhận hash/dòng) -> replace_text / apply_patch -> get_diagnostics',
  },
  planning: {
    bundleName: 'DAG Task Planning & Milestone Tracking',
    description: 'Lập kế hoạch phân rã dạng DAG, quản lý tiến độ và chốt nghiệm thu',
    recommendedTools: ['create_plan', 'update_plan_task', 'submit_solution'],
    dependencyChain: 'create_plan(dependsOn) -> update_plan_task(in_progress -> done) -> submit_solution',
  },
  multi_agent: {
    bundleName: 'Multi-Agent Subagent Delegation',
    description: 'Phối hợp đa agent phân tán, bộ nhớ chia sẻ và giao tiếp sự kiện',
    recommendedTools: ['brainstorm_design', 'allocate_agent_task', 'create_read_shared_context', 'create_write_shared_context', 'create_publish_agent_event'],
    dependencyChain: 'brainstorm_design -> allocate_agent_task -> write_shared_context',
  },
  game_development: {
    bundleName: 'Game 2D, Pixel Art & Unity Engine',
    description: 'Thiết kế tilemap, pixel sprite, physics 2D và kịch bản gameplay Unity',
    recommendedTools: ['game_tilemap_studio', 'game_pixel_sprite_studio', 'game_2d_physics_config', 'game_scaffold_engine', 'unity_gameplay_studio'],
    dependencyChain: 'game_scaffold_engine -> game_tilemap_studio -> unity_gameplay_studio',
  },
  process_task: {
    bundleName: 'Background Tasks & Timers',
    description: 'Chạy tiến trình terminal, giám sát daemon ngầm và hẹn giờ sự kiện',
    recommendedTools: ['run_command', 'manage_task', 'schedule'],
    dependencyChain: 'run_command(WaitMsBeforeAsync=5000) -> manage_task / schedule',
  },
};

/**
 * createDiscoverToolsTool - Meta-tool cho phép Agent khám phá các công cụ có sẵn trong hệ thống
 * theo nguyên lý Progressive Disclosure thế hệ mới kết hợp Tool Dependency Bundles.
 */
export function createDiscoverToolsTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'discover_tools',
    description: 'Search and discover available tools in the registry by keyword or category when a specific capability is needed. Returns tools and their prerequisite dependency chains.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Keyword or intent to search for tools (e.g. "git commit", "memory", "subagent", "search code", "plan").',
        },
        category: {
          type: Type.STRING,
          description: 'Optional category filter: filesystem, search, shell, planning, memory, subagent, repomix, git, approval, review, game.',
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
          await (registry as any).registerGameTools();
        }
      }

      const allTools = registry.getAll();

      const matched = allTools.filter((t) => {
        const matchesCategory = !category || t.name.toLowerCase().includes(category) || t.description.toLowerCase().includes(category);
        const matchesQuery = !query || t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query);
        return matchesCategory && matchesQuery;
      });

      // Nhận diện các Tool Dependency Bundles liên quan (Information Scent)
      const matchedBundles: ToolBundleInfo[] = [];
      for (const [key, bundle] of Object.entries(TOOL_DEPENDENCY_BUNDLES)) {
        const matchesKey = key.includes(query) || query.includes(key);
        const matchesCategory = category ? (key.includes(category) || category.includes(key)) : false;
        const matchesTool = bundle.recommendedTools.some((rt) => rt.includes(query) || query.includes(rt) || matched.some((m) => m.name === rt));
        if (matchesKey || matchesCategory || matchesTool) {
          matchedBundles.push(bundle);
        }
      }

      return {
        query: args.query,
        matchedCount: matched.length,
        tools: matched.map((t) => ({
          name: t.name,
          description: t.description,
          parameterNames: Object.keys(t.parameters?.properties || {}),
        })),
        suggestedBundles: matchedBundles.length > 0 ? matchedBundles : undefined,
        hint: 'Mention the desired tool name in your next thought/action to prioritize its retrieval. Follow the suggested dependency chains for multi-step workflows.',
      };
    },
  };
}