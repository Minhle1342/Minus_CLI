import MiniSearch from 'minisearch';
import type { FunctionDeclaration } from '@google/genai';
import { ToolDefinition } from './types.js';

export interface ToolDocument {
  id: string;
  name: string;
  category: string;
  tags: string;
  description: string;
  parameters: string;
}

export interface ToolRetrieverConfig {
  /** Bật/tắt Dynamic Tool Retrieval (mặc định: true) */
  enabled?: boolean;
  /** Ngưỡng số lượng tool tối thiểu trong registry để kích hoạt retrieval (mặc định: 7) */
  activationThreshold?: number;
  /** Số lượng dynamic tools tối đa được chọn thêm theo query (mặc định: 5) */
  topK?: number;
  /** Tập hợp các Core Anchor Tools luôn luôn có mặt trong mọi lượt gọi (mặc định: 4 tools cốt lõi) */
  alwaysInclude?: string[];
  /** Điểm số tương đồng tối thiểu để đưa tool vào danh sách (mặc định: 0.05) */
  minScore?: number;
}

/**
 * ToolRetriever - Dynamic Tool Retrieval (RATS) Engine
 * 
 * Giải quyết triệt để vấn đề "Tool Dilution" và "Lost in the middle" khi số lượng tool tăng cao:
 * 1. Đánh chỉ mục BM25 / Fuzzy Search in-memory cho toàn bộ tool schemas.
 * 2. Bảo toàn bộ Core Anchor Tools cốt lõi (read_file, replace_text, write_file, run_command).
 * 3. Truy xuất động Top-K tool phù hợp nhất với task/ngữ cảnh hiện tại của từng bước lặp.
 * 4. Áp dụng KV-Cache Prefix Alignment: Luôn sắp xếp cố định theo tên để tối đa hóa Cache Hit Rate.
 */
export class ToolRetriever {
  private miniSearch: MiniSearch<ToolDocument>;
  private toolsMap = new Map<string, ToolDefinition>();
  private config: Required<ToolRetrieverConfig>;

  constructor(config?: ToolRetrieverConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      activationThreshold: config?.activationThreshold ?? 7,
      topK: config?.topK ?? 5,
      alwaysInclude: config?.alwaysInclude ?? [
        'read_file',
        'list_files',
        'apply_patch',
        'replace_text',
        'write_file',
        'run_command',
        'get_symbol_context_360',
        'get_diagnostics',
      ],
      minScore: config?.minScore ?? 0.05,
    };

