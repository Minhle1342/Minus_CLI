import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { ToolRegistry, MODEL_HIDDEN_TOOL_NAMES } from './registry.js';

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
  filesystem: {
    bundleName: 'File Management & File System',
    description: 'Inspect directories, read files, and create/move/delete workspace files safely',
    recommendedTools: ['list_files', 'read_file', 'create_file', 'write_file', 'move_file', 'delete_file'],
    dependencyChain: 'list_files -> read_file -> create_file / write_file -> list_files (verify)',
  },
  inspection: {
    bundleName: 'Codebase Inspection & Architecture',
    description: 'Survey codebase structure, symbol dependencies, call graph, and execution flow',
    recommendedTools: [
      'search_codebase_fast',
      'search_text',
      'get_symbol_context_360',
      'inspect_symbol',
      'find_references',
      'query_call_graph',
      'get_route_map',
      'lsp_query',
      'analyze_impact',
      'get_architecture_topology',
      'read_compressed_code',
      'read_file',
    ],
    dependencyChain: 'search_codebase_fast -> get_symbol_context_360 -> lsp_query / query_call_graph -> read_file',
  },
  mutation: {
    bundleName: 'Surgical Mutation & Verification',
    description: 'Precise source edits by line-range/hash with diagnostic and compiler verification',
    recommendedTools: ['read_file', 'replace_text', 'apply_patch', 'verify_edit', 'get_diagnostics'],
    dependencyChain: 'read_file (confirm content/lines) -> replace_text / apply_patch -> verify_edit -> get_diagnostics',
  },
  planning: {
    bundleName: 'DAG Task Planning & Milestone Tracking',
    description: 'DAG-style plan decomposition, progress tracking and acceptance sign-off',
    recommendedTools: ['create_plan', 'update_plan_task', 'submit_solution'],
    dependencyChain: 'create_plan(dependsOn) -> update_plan_task(in_progress -> done) -> submit_solution',
  },
  hypothesis_testing: {
    bundleName: 'Active Hypothesis Verification & Phase Transition',
    description: 'Formulate falsifiable root-cause hypotheses, reproduce isolated failures, and transition phases',
    recommendedTools: ['formulate_and_verify_hypothesis', 'request_phase_transition', 'submit_solution'],
    dependencyChain: 'formulate_and_verify_hypothesis(falsificationTest) -> run_command (reproduce) -> request_phase_transition -> submit_solution',
  },
  memory: {
    bundleName: 'Project & Repository Memory',
    description: 'Persist architectural decisions, lessons learned, and recall cited knowledge items',
    recommendedTools: ['read_memory', 'save_memory', 'recall_repository_memory', 'save_repository_memory', 'verify_repository_memory'],
    dependencyChain: 'read_memory / recall_repository_memory -> verify_repository_memory -> save_memory / save_repository_memory',
  },
  multi_agent: {
    bundleName: 'Multi-Agent Subagent Delegation & Coordination',
    description: 'Distributed multi-agent coordination, structured peer review, shared blackboard memory and event messaging',
    recommendedTools: [
      'brainstorm_design',
      'allocate_agent_task',
      'verify_subagent_quality',
      'schedule_dag_parallel',
      'read_shared_context',
      'write_shared_context',
      'publish_agent_event',
    ],
    dependencyChain: 'brainstorm_design -> allocate_agent_task -> write_shared_context / publish_agent_event -> verify_subagent_quality',
  },
  process_task: {
    bundleName: 'Terminal Processes, Scripts & Scheduled Tasks',
    description: 'Run terminal processes, execute Node.js scripts, monitor background daemons and schedule events',
    recommendedTools: ['run_command', 'run_node_script', 'manage_task', 'schedule'],
    dependencyChain: 'run_command / run_node_script (WaitMsBeforeAsync) -> manage_task / schedule',
  },
  web_research: {
    bundleName: 'Web Research & Documentation Retrieval',
    description: 'Perform web search and fetch remote web pages / documentation directly into context',
    recommendedTools: ['web_search', 'web_fetch'],
    dependencyChain: 'web_search -> web_fetch',
  },
  vision: {
    bundleName: 'Multimodal Vision & Asset Generation',
    description: 'Inspect visual assets/screenshots and generate interface UI mockups or graphic assets',
    recommendedTools: ['inspect_image', 'generate_image'],
    dependencyChain: 'inspect_image -> generate_image',
  },
  computer: {
    bundleName: 'GUI & Computer Desktop Automation',
    description: 'Interact with desktop environment via keyboard, mouse, screenshot, and application control',
    recommendedTools: ['computer'],
    dependencyChain: 'computer(action="screenshot") -> computer(action="mouse_move" / "click" / "type")',
  },
  game_development: {
    bundleName: 'Game 2D, Pixel Art & Unity Engine',
    description: '2D tilemap design, pixel sprites, 2D physics and Unity gameplay scripting',
    recommendedTools: ['game_tilemap_studio', 'game_pixel_sprite_studio', 'game_2d_physics_config', 'game_scaffold_engine', 'unity_gameplay_studio'],
    dependencyChain: 'game_scaffold_engine -> game_tilemap_studio -> unity_gameplay_studio',
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
          description: 'Keyword or intent to search for tools (e.g. "git commit", "memory", "subagent", "search code", "plan", "web search", "image").',
        },
        category: {
          type: Type.STRING,
          description: 'Optional category filter: filesystem, search, mutation, inspection, shell, planning, hypothesis, memory, subagent, web, vision, computer, game.',
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

      // Chỉ lấy các công cụ hiển thị cho mô hình LLM, loại trừ MODEL_HIDDEN_TOOL_NAMES
      const allTools = registry.getAll();
      const visibleTools = allTools.filter((t) => !MODEL_HIDDEN_TOOL_NAMES.has(t.name));

      const matched = visibleTools.filter((t) => {
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
          matchedBundles.push({
            ...bundle,
            recommendedTools: bundle.recommendedTools.filter((name) => !MODEL_HIDDEN_TOOL_NAMES.has(name)),
          });
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