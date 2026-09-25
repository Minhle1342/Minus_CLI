import type {
  HypothesisNode,
  HypothesisStatus,
  PredictedObservation,
  FalsificationTest,
  BlastRadiusEstimate,
  MutationProposal,
  HypothesisState,
} from '../control-plane-state.js';

export interface FormulateHypothesisOptions {
  statement: string;
  parentIds?: string[];
  confidence?: number;
  predictedObservations?: PredictedObservation[];
  falsificationTests?: FalsificationTest[];
  targetFiles?: string[];
  targetSymbols?: string[];
  blastRadius?: BlastRadiusEstimate;
  proposedMutation?: MutationProposal;
  estimatedExperimentCost?: number;
}

export class HypothesisGraph {
  private nodes = new Map<string, HypothesisNode>();
  private counter = 0;
  private activeId?: string;

  formulate(options: FormulateHypothesisOptions): HypothesisNode {
    this.counter++;
    const id = `H${this.counter}`;
    const now = Date.now();

    const node: HypothesisNode = {
      id,
      statement: options.statement,
      parentIds: options.parentIds || [],
      status: 'FORMULATED',
      confidence: options.confidence ?? 0.7,
      predictedObservations: options.predictedObservations || [],
      falsificationTests: options.falsificationTests || [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      targetFiles: options.targetFiles || [],
      targetSymbols: options.targetSymbols || [],
      blastRadius: options.blastRadius || {
        risk: 'MEDIUM' as any,
        estimatedFiles: options.targetFiles || [],
        estimatedSymbols: options.targetSymbols || [],
        score: 0.5,
      },
      proposedMutation: options.proposedMutation,
      estimatedExperimentCost: options.estimatedExperimentCost ?? 1,
      createdAt: now,
      updatedAt: now,
    };

    this.nodes.set(id, node);
    this.activeId = id;
    return node;
  }

  getActiveHypothesis(): HypothesisNode | undefined {
    if (this.activeId) {
      return this.nodes.get(this.activeId);
    }
    for (const h of this.nodes.values()) {
      if (h.status === 'FORMULATED' || h.status === 'TESTING') {
        return h;
      }
    }
    return undefined;
  }

  markTesting(id?: string): void {
    const target = id ? this.nodes.get(id) : this.getActiveHypothesis();
    if (target) {
      target.status = 'TESTING';
      target.updatedAt = Date.now();
    }
  }

  markValidated(id: string, notes?: string): void {
    const target = this.nodes.get(id);
    if (target) {
      target.status = 'VALIDATED';
      target.learning = notes || target.learning;
      target.updatedAt = Date.now();
      if (this.activeId === id) this.activeId = undefined;
    }
  }

  markFalsified(id: string, reason: string, learning?: string): void {
    const target = this.nodes.get(id);
    if (target) {
      target.status = 'FALSIFIED';
      target.rejectionReason = reason;
      target.learning = learning || `Hypothesis ${id} falsified: ${reason}`;
      target.updatedAt = Date.now();
      if (this.activeId === id) this.activeId = undefined;
    }
  }

  markAbandoned(id: string, reason?: string): void {
    const target = this.nodes.get(id);
    if (target) {
      target.status = 'ABANDONED';
      target.rejectionReason = reason;
      target.updatedAt = Date.now();
      if (this.activeId === id) this.activeId = undefined;
    }
  }

  attachEvidence(params: {
    hypothesisId: string;
    evidenceId: string;
    relationship: 'SUPPORTS' | 'CONTRADICTS';
  }): void {
    const h = this.nodes.get(params.hypothesisId);
    if (!h) return;

    if (params.relationship === 'SUPPORTS') {
      if (!h.supportingEvidenceIds.includes(params.evidenceId)) {
        h.supportingEvidenceIds.push(params.evidenceId);
      }
    } else {
      if (!h.contradictingEvidenceIds.includes(params.evidenceId)) {
        h.contradictingEvidenceIds.push(params.evidenceId);
      }
    }
    h.updatedAt = Date.now();
  }

  getNode(id: string): HypothesisNode | undefined {
    return this.nodes.get(id);
  }

  getAll(): HypothesisNode[] {
    return Array.from(this.nodes.values());
  }

  getFalsified(): HypothesisNode[] {
    return Array.from(this.nodes.values()).filter((h) => h.status === 'FALSIFIED');
  }

  getValidated(): HypothesisNode[] {
    return Array.from(this.nodes.values()).filter((h) => h.status === 'VALIDATED');
  }

  /**
   * Checks if a proposed hypothesis statement is semantically identical to a recently falsified one.
   */
  isRepeatedFalsified(statement: string): { isRepeated: boolean; matchingHypothesis?: HypothesisNode } {
    const norm = statement.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const h of this.getFalsified()) {
      const hNorm = h.statement.toLowerCase().replace(/\s+/g, ' ').trim();
      if (hNorm === norm || (norm.length > 20 && hNorm.includes(norm)) || (hNorm.length > 20 && norm.includes(hNorm))) {
        return { isRepeated: true, matchingHypothesis: h };
      }
    }
    return { isRepeated: false };
  }

  getState(): HypothesisState {
    const nodes: Record<string, HypothesisNode> = {};
    const falsifiedIds: string[] = [];
    const validatedIds: string[] = [];

    for (const [id, h] of this.nodes.entries()) {
      nodes[id] = { ...h };
      if (h.status === 'FALSIFIED') falsifiedIds.push(id);
      if (h.status === 'VALIDATED') validatedIds.push(id);
    }

    return {
      nodes,
      activeHypothesisId: this.activeId,
      falsifiedHypothesisIds: falsifiedIds,
      validatedHypothesisIds: validatedIds,
      hypothesisCounter: this.counter,
    };
  }

  toScratchpad(): string {
    if (this.nodes.size === 0) return '';
    const lines = ['🧠 [EVIDENCE-DRIVEN HYPOTHESIS GRAPH]:'];
    for (const h of this.nodes.values()) {
      const icon =
        h.status === 'VALIDATED'
          ? '✅'
          : h.status === 'FALSIFIED'
          ? '❌'
          : h.status === 'TESTING'
          ? '🧪'
          : '💡';
      lines.push(`  ${icon} [${h.id}] [${h.status}]: ${h.statement}`);
      if (h.rejectionReason && h.status === 'FALSIFIED') {
        lines.push(`     • Falsified Reason: ${h.rejectionReason}`);
      }
      if (h.learning) {
        lines.push(`     • Learning: ${h.learning}`);
      }
    }
    return lines.join('\n');
  }
}
