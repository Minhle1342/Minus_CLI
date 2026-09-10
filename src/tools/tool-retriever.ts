import MiniSearch from 'minisearch';
import type { FunctionDeclaration } from '@google/genai';
import { ToolDefinition } from './types.js';
import { getNativeCore } from '../native/index.js';

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
        'read_compressed_code',
        'list_files',
        'apply_patch',
        'replace_text',
        'write_file',
        'run_command',
        'get_symbol_context_360',
        'get_diagnostics',
        'search_codebase_fast',
        'submit_solution',
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

    // 2. Hybrid retrieval: lexical BM25/fuzzy + local semantic candidates.
    // Reciprocal-rank fusion avoids assuming scores from the two retrievers share a scale.
    const cleanedQuery = (query || '').trim();
    if (cleanedQuery.length > 0) {
      try {
        const searchHits = this.miniSearch.search(cleanedQuery);
        const lexicalRank = new Map<string, number>();
        searchHits
          .filter((hit) => hit.score >= this.config.minScore && poolMap.has(hit.id))
          .forEach((hit, index) => lexicalRank.set(hit.id, index + 1));

        const queryTerms = this.semanticTerms(cleanedQuery);
        const native = getNativeCore();
        let queryVector: number[] | undefined;
        if (native && typeof native.rsGenerateSubwordEmbedding === 'function') {
          try { queryVector = native.rsGenerateSubwordEmbedding(cleanedQuery); } catch {}
        }

        const semanticCandidates = pool.map((tool) => {
          const category = this.inferCategory(tool);
          const tags = this.inferTags(tool);
          const text = `${tool.name} ${category} ${tags} ${tool.description || ''} ${Object.keys(tool.parameters?.properties || {}).join(' ')}`;
          const toolTerms = this.semanticTerms(text);
          let semanticScore = this.termOverlap(queryTerms, toolTerms);
          if (queryVector && native && typeof native.rsGenerateSubwordEmbedding === 'function' && typeof native.rsCosineSimilarity === 'function') {
            try {
              const toolVector = native.rsGenerateSubwordEmbedding(text);
              semanticScore = Math.max(semanticScore, Math.max(0, native.rsCosineSimilarity(queryVector, toolVector)));
            } catch {}
          }
          semanticScore += this.hierarchyBoost(cleanedQuery, category, tool.name);
          return { name: tool.name, score: semanticScore };
        }).filter((candidate) => candidate.score > 0)
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

        const semanticRank = new Map<string, number>();
        semanticCandidates.forEach((candidate, index) => semanticRank.set(candidate.name, index + 1));
        const fused = pool
          .map((tool) => {
            const lr = lexicalRank.get(tool.name);
            const sr = semanticRank.get(tool.name);
            const score = (lr ? 1 / (60 + lr) : 0) + (sr ? 1 / (60 + sr) : 0);
            return { name: tool.name, score };
          })
          .filter((candidate) => candidate.score > 0 && !selectedToolNames.has(candidate.name))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

        const topScore = fused[0]?.score || 0;
        const cutoffScore = fused[this.config.topK - 1]?.score || 0;
        const adaptiveExtra = topScore > 0 && cutoffScore > 0 && (topScore - cutoffScore) / topScore < 0.12 ? 2 : 0;
        for (const candidate of fused.slice(0, this.config.topK + adaptiveExtra)) {
          selectedToolNames.add(candidate.name);
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

  private semanticTerms(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    );
  }

  private termOverlap(queryTerms: Set<string>, documentTerms: Set<string>): number {
    if (queryTerms.size === 0 || documentTerms.size === 0) return 0;
    let matched = 0;
    for (const term of queryTerms) {
      if (documentTerms.has(term)) matched++;
    }
    return matched / Math.sqrt(queryTerms.size * documentTerms.size);
  }

  private hierarchyBoost(query: string, category: string, toolName: string): number {
    const q = query.toLowerCase();
    let boost = 0;
    if (/(error|exception|diagnostic|failed|failure)/.test(q) && /diagnostic|inspect|symbol|call_graph/.test(toolName)) boost += 0.18;
    if (/(caller|callee|dependency|impact|symbol|architecture|graph)/.test(q) && category === 'code_intelligence') boost += 0.16;
    if (/(test|verify|build|compile)/.test(q) && /run|diagnostic|test|command/.test(toolName)) boost += 0.14;
    if (/(web|research|paper|documentation|internet)/.test(q) && category === 'network') boost += 0.16;
    if (/(edit|patch|fix|modify|implement)/.test(q) && category === 'filesystem_mutation') boost += 0.10;
    return boost;
  }

  configure(config: Partial<ToolRetrieverConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): Readonly<Required<ToolRetrieverConfig>> {
    return { ...this.config };
  }

  private formatDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
    // KV-Cache Prefix Alignment: Sắp xếp cố định theo tên 100%
    return [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  private inferCategory(tool: ToolDefinition): string {
    const name = tool.name.toLowerCase();
    if (name.includes('computer') || name.includes('desktop') || name.includes('mouse') || name.includes('screen')) return 'computer_use';
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
    if (name.startsWith('game_') || name.startsWith('unity_') || name.includes('tilemap') || name.includes('sprite') || name.includes('physics') || name.includes('prefab') || name.includes('scene')) return 'game_development';
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
    if (text.includes('computer') || text.includes('desktop') || text.includes('mouse') || text.includes('click') || text.includes('keyboard') || text.includes('screenshot') || text.includes('screen') || text.includes('gui')) {
      tags.add('computer use desktop gui screenshot mouse click type keyboard hotkey scroll screen display os');
    }
    if (text.includes('game') || text.includes('tilemap') || text.includes('pixel') || text.includes('sprite') || text.includes('physics') || text.includes('hitbox') || text.includes('jump') || text.includes('fsm') || text.includes('unity') || text.includes('scene') || text.includes('prefab')) {
      tags.add('game development unity editor scene prefab hierarchy component serializedobject wire reference 2d 3d pixel tilemap sprite animation atlas physics hitbox collision jump kinematic fsm state machine godot phaser canvas');
    }

    return Array.from(tags).join(' ');
  }
}
