import type { VerificationContract, EvidenceRecord } from '../control-plane-state.js';

export interface CoverageReport {
  coverageScore: number; // 0 - 100
  totalChecks: number;
  satisfiedCount: number;
  pendingCount: number;
  failedCount: number;
  staleCount: number;
  coverageRatio: number;
}

export class VerificationCoverageAnalyzer {
  static compute(params: {
    contract?: VerificationContract;
    satisfiedCheckIds: string[];
    pendingCheckIds: string[];
    failedCheckIds: string[];
    staleCheckIds: string[];
  }): CoverageReport {
    const totalChecks = params.contract?.requiredChecks.length || 1;
    const satisfiedCount = params.satisfiedCheckIds.length;
    const pendingCount = params.pendingCheckIds.length;
    const failedCount = params.failedCheckIds.length;
    const staleCount = params.staleCheckIds.length;

    const coverageRatio = Math.min(1, Math.max(0, satisfiedCount / totalChecks));
    const coverageScore = Math.round(coverageRatio * 100);

    return {
      coverageScore,
      totalChecks,
      satisfiedCount,
      pendingCount,
      failedCount,
      staleCount,
      coverageRatio,
    };
  }
}
