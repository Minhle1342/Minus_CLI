import type { CodeSearchHit } from './code-search-engine.js';
import type { SemanticCodeSearchHit } from './semantic-code-index.js';

export type RetrievalMode = 'auto' | 'lexical' | 'hybrid' | 'semantic';

export interface HybridSearchHit {
  id: string;
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  snippet: string;
  sourceHash?: string;
  score: number;
  scoreComponents: {
    lexicalRrf: number;
    semanticRrf: number;
    exactBoost: number;
    graphBoost: number;
  };
  matchingTerms: string[];
  expandedFrom?: string;
}

export interface RetrievalDecision {
  mode: Exclude<RetrievalMode, 'auto'>;
  reason: string;
}

/** Conservative selective-retrieval gate. Exact identifiers stay lexical-first. */
export function decideRetrievalMode(query: string, requested: RetrievalMode = 'auto'): RetrievalDecision {
  if (requested !== 'auto') return { mode: requested, reason: 'explicit_mode' };
  const trimmed = query.trim();
  const terms = trimmed.split(/\s+/).filter(Boolean);
  const looksLikePath = /(?:^|[\\/])[\w.-]+\.[A-Za-z0-9]+(?::\d+)?$/.test(trimmed);
  const looksLikeIdentifier = /^[A-Za-z_$][A-Za-z0-9_$.:-]*$/.test(trimmed);
  const looksLikeErrorLiteral = /(?:error|exception|failed|errno)[:\s]/i.test(trimmed)
    || /\bE[A-Z_]{2,}\b/.test(trimmed)
    || /["'`].{4,}["'`]/.test(trimmed);
  if (looksLikePath || looksLikeIdentifier || looksLikeErrorLiteral || terms.length <= 2) {
    return { mode: 'lexical', reason: 'exact_or_literal_query' };
  }
  return { mode: 'hybrid', reason: 'natural_language_intent' };
}

/** Reciprocal-rank fusion keeps lexical and dense scores independently calibrated. */
export function fuseSearchResults(
  query: string,
  lexicalHits: CodeSearchHit[],
  semanticHits: SemanticCodeSearchHit[],
  limit: number,
): HybridSearchHit[] {
  const byId = new Map<string, HybridSearchHit>();
  const lowerQuery = query.toLowerCase();
  const rrfK = 60;

  lexicalHits.forEach((hit, rank) => {
    const id = `file:${hit.path}`;
    const exactBoost = exactMatchBoost(lowerQuery, hit.path, undefined, hit.snippet);
    byId.set(id, {
      id,
      path: hit.path,
      snippet: hit.snippet,
      score: 0,
      scoreComponents: {
        lexicalRrf: 1 / (rrfK + rank + 1),
        semanticRrf: 0,
        exactBoost,
        graphBoost: 0,
      },
      matchingTerms: hit.matchTerms,
    });
  });

  semanticHits.forEach((hit, rank) => {
    const id = `symbol:${hit.chunk.id}`;
    const samePathFile = byId.get(`file:${hit.chunk.path}`);
    const exactBoost = exactMatchBoost(
      lowerQuery,
      hit.chunk.path,
      hit.chunk.name,
      hit.chunk.signature,
    );
    const candidate: HybridSearchHit = {
      id,
      path: hit.chunk.path,
      symbol: hit.chunk.name,
      startLine: hit.chunk.startLine,
      endLine: hit.chunk.endLine,
      snippet: `${hit.chunk.signature}\n${hit.chunk.text.split('\n').slice(0, 6).join('\n')}`,
      sourceHash: hit.chunk.sourceHash,
      score: 0,
      scoreComponents: {
        lexicalRrf: samePathFile?.scoreComponents.lexicalRrf || 0,
        semanticRrf: 1 / (rrfK + rank + 1),
        exactBoost,
        graphBoost: hit.graphScore,
      },
      matchingTerms: samePathFile?.matchingTerms || [],
      ...(hit.expandedFrom ? { expandedFrom: hit.expandedFrom } : {}),
    };
    byId.set(id, candidate);
  });

  const symbolsByPath = new Set(semanticHits.map((hit) => hit.chunk.path));
  const results = [...byId.values()].filter((hit) => hit.symbol || !symbolsByPath.has(hit.path));
  for (const hit of results) {
    const parts = hit.scoreComponents;
    hit.score = round((parts.lexicalRrf + parts.semanticRrf) * 30 + parts.exactBoost + parts.graphBoost);
  }
  return results
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
}

function exactMatchBoost(query: string, filePath: string, symbol?: string, text?: string): number {
  if (symbol?.toLowerCase() === query) return 1;
  if (filePath.toLowerCase() === query || filePath.toLowerCase().endsWith(`/${query}`)) return 0.9;
  if (symbol?.toLowerCase().includes(query)) return 0.45;
  if (text?.toLowerCase().includes(query)) return 0.25;
  return 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
