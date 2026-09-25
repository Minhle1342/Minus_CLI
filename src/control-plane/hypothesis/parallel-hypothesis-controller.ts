import type { HypothesisNode } from '../control-plane-state.js';

export interface ParallelBranchCandidate {
  hypothesisId: string;
  branchName: string;
  status: 'PENDING' | 'RUNNING' | 'PASSED' | 'FAILED';
  evidenceIds: string[];
}

export class ParallelHypothesisController {
  private activeBranches = new Map<string, ParallelBranchCandidate>();

  shouldTriggerParallelSearch(params: {
    uncertainty: number;
    candidateHypothesesCount: number;
    consecutiveFailures: number;
  }): boolean {
    return (
      params.uncertainty >= 0.7 &&
      params.candidateHypothesesCount >= 2 &&
      params.consecutiveFailures >= 2
    );
  }

  registerBranch(hypothesisId: string, branchName: string): ParallelBranchCandidate {
    const candidate: ParallelBranchCandidate = {
      hypothesisId,
      branchName,
      status: 'PENDING',
      evidenceIds: [],
    };
    this.activeBranches.set(hypothesisId, candidate);
    return candidate;
  }

  getBranch(hypothesisId: string): ParallelBranchCandidate | undefined {
    return this.activeBranches.get(hypothesisId);
  }

  updateBranchStatus(
    hypothesisId: string,
    status: ParallelBranchCandidate['status'],
    evidenceId?: string,
  ): void {
    const candidate = this.activeBranches.get(hypothesisId);
    if (candidate) {
      candidate.status = status;
      if (evidenceId && !candidate.evidenceIds.includes(evidenceId)) {
        candidate.evidenceIds.push(evidenceId);
      }
    }
  }

  getAllBranches(): ParallelBranchCandidate[] {
    return Array.from(this.activeBranches.values());
  }

  clear(): void {
    this.activeBranches.clear();
  }
}
