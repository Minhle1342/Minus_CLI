import type {
  EvidenceRecord,
  EvidenceState,
  WorkspaceState,
  ChangedFileState,
} from '../control-plane-state.js';
import { EvidenceInvalidator } from '../workspace/evidence-invalidation.js';
import { EvidenceFreshnessEvaluator } from './evidence-freshness.js';
import { CausalEvidenceGraph } from './causal-evidence-graph.js';

export class EvidenceLedger {
  private records = new Map<string, EvidenceRecord>();
  readonly causalGraph = new CausalEvidenceGraph();

  record(record: EvidenceRecord, activeHypothesisId?: string): EvidenceRecord {
    this.records.set(record.evidenceId, record);
    this.causalGraph.addEvidence(record, activeHypothesisId);
    return record;
  }

  get(evidenceId: string): EvidenceRecord | undefined {
    return this.records.get(evidenceId);
  }

  getAll(): EvidenceRecord[] {
    return Array.from(this.records.values());
  }

  getFresh(currentWorkspace: WorkspaceState): EvidenceRecord[] {
    return Array.from(this.records.values()).filter((rec) =>
      EvidenceFreshnessEvaluator.isFresh(rec, currentWorkspace),
    );
  }

  getStale(): EvidenceRecord[] {
    return Array.from(this.records.values()).filter(
      (rec) => rec.freshness === 'STALE' || rec.status === 'STALE',
    );
  }

  /**
   * Invalidates evidence records affected by recent file mutations.
   */
  invalidateOnMutation(params: {
    currentMutationSeq: number;
    currentWorkspaceDigest: string;
    recentMutations: ChangedFileState[];
  }): { invalidatedIds: string[]; reasons: string[] } {
    const all = Array.from(this.records.values());
    const result = EvidenceInvalidator.evaluateInvalidation({
      currentMutationSeq: params.currentMutationSeq,
      currentWorkspaceDigest: params.currentWorkspaceDigest,
      recentMutations: params.recentMutations,
      existingEvidence: all,
    });

    for (const id of result.invalidatedEvidenceIds) {
      const rec = this.records.get(id);
      if (rec) {
        rec.freshness = 'STALE';
        rec.status = 'STALE';
      }
    }

    return {
      invalidatedIds: result.invalidatedEvidenceIds,
      reasons: result.reasons,
    };
  }

  getState(currentWorkspace: WorkspaceState): EvidenceState {
    const allRecords: Record<string, EvidenceRecord> = {};
    const activeFreshIds: string[] = [];
    const staleIds: string[] = [];

    for (const [id, rec] of this.records.entries()) {
      allRecords[id] = { ...rec };
      if (EvidenceFreshnessEvaluator.isFresh(rec, currentWorkspace)) {
        activeFreshIds.push(id);
      } else {
        staleIds.push(id);
      }
    }

    return {
      records: allRecords,
      activeFreshEvidenceIds: activeFreshIds,
      staleEvidenceIds: staleIds,
    };
  }
}