    this.miniSearch = new MiniSearch<ToolDocument>({
      fields: ['name', 'category', 'tags', 'description', 'parameters'],
      storeFields: ['id', 'name', 'category', 'description'],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        boost: { name: 4, category: 3, tags: 2.5, description: 1.5, parameters: 1 },
      },
    });
  }

  /**
   * Đồng bộ và tái lập chỉ mục cho danh sách tools
   */
  indexTools(tools: ToolDefinition[]): void {
    this.miniSearch.removeAll();
    this.toolsMap.clear();

    const docs: ToolDocument[] = [];
    for (const tool of tools) {
      this.toolsMap.set(tool.name, tool);
      const category = this.inferCategory(tool);
      const tags = this.inferTags(tool);
      const paramNames = Object.keys(tool.parameters?.properties || {}).join(' ');
      const paramDescriptions = Object.values(tool.parameters?.properties || {})
        .map((p: any) => p.description || '')
        .join(' ');

      docs.push({
        id: tool.name,
        name: tool.name,
        category,
        tags,
        description: tool.description || '',
        parameters: `${paramNames} ${paramDescriptions}`,
      });
    }

    if (docs.length > 0) {
      this.miniSearch.addAll(docs);
    }
  }

  /**
   * Truy xuất động danh sách FunctionDeclaration phù hợp nhất với ngữ cảnh
   */
  retrieve(query: string, allTools?: ToolDefinition[]): FunctionDeclaration[] {
    const pool = allTools || Array.from(this.toolsMap.values());
    const poolMap = new Map(pool.map((tool) => [tool.name, tool]));

    // Nếu tắt Dynamic Retrieval hoặc tổng số tool chưa vượt ngưỡng -> Trả về toàn bộ
    if (!this.config.enabled || pool.length <= this.config.activationThreshold) {
      return this.formatDeclarations(pool);
    }

    const selectedToolNames = new Set<string>();

    // 1. Luôn bảo lưu các Core Anchor Tools
    for (const anchor of this.config.alwaysInclude) {
      if (poolMap.has(anchor)) {
        selectedToolNames.add(anchor);
      }
    }

    // 2. Tìm kiếm các tool phù hợp theo BM25 / Fuzzy matching
    const cleanedQuery = (query || '').trim();
    if (cleanedQuery.length > 0) {
      try {
        const searchHits = this.miniSearch.search(cleanedQuery);
        let dynamicAdded = 0;
        for (const hit of searchHits) {
          if (dynamicAdded >= this.config.topK) break;
          if (hit.score >= this.config.minScore && poolMap.has(hit.id)) {
            if (!selectedToolNames.has(hit.id)) {
              selectedToolNames.add(hit.id);
              dynamicAdded++;
            }
          }
        }
      } catch {
        // Fallback an toàn nếu query chứa ký tự regex đặc biệt
      }
    }

    // 3. Fallback an toàn: Nếu số lượng tool được chọn quá ít, bổ sung các tool phổ biến
    if (selectedToolNames.size <= this.config.alwaysInclude.length) {
      for (const tool of pool) {
        if (selectedToolNames.size >= this.config.alwaysInclude.length + this.config.topK) break;
        selectedToolNames.add(tool.name);
      }
    }

    const retrievedTools = Array.from(selectedToolNames)
      .map((name) => poolMap.get(name))
      .filter((t): t is ToolDefinition => Boolean(t));

    return this.formatDeclarations(retrievedTools);
  }

  configure(config: Partial<ToolRetrieverConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): Readonly<Required<ToolRetrieverConfig>> {
    return { ...this.config };
  }

  private formatDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
    // KV-Cache Prefix Alignment: Sắp xếp cố định theo tên 100%
    return tools
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  private inferCategory(tool: ToolDefinition): string {
    const name = tool.name.toLowerCase();
    if (name.includes('lsp') || name.includes('call_graph') || name.includes('route_map') || name.includes('context_360') || name.includes('topology') || name.includes('symbol') || name.includes('reference') || name.includes('diagnostic')) return 'code_intelligence';
    if (name.includes('shared_context') || name.includes('agent_event') || name.includes('subagent') || name.includes('delegate') || name.includes('spawn')) return 'multi_agent';
    if (name.includes('manage_task') || name.includes('schedule') || name.includes('command') || name.includes('sandbox') || name.includes('exec')) return 'process_task';
    if (name.includes('web') || name.includes('fetch') || name.includes('url')) return 'network';
    if (name.includes('file') || name.includes('dir') || name.includes('text') || name.includes('patch')) return 'filesystem_mutation';
    if (name.includes('search') || name.includes('codebase') || name.includes('find')) return 'search';
    if (name.includes('plan') || name.includes('task')) return 'planning';
    if (name.includes('memory') || name.includes('digest')) return 'memory';
    if (name.includes('repomix') || name.includes('pack') || name.includes('compress')) return 'repomix';
    if (name.includes('git') || name.includes('commit') || name.includes('push') || name.includes('diff')) return 'git';
    if (name.includes('approval')) return 'approval';
    if (name.includes('review')) return 'review';
    return 'general';
  }

  private inferTags(tool: ToolDefinition): string {
    const tags = new Set<string>();
    const text = `${tool.name} ${tool.description}`.toLowerCase();

    if (text.includes('call_graph') || text.includes('callers') || text.includes('callees') || text.includes('hierarchy') || text.includes('trace')) {
      tags.add('call graph callers callees hierarchy execution flow trace');
    }
    if (text.includes('route') || text.includes('endpoint') || text.includes('controller') || text.includes('express') || text.includes('api')) {
      tags.add('route endpoint api router controller handlers middleware');
    }
    if (text.includes('topology') || text.includes('architecture') || text.includes('layers') || text.includes('circular') || text.includes('cycle')) {
      tags.add('architecture topology layers dependencies circular dependency matrix');
    }
    if (text.includes('360') || text.includes('panorama') || text.includes('symbol')) {
      tags.add('symbol context 360 panorama definition callers callees tests');
    }
    if (text.includes('lsp') || text.includes('language server')) {
      tags.add('lsp language server hover definition references diagnostics implementation call hierarchy');
    }
    if (text.includes('schedule') || text.includes('timer') || text.includes('cron') || text.includes('watchdog')) {
      tags.add('schedule timer cron delay watchdog wakeup recurring');
    }
    if (text.includes('task') || text.includes('background') || text.includes('stdin') || text.includes('interactive') || text.includes('send_input')) {
      tags.add('task background process pid kill stdin send_input repl');
    }
    if (text.includes('shared_context') || text.includes('blackboard') || text.includes('occ') || text.includes('versionhash')) {
      tags.add('shared context blackboard state occ concurrency lock');
    }
    if (text.includes('event') || text.includes('topic') || text.includes('publish') || text.includes('broadcast')) {
      tags.add('event bus pub sub topic broadcast messaging');
    }
    if (text.includes('web') || text.includes('fetch') || text.includes('url') || text.includes('scrape') || text.includes('searxng') || text.includes('online')) {
      tags.add('web fetch url browse search online internet research documentation issue');
    }
    if (text.includes('read') || text.includes('view') || text.includes('inspect') || text.includes('list')) {
      tags.add('read inspect explore view list');
    }
    if (text.includes('write') || text.includes('create') || text.includes('edit') || text.includes('replace')) {
      tags.add('edit modify write replace create');
    }
    if (text.includes('test') || text.includes('verify') || text.includes('build') || text.includes('run') || text.includes('command')) {
      tags.add('test verify compile execute run shell');
    }
    if (text.includes('search') || text.includes('find') || text.includes('locate') || text.includes('grep') || text.includes('query')) {
      tags.add('search find query locate fast');
    }
    if (text.includes('git') || text.includes('branch') || text.includes('commit') || text.includes('diff') || text.includes('stage')) {
      tags.add('git vcs source-control status diff');
    }
    if (text.includes('compress') || text.includes('pack') || text.includes('token') || text.includes('repomix')) {
      tags.add('compress pack repomix codebase token');
    }
    if (text.includes('memory') || text.includes('knowledge') || text.includes('lesson')) {
      tags.add('memory knowledge context lesson save retrieve');
    }
    if (text.includes('subagent') || text.includes('delegate') || text.includes('parallel') || text.includes('agent')) {
      tags.add('subagent delegate multi-agent background parallel');
    }

    return Array.from(tags).join(' ');
  }
}
