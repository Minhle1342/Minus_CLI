import type { EvidenceRecord, ChangedFileState } from '../control-plane-state.js';
import { MutationImpactAnalyzer } from './mutation-impact.js';

export interface InvalidationResult {
  invalidatedEvidenceIds: string[];
  stillFreshEvidenceIds: string[];
  reasons: string[];
}

export class EvidenceInvalidator {
  /**
   * Identifies which evidence records have become STALE after mutations.
   */
  static evaluateInvalidation(params: {
    currentMutationSeq: number;
    currentWorkspaceDigest: string;
    recentMutations: ChangedFileState[];
    existingEvidence: EvidenceRecord[];
  }): InvalidationResult {
    const { currentMutationSeq, currentWorkspaceDigest, recentMutations, existingEvidence } = params;

    const invalidatedIds: string[] = [];
    const freshIds: string[] = [];
    const reasons: string[] = [];

    const mutatedFilePaths = recentMutations.map((m) => m.path);

    for (const record of existingEvidence) {
      // If already stale, keep stale
      if (record.freshness === 'STALE' || record.status === 'STALE') {
        invalidatedIds.push(record.evidenceId);
        continue;
      }

      // 1. Check mutation sequence ordering
      if (record.mutationSeq < currentMutationSeq) {
        // If evidence was produced before recent mutations, check if it's affected
        const isAffected = mutatedFilePaths.some((mutatedFile) =>
          MutationImpactAnalyzer.doesMutationAffectEvidence({
            mutatedFile,
            evidenceAffectedFiles: record.affectedFiles,
            evidenceTarget: record.target,
          }),
        );

        if (isAffected) {
          invalidatedIds.push(record.evidenceId);
          reasons.push(
            `Evidence [${record.evidenceId}] (${record.type}:${record.summary.slice(0, 40)}) invalidated: generated at seq #${record.mutationSeq}, but relevant file was mutated at seq #${currentMutationSeq}.`,
          );
          continue;
        }
      }

      // 2. Check workspace digest match for strict build/diagnostic invariants
      if (record.type === 'diagnostic' || record.type === 'build') {
        if (record.workspaceDigest !== currentWorkspaceDigest) {
          invalidatedIds.push(record.evidenceId);
          reasons.push(
            `Evidence [${record.evidenceId}] (${record.type}) invalidated: workspace digest changed from ${record.workspaceDigest.slice(0, 8)} to ${currentWorkspaceDigest.slice(0, 8)}.`,
          );
          continue;
        }
      }

      freshIds.push(record.evidenceId);
    }

    return {
      invalidatedEvidenceIds: invalidatedIds,
      stillFreshEvidenceIds: freshIds,
      reasons,
    };
  }
}
