export type ContextFidelity = 'fold' | 'preview' | 'full';

export interface ContextCandidate {
  id: string;
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  sourceHash: string;
  content: string;
  fidelity: ContextFidelity;
  required?: boolean;
  freshness?: 'current' | 'stale' | 'unknown';
  lexicalScore?: number;
  semanticScore?: number;
  graphScore?: number;
  selectionReason?: string;
}

export interface ContextBundleSelection {
  included: ContextCandidate[];
  omitted: Array<{ id: string; reason: string }>;
  estimatedTokens: number;
  budgetTokens: number;
}

/** Pure, testable anti-dilution policy used before wiring candidates into the main-loop arbiter. */
export class ContextBundlePolicy {
  select(candidates: ContextCandidate[], budgetTokens: number): ContextBundleSelection {
    const budget = Math.max(64, Math.trunc(budgetTokens));
    const omitted: Array<{ id: string; reason: string }> = [];
    const deduped = new Map<string, ContextCandidate>();
    for (const candidate of candidates) {
      if (candidate.freshness === 'stale') {
        omitted.push({ id: candidate.id, reason: 'stale_revision' });
        continue;
      }
      const previous = deduped.get(candidate.sourceHash);
      if (!previous || candidateUtility(candidate) > candidateUtility(previous)) {
        if (previous) omitted.push({ id: previous.id, reason: 'duplicate_source_hash' });
        deduped.set(candidate.sourceHash, candidate);
      } else {
        omitted.push({ id: candidate.id, reason: 'duplicate_source_hash' });
      }
    }

    const ranked = [...deduped.values()].sort((left, right) => {
      if (Boolean(left.required) !== Boolean(right.required)) return left.required ? -1 : 1;
      return candidateUtility(right) - candidateUtility(left) || left.path.localeCompare(right.path);
    });
    const included: ContextCandidate[] = [];
    let estimatedTokens = 0;
    for (const candidate of ranked) {
      const cost = estimateTokens(candidate.content);
      if (estimatedTokens + cost > budget) {
        omitted.push({ id: candidate.id, reason: candidate.required ? 'required_exceeds_budget' : 'token_budget' });
        continue;
      }
      if (!candidate.required && candidateUtility(candidate) < 0.05) {
        omitted.push({ id: candidate.id, reason: 'low_marginal_utility' });
        continue;
      }
      included.push(candidate);
      estimatedTokens += cost;
    }
    return { included, omitted, estimatedTokens, budgetTokens: budget };
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function candidateUtility(candidate: ContextCandidate): number {
  const fidelityWeight = candidate.fidelity === 'full' ? 0.12 : candidate.fidelity === 'preview' ? 0.06 : 0.02;
  return (candidate.required ? 10 : 0)
    + (candidate.lexicalScore || 0) * 0.45
    + (candidate.semanticScore || 0) * 0.4
    + (candidate.graphScore || 0) * 0.15
    + fidelityWeight;
}
