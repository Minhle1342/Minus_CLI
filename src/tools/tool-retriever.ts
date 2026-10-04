import MiniSearch from 'minisearch';
import type { FunctionDeclaration } from '@google/genai';
import { ToolDefinition } from './types.js';
import { batchSubwordSimilarity } from '../native/semantic-batch.js';
import { ToolTransitionGraph } from './tool-transition-graph.js';
import { LocalCrossEncoderReranker } from './reranker.js';

export interface ToolDocument {
  id: string;
  name: string;
  category: string;
  tags: string;
  description: string;
  parameters: string;
}

export interface ToolCompactStub {
  name: string;
  category: string;
  description: string;
  parameterNames: string[];
}

export interface ToolRetrieverConfig {
  /** Bật/tắt Dynamic Tool Retrieval (mặc định: true) */
  enabled?: boolean;
  /** Ngưỡng số lượng tool tối thiểu trong registry để kích hoạt retrieval (mặc định: 7) */
  activationThreshold?: number;
  /** Số lượng dynamic tools tối đa được chọn thêm theo query (mặc định: 5) */
  topK?: number;
  /** Tập hợp nhỏ các Core Anchor Tools luôn có mặt trong mọi lượt gọi. */
  alwaysInclude?: string[];
  /** Điểm số tương đồng tối thiểu để đưa tool vào danh sách (mặc định: 0.05) */
  minScore?: number;
}

export type ToolRetrievalQueryInput =
  | string
  | {
      query: string;
      denseQuery?: string;
      lexicalQuery?: string;
      lastToolName?: string;
      lastToolResult?: unknown;
      phase?: string;
      /**
       * True khi workspace có `.codegraph/` index. Khi true + query là
       * structural/flow, các tool code-intel trùng lắp bị prune khỏi
       * activePool để `codegraph_explore` làm primary (1 tool mạnh thay
       * menu nhiều tool). Mặc định false = không prune (an toàn khi chưa init).
       */
      codegraphIndexed?: boolean;
    };

/**
 * Tool code-intelligence nội bộ bị `codegraph_explore` thay thế trực tiếp
 * trên query structural/flow (đã có index): cùng trả callers/callees/flow/
 * impact nhưng qua grep/AST loop nhiều call hơn. Giữ lại search_codebase_fast
 * (lexical fallback), read_file (staleness banner + file ngoài index) và
 * get_diagnostics (verify, codegraph không làm).
 */
export const CODEGRAPH_PRUNED_OVERLAP = new Set([
  'inspect_symbol',
  'find_references',
  'lsp_query',
  'query_call_graph',
  'get_route_map',
  'get_symbol_context_360',
  'get_architecture_topology',
  'analyze_impact',
]);

/**
 * ToolRetriever - Dynamic Tool Retrieval (RATS) Engine
 * 
 * Giải quyết triệt để vấn đề "Tool Dilution" và "Lost in the middle" khi số lượng tool tăng cao:
 * 1. Đánh chỉ mục BM25 / Fuzzy Search in-memory cho toàn bộ tool schemas.
 * 2. Bảo toàn một tập Core Anchor nhỏ; capability chuyên biệt được retrieve theo ngữ cảnh.
 * 3. Truy xuất động Top-K tool phù hợp nhất với task/ngữ cảnh hiện tại của từng bước lặp.
 * 4. Tích hợp Tool Transition Graph (ToolNet DAG) để dự đoán công cụ kế tiếp theo xác suất Markov.
 * 5. Áp dụng KV-Cache Prefix Alignment: Luôn sắp xếp cố định theo tên để tối đa hóa Cache Hit Rate.
 */
export class ToolRetriever {
  private miniSearch: MiniSearch<ToolDocument>;
  private toolsMap = new Map<string, ToolDefinition>();
  private config: Required<ToolRetrieverConfig>;
  private transitionGraph = new ToolTransitionGraph();
  private reranker = new LocalCrossEncoderReranker();

