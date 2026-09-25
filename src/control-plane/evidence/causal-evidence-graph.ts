import type { EvidenceRecord, HypothesisNode } from '../control-plane-state.js';

export interface CausalChainNode {
  hypothesisId?: string;
  mutationSeq?: number;
  evidenceId: string;
  evidenceType: string;
  status: string;
  supportsHypotheses: string[];
  contradictsHypotheses: string[];
  generatedAt: number;
}

export class CausalEvidenceGraph {
  private nodes = new Map<string, CausalChainNode>();

  addEvidence(record: EvidenceRecord, activeHypothesisId?: string): void {
    const node: CausalChainNode = {
      hypothesisId: activeHypothesisId,
      mutationSeq: record.mutationSeq,
      evidenceId: record.evidenceId,
      evidenceType: record.type,
      status: record.status,
      supportsHypotheses: [...record.supports],
      contradictsHypotheses: [...record.contradicts],
      generatedAt: record.generatedAt,
    };
    this.nodes.set(record.evidenceId, node);
  }

  getEvidenceForHypothesis(hypothesisId: string): {
    supporting: CausalChainNode[];
    contradicting: CausalChainNode[];
  } {
    const supporting: CausalChainNode[] = [];
    const contradicting: CausalChainNode[] = [];

    for (const node of this.nodes.values()) {
      if (node.supportsHypotheses.includes(hypothesisId)) {
        supporting.push(node);
      }
      if (node.contradictsHypotheses.includes(hypothesisId)) {
        contradicting.push(node);
      }
    }

    return { supporting, contradicting };
  }

  getAllNodes(): CausalChainNode[] {
    return Array.from(this.nodes.values());
  }
}
