import type { EvidenceRecord, WorkspaceState } from '../control-plane-state.js';
import { MutationImpactAnalyzer } from '../workspace/mutation-impact.js';

export class EvidenceFreshnessEvaluator {
  /**
   * Evaluates if a given evidence record remains fresh with respect to current workspace state.
   */
  static isFresh(record: EvidenceRecord, currentWorkspace: WorkspaceState): boolean {
    if (record.freshness === 'STALE' || record.status === 'STALE') {
      return false;
    }

    // 1. If mutations happened after this evidence was generated
    if (record.mutationSeq < currentWorkspace.activeMutationSeq) {
      // Check if any file mutated after this evidence touches the evidence target
      const recentMutations = currentWorkspace.changedFiles.filter(
        (f) => f.mutationSeq > record.mutationSeq,
      );

      for (const m of recentMutations) {
        if (
          MutationImpactAnalyzer.doesMutationAffectEvidence({
            mutatedFile: m.path,
            evidenceAffectedFiles: record.affectedFiles,
            evidenceTarget: record.target,
          })
        ) {
          return false;
        }
      }
    }

    // 2. Strict check for full build / global diagnostics
    if (record.type === 'diagnostic' || record.type === 'build') {
      if (record.workspaceDigest !== currentWorkspace.workspaceDigest) {
        return false;
      }
    }

    return true;
  }
}