  constructor(config?: ToolRetrieverConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      activationThreshold: config?.activationThreshold ?? 7,
      topK: config?.topK ?? 5,
      alwaysInclude: config?.alwaysInclude ?? [
        'read_file',
        'list_files',
        'search_codebase_fast',
        'search_text',
        'codegraph_explore',
        'apply_patch',
        'replace_text',
        'create_file',
        'write_file',
        'run_command',
        'run_node_script',
        'submit_solution',
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
   * Lấy danh mục rút gọn (Compact Tool Stubs) phục vụ Two-Tier Lazy Schema Loading
   */
  getToolCatalogStubs(tools?: ToolDefinition[]): ToolCompactStub[] {
    const pool = tools || Array.from(this.toolsMap.values());
    return pool.map((t) => ({
      name: t.name,
      category: this.inferCategory(t),
      description: t.description || '',
      parameterNames: Object.keys(t.parameters?.properties || {}),
    }));
  }

  /**
   * Getter truy cập ToolTransitionGraph
   */
  getTransitionGraph(): ToolTransitionGraph {
    return this.transitionGraph;
  }

  /**
   * Getter truy cập LocalCrossEncoderReranker
   */
  getReranker(): LocalCrossEncoderReranker {
    return this.reranker;
  }

  /**
   * Truy xuất động danh sách FunctionDeclaration phù hợp nhất với ngữ cảnh
   */
  retrieve(queryInput: ToolRetrievalQueryInput, allTools?: ToolDefinition[]): FunctionDeclaration[] {
    const pool = allTools || Array.from(this.toolsMap.values());
    const poolMap = new Map(pool.map((tool) => [tool.name, tool]));

    // Nếu tắt Dynamic Retrieval hoặc tổng số tool chưa vượt ngưỡng -> Trả về toàn bộ
    if (!this.config.enabled || pool.length <= this.config.activationThreshold) {
      return this.formatDeclarations(pool);
    }

    const rawQuery = typeof queryInput === 'string' ? queryInput : (queryInput.query || '');
    const denseQuery = typeof queryInput === 'string' ? queryInput : (queryInput.denseQuery || queryInput.query || '');
    const lexicalQuery = typeof queryInput === 'string' ? queryInput : (queryInput.lexicalQuery || queryInput.query || '');
    const lastToolName = typeof queryInput === 'object' && queryInput.lastToolName
      ? queryInput.lastToolName
      : (/last-tool:([a-zA-Z0-9_-]+)/i.exec(rawQuery)?.[1] || undefined);
    const lastToolResult = typeof queryInput === 'object' && queryInput.lastToolResult !== undefined
      ? queryInput.lastToolResult
      : (/evidence:(.+)/s.exec(rawQuery)?.[1] || undefined);
    const phase = typeof queryInput === 'object' && queryInput.phase
      ? queryInput.phase
      : (/phase:([a-zA-Z0-9_-]+)/i.exec(rawQuery)?.[1] || undefined);

    const cleanedQuery = rawQuery.trim();
    const lowerQ = cleanedQuery.toLowerCase();
    const isGameQuery = /\b(game|pixel|sprite|tilemap|physics|unity|engine|scaffold|asset)\b/i.test(lowerQ);
    const isScheduleQuery = /\b(schedule|cron|timer|periodic|recurring)\b/i.test(lowerQ);
    const isMultiAgentQuery = /\b(subagent|delegate|swarm|dag|shared_context|event_bus|orchestrat|blackboard|state|occ|lock)\b/i.test(lowerQ);
    const isNetworkQuery = /\b(web|internet|online|browse|research|latest|current|news|url|website|citation|external|documentation)\b/i.test(lowerQ);
    const isBrowserQuery = /\b(browser|playwright|spa|login|form|click|navigate|snapshot|screenshot|e2e|dynamic|javascript-render)\b/i.test(lowerQ);
    const isMemoryQuery = /\b(memory|remember|recall|knowledge|lesson|insight|episodic)\b/i.test(lowerQ);
    const isVisionQuery = /\b(image|screenshot|photo|picture|vision|diagram|pixel)\b/i.test(lowerQ);
    // Structural/flow query (EN + VI): câu hỏi về cấu trúc, luồng gọi, callers/callees, impact.
    const isStructuralQuery = /(how does|how do|call graph|call path|callers|callees|blast radius|impact\b|architect|trace|tracing|reach(es)?\b|dependenc|flow\b|where\b.*(called|used|defined)|luồng|luong|đồ thị gọi|do thi goi|ai gọi|ai goi|ảnh hưởng|anh huong|phụ thuộc|phu thuoc|kiến trúc|kien truc|truy vết|truy vet|khảo sát|khao sat|cấu trúc|cau truc)/i.test(lowerQ);
    // Chỉ prune khi graph thật sự sẵn sàng: pool có codegraph_explore VÀ workspace đã init
    // (flag từ agent-loop). Nếu chưa init, giữ nguyên menu để tool fallback hoạt động.
    const codegraphReady = (typeof queryInput === 'object' && queryInput.codegraphIndexed === true)
      && poolMap.has('codegraph_explore');

    // Adaptive Schema Pruning: Loại trừ các tool chuyên biệt nặng nếu query không chứa tín hiệu liên quan
    const activePool = pool.filter((tool) => {
      const cat = this.inferCategory(tool);
      if (cat === 'game_development' && !isGameQuery) return false;
      if (tool.name === 'schedule' && !isScheduleQuery) return false;
      if (cat === 'multi_agent' && !isMultiAgentQuery) return false;
      if (cat === 'network' && !isNetworkQuery) return false;
      if (cat === 'browser' && !isNetworkQuery && !isBrowserQuery) return false;
      if (cat === 'memory' && !isMemoryQuery) return false;
      if (tool.name === 'inspect_image' && !isVisionQuery) return false;
      // Single-strong-tool steering: query structural/flow + graph sẵn sàng →
      // codegraph_explore làm primary, prune tool code-intel trùng lắp.
      if (isStructuralQuery && codegraphReady && CODEGRAPH_PRUNED_OVERLAP.has(tool.name)) return false;
      return true;
    });
    const activePoolMap = new Map(activePool.map((tool) => [tool.name, tool]));

    const selectedToolNames = new Set<string>();

    // 1. Luôn bảo lưu các Core Anchor Tools (nếu có trong activePool)
    for (const anchor of this.config.alwaysInclude) {
      if (activePoolMap.has(anchor)) {
        selectedToolNames.add(anchor);
      }
    }
    // Bảo lưu công cụ cập nhật tiến độ công việc nếu đã được cấp quyền trong activePool
    if (activePoolMap.has('update_plan_task')) {
      selectedToolNames.add('update_plan_task');
    }

    // 2. Hybrid Graph-RRF retrieval: lexical BM25 + dense semantic + Markov transition graph + Local Cross-Encoder Reranker
    if (cleanedQuery.length > 0 || lastToolName) {
      try {
        const searchHits = this.miniSearch.search(lexicalQuery || cleanedQuery);
        const lexicalRank = new Map<string, number>();
        searchHits
          .filter((hit) => hit.score >= this.config.minScore && activePoolMap.has(hit.id))
          .forEach((hit, index) => lexicalRank.set(hit.id, index + 1));

        const targetDense = denseQuery.trim() || cleanedQuery;
        const queryTerms = this.semanticTerms(targetDense);
        const semanticDocuments = activePool.map((tool) => {
          const category = this.inferCategory(tool);
          const tags = this.inferTags(tool);
          return `${tool.name} ${category} ${tags} ${tool.description || ''} ${Object.keys(tool.parameters?.properties || {}).join(' ')}`;
        });
        const nativeScores = batchSubwordSimilarity(targetDense, semanticDocuments);

        const semanticCandidates = activePool.map((tool, index) => {
          const category = this.inferCategory(tool);
          const tags = this.inferTags(tool);
          const text = semanticDocuments[index];
          const toolTerms = this.semanticTerms(text);
          let semanticScore = this.termOverlap(queryTerms, toolTerms);
          if (nativeScores) semanticScore = Math.max(semanticScore, Math.max(0, nativeScores[index]));
          const graphBoost = this.transitionGraph.getTransitionBoost(lastToolName, lastToolResult, tool.name);
          semanticScore += this.hierarchyBoost(cleanedQuery, category, tool.name, phase) + graphBoost;
          return { name: tool.name, score: semanticScore, graphBoost };
        }).filter((candidate) => candidate.score > 0)
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

        const semanticRank = new Map<string, number>();
        semanticCandidates.forEach((candidate, index) => semanticRank.set(candidate.name, index + 1));
        const fused = activePool
          .map((tool) => {
            const lr = lexicalRank.get(tool.name);
            const sr = semanticRank.get(tool.name);
            const graphBoost = this.transitionGraph.getTransitionBoost(lastToolName, lastToolResult, tool.name);
            const score = (lr ? 1 / (60 + lr) : 0) + (sr ? 1 / (60 + sr) : 0) + (graphBoost * 0.4);
            return { name: tool.name, score };
          })
          .filter((candidate) => candidate.score > 0 && !selectedToolNames.has(candidate.name))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

        const topScore = fused[0]?.score || 0;
        const cutoffScore = fused[this.config.topK - 1]?.score || 0;
        const adaptiveExtra = topScore > 0 && cutoffScore > 0 && (topScore - cutoffScore) / topScore < 0.12 ? 2 : 0;

        // Two-Tier Candidate Clustering & Local Cross-Encoder Reranking
        const graphSuggested = lastToolName ? this.transitionGraph.getSuggestedTools(lastToolName, lastToolResult) : [];
        const candidateMap = new Map<string, ToolDefinition>();

        // 1. Thu thập ứng viên gợi ý từ Markov Transition Graph
        for (const name of graphSuggested) {
          const tool = activePoolMap.get(name);
          if (tool && !selectedToolNames.has(name)) {
            candidateMap.set(name, tool);
          }
        }

        // 2. Thu thập top ứng viên từ Hybrid Graph-RRF Fusion
        for (const candidate of fused.slice(0, 16)) {
          const tool = activePoolMap.get(candidate.name);
          if (tool && !selectedToolNames.has(candidate.name)) {
            candidateMap.set(candidate.name, tool);
          }
        }

        const candidatePoolTools = Array.from(candidateMap.values());
        if (candidatePoolTools.length > 0) {
          const reranked = this.reranker.rerank(cleanedQuery, candidatePoolTools, {
            topK: this.config.topK + adaptiveExtra,
            minScore: this.config.minScore,
            adaptiveCutoffRatio: 0.35,
          });

          for (const item of reranked) {
            selectedToolNames.add(item.tool.name);
          }

          // Bảo đảm Markov transition graph primary successor (boost >= 0.25) luôn được giữ nếu còn trong activePool
          for (const name of graphSuggested.slice(0, 2)) {
            if (activePoolMap.has(name) && this.transitionGraph.getTransitionBoost(lastToolName, lastToolResult, name) >= 0.25) {
              selectedToolNames.add(name);
            }
          }
        } else {
          for (const candidate of fused.slice(0, this.config.topK + adaptiveExtra)) {
            selectedToolNames.add(candidate.name);
          }
        }
      } catch {
        // Fallback an toàn nếu query chứa ký tự regex đặc biệt
      }
    }

    // 3. Fallback an toàn: Nếu số lượng tool được chọn quá ít, bổ sung các tool phù hợp từ activePool
    if (selectedToolNames.size <= this.config.alwaysInclude.length) {
      for (const tool of activePool) {
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

  private hierarchyBoost(query: string, category: string, toolName: string, phase?: string): number {
    const q = query.toLowerCase();
    let boost = 0;
    if (phase === 'explore') {
      if (category === 'code_intelligence' || category === 'search') boost += 0.15;
    } else if (phase === 'plan') {
      if (category === 'planning' || /plan|task/.test(toolName)) boost += 0.20;
    } else if (phase === 'implement') {
      if (category === 'filesystem_mutation' || /patch|text|file/.test(toolName)) boost += 0.15;
    } else if (phase === 'verify') {
      if (/diagnostic|run|test|command/.test(toolName) || category === 'filesystem_verification') boost += 0.20;
    }

    if (/(plan|task|milestone|roadmap|kế hoạch|giai đoạn)/i.test(q) && (category === 'planning' || /plan|task/.test(toolName))) boost += 0.25;
    if (/(error|exception|diagnostic|failed|failure)/.test(q) && /diagnostic|inspect|symbol|call_graph/.test(toolName)) boost += 0.18;
    if (/(caller|callee|dependency|impact|symbol|architecture|graph)/.test(q) && category === 'code_intelligence') boost += 0.16;
    if (/(test|verify|build|compile)/.test(q) && /run|diagnostic|test|command/.test(toolName)) boost += 0.14;
    if (/(web|research|paper|documentation|internet)/.test(q) && category === 'network') boost += 0.16;
    if (/(browser|playwright|spa|login|form|e2e|snapshot|navigate)/.test(q) && category === 'browser') boost += 0.22;
    if (/(edit|patch|fix|modify|implement)/.test(q) && category === 'filesystem_mutation') boost += 0.10;
    if (/(verify|dry.run|check.*match|validate.*edit|pre.check)/.test(q) && category === 'filesystem_verification') boost += 0.20;
    return boost;
  }

  configure(config: Partial<ToolRetrieverConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): Readonly<Required<ToolRetrieverConfig>> {
    return { ...this.config };
  }

  private formatDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
    // KV-Cache Prefix Alignment:
    // 1. Nhóm Anchor Tools cốt lõi luôn nằm ở vị trí tiền tố (Prefix) cố định 100%
    // 2. Nhóm Dynamic Tools mở rộng được sắp xếp cố định theo tên và nối tiếp phía sau
    // Giúp giữ nguyên vẹn KV-Cache của Anchor Tools ngay cả khi tập dynamic tools thay đổi giữa các turn
    const anchorSet = new Set(this.config.alwaysInclude);
    const anchorTools = tools.filter((t) => anchorSet.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
    const dynamicTools = tools.filter((t) => !anchorSet.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));

    return [...anchorTools, ...dynamicTools].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private inferCategory(tool: ToolDefinition): string {
    const name = tool.name.toLowerCase();
    if (name === 'verify_edit') return 'filesystem_verification';
    if (name.startsWith('browser_')) return 'browser';
    if (name.includes('computer') || name.includes('desktop') || name.includes('mouse') || name.includes('screen')) return 'computer_use';
    if (name.includes('lsp') || name.includes('call_graph') || name.includes('route_map') || name.includes('context_360') || name.includes('topology') || name.includes('symbol') || name.includes('reference') || name.includes('diagnostic') || name.includes('codegraph') || name.includes('caller') || name.includes('callee')) return 'code_intelligence';
    if (name.includes('shared_context') || name.includes('agent_event') || name.includes('subagent') || name.includes('delegate') || name.includes('spawn')) return 'multi_agent';
    if (name.includes('manage_task') || name.includes('schedule') || name.includes('command') || name.includes('sandbox') || name.includes('exec')) return 'process_task';
    if (name.includes('web') || name.includes('fetch') || name.includes('url')) return 'network';
    if (name.includes('file') || name.includes('dir') || name.includes('text') || name.includes('patch')) return 'filesystem_mutation';
    if (name.includes('search') || name.includes('codebase') || name.includes('find')) return 'search';
    if (name.includes('plan') || name.includes('task')) return 'planning';
    if (name.includes('memory') || name.includes('digest')) return 'memory';
    if (name.includes('repomix') || name.includes('pack') || name.includes('compress')) return 'repomix';
    if (name.includes('git') || name.includes('commit') || name.includes('push') || name.includes('diff')) return 'git';
    if (name.includes('image')) return 'image_generation';
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
    if (text.includes('browser') || text.includes('playwright') || text.includes('snapshot') || text.includes('navigate')) {
      tags.add('browser playwright automation spa login form navigate snapshot click type e2e dynamic render');
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
    if (text.includes('plan') || text.includes('task') || text.includes('milestone') || text.includes('roadmap') || text.includes('kế hoạch')) {
      tags.add('plan planning task milestone roadmap step phase progress todo dag kế hoạch công việc');
    }
    if (text.includes('image') || text.includes('picture') || text.includes('banner') || text.includes('mockup') || text.includes('illustration') || text.includes('diagram') || text.includes('icon') || text.includes('nano banana') || text.includes('text-to-image')) {
      tags.add('image generation generate picture photo banner mockup illustration diagram icon asset visual nano-banana text-to-image');
    }

    return Array.from(tags).join(' ');
  }
}
