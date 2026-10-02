import type { ToolDefinition } from './types.js';
import { batchSubwordSimilarity } from '../native/semantic-batch.js';

export interface RerankCandidate {
  tool: ToolDefinition;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  intentBoost: number;
  reasons: string[];
}

export interface RerankerOptions {
  topK?: number;
  minScore?: number;
  adaptiveCutoffRatio?: number;
}

/**
 * LocalCrossEncoderReranker (FlashRank / ToolRerank Engine)
 *
 * Provides an in-process, high-precision cross-scoring and reranking engine for tool candidates.
 * Bridges the gap between fast sparse BM25 retrieval and deep dense semantics without requiring external cloud API calls.
 *
 * Features:
 * 1. BM25F Field-Weighted Cross Scoring: Heavy weights for exact tool names and parameter signatures.
 * 2. Dense Semantic Subword Cosine Alignment: Uses SIMD-accelerated Rust native core or pure TS fallback.
 * 3. Parameter Relevance Verification: Rewards tools whose parameter contracts directly address query needs.
 * 4. Adaptive Truncation: Dynamically detects steep score drops to prune low-confidence schema noise.
 */
export class LocalCrossEncoderReranker {
  /**
   * Reranks a candidate list of tools against a user prompt / task intent.
   */
  rerank(
    query: string,
    candidates: ToolDefinition[],
    options?: RerankerOptions,
  ): RerankCandidate[] {
    const topK = options?.topK ?? 5;
    const minScore = options?.minScore ?? 0.05;
    const adaptiveCutoffRatio = options?.adaptiveCutoffRatio ?? 0.35;

    const cleanedQuery = query.trim().toLowerCase();
    if (!cleanedQuery || candidates.length === 0) {
      return candidates.slice(0, topK).map((tool) => ({
        tool,
        score: 1.0,
        semanticScore: 1.0,
        lexicalScore: 1.0,
        intentBoost: 0.0,
        reasons: ['Default baseline ranking.'],
      }));
    }

    const queryTokens = this.tokenize(cleanedQuery);
    const documents = candidates.map((tool) =>
      `${tool.name} ${(tool.description || '').toLowerCase()} ${Object.keys(tool.parameters?.properties || {}).join(' ').toLowerCase()}`);
    const nativeScores = batchSubwordSimilarity(cleanedQuery, documents);

    const scored: RerankCandidate[] = candidates.map((tool, index) => {
      const reasons: string[] = [];

      // 1. Lexical BM25F Cross-Scoring
      const nameScore = this.computeNameMatchScore(queryTokens, tool.name);
      if (nameScore > 0) {
        reasons.push(`Tool name exact/subword match (+${nameScore.toFixed(2)})`);
      }

      const paramsText = Object.keys(tool.parameters?.properties || {}).join(' ').toLowerCase();
      const paramScore = this.computeTokenOverlap(queryTokens, this.tokenize(paramsText)) * 2.0;
      if (paramScore > 0) {
        reasons.push(`Parameter keyword alignment (+${paramScore.toFixed(2)})`);
      }

      const descText = (tool.description || '').toLowerCase();
      const descScore = this.computeTokenOverlap(queryTokens, this.tokenize(descText)) * 1.5;

      const lexicalScore = nameScore + paramScore + descScore;

      // 2. Dense Semantic Subword Alignment
      let semanticScore = 0;
      const fullDocText = `${tool.name} ${descText} ${paramsText}`;
      if (nativeScores) {
        const cosSim = nativeScores[index];
        if (cosSim > 0) {
          semanticScore = cosSim;
          reasons.push(`Dense vector similarity (${cosSim.toFixed(2)})`);
        }
      } else {
        semanticScore = this.computeJaccardSimilarity(queryTokens, this.tokenize(fullDocText));
      }

      // 3. Task Intent Cross-Boost
      const intentBoost = this.computeIntentBoost(cleanedQuery, tool.name, descText);
      if (intentBoost > 0) {
        reasons.push(`Task intent alignment boost (+${intentBoost.toFixed(2)})`);
      }

      // 4. Combined Cross-Encoder Score
      const totalScore = (lexicalScore * 0.45) + (semanticScore * 0.35) + (intentBoost * 0.20);

      return {
        tool,
        score: totalScore,
        semanticScore,
        lexicalScore,
        intentBoost,
        reasons,
      };
    });

    // Sắp xếp theo điểm số giảm dần
    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

    // 5. Adaptive Truncation: Loại bỏ các ứng viên có điểm quá thấp so với ứng viên dẫn đầu
    const topScore = scored[0]?.score || 0;
    const threshold = Math.max(minScore, topScore * adaptiveCutoffRatio);

    const filtered = scored.filter((c) => c.score >= threshold);
    return (filtered.length > 0 ? filtered : scored).slice(0, topK);
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    );
  }

  private computeNameMatchScore(queryTokens: Set<string>, toolName: string): number {
    const nameLower = toolName.toLowerCase();
    const nameParts = nameLower.split('_');

    // Exact tool name match in query
    if (queryTokens.has(nameLower)) {
      return 5.0;
    }

    let matchCount = 0;
    for (const part of nameParts) {
      if (part.length >= 3 && queryTokens.has(part)) {
        matchCount++;
      }
    }

    return matchCount > 0 ? (matchCount / nameParts.length) * 3.5 : 0;
  }

  private computeTokenOverlap(queryTokens: Set<string>, targetTokens: Set<string>): number {
    if (queryTokens.size === 0 || targetTokens.size === 0) return 0;
    let matches = 0;
    for (const token of queryTokens) {
      if (targetTokens.has(token)) {
        matches++;
      }
    }
    return matches / Math.sqrt(queryTokens.size * targetTokens.size);
  }

  private computeJaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private computeIntentBoost(query: string, toolName: string, description: string): number {
    let boost = 0;

    // Mutation intent
    if (/\b(?:fix|edit|modify|patch|replace|update|create|write|delete)\b/i.test(query)) {
      if (['apply_patch', 'replace_text', 'write_file', 'create_file'].includes(toolName)) boost += 0.35;
    }

    // Code intelligence & architecture intent
    if (/\b(?:caller|callee|graph|topology|architecture|dependency|symbol|route|impact|blast|trace)\b/i.test(query)) {
      if (['get_symbol_context_360', 'query_call_graph', 'get_route_map', 'analyze_impact', 'get_architecture_topology'].includes(toolName)) boost += 0.40;
    }

    // Diagnostics & testing intent
    if (/\b(?:test|spec|verify|diagnostic|error|fail|failing|check)\b/i.test(query)) {
      if (['get_diagnostics', 'run_command', 'verify_edit'].includes(toolName)) boost += 0.35;
    }

    // Planning intent
    if (/\b(?:plan|task|roadmap|milestone|dag|kế hoạch)\b/i.test(query)) {
      if (['create_plan', 'update_plan_task'].includes(toolName)) boost += 0.45;
    }

    // Memory intent
    if (/\b(?:memory|remember|recall|lesson|insight|ghi nhớ|bộ nhớ)\b/i.test(query)) {
      if (toolName.includes('memory')) boost += 0.45;
    }

    // Web research intent
    if (/\b(?:web|online|internet|search online|doc|docs|paper|tin tức)\b/i.test(query)) {
      if (['web_search', 'web_fetch'].includes(toolName)) boost += 0.45;
    }

    // Multi-agent intent
    if (/\b(?:subagent|delegate|spawn|parallel|swarm|shared context)\b/i.test(query)) {
      if (['allocate_agent_task', 'brainstorm_design', 'schedule_dag_parallel'].includes(toolName)) boost += 0.40;
    }

    return boost;
  }
}
