import type { SpeculativeBranchManager } from '../../agent/speculative-branch-manager.js';

export interface SpeculativeExecutionResult {
  branchName: string;
  success: boolean;
  message: string;
}

export class SpeculativeBranchController {
  private speculativeManager?: SpeculativeBranchManager;

  constructor(speculativeManager?: SpeculativeBranchManager) {
    this.speculativeManager = speculativeManager;
  }

  setManager(speculativeManager: SpeculativeBranchManager): void {
    this.speculativeManager = speculativeManager;
  }

  async startBranch(hypothesisId: string, baseRef?: string): Promise<string | null> {
    if (!this.speculativeManager) return null;
    try {
      const spec = await this.speculativeManager.createSpeculative(hypothesisId);
      return spec.branchName;
    } catch {
      return null;
    }
  }

  async promoteBranch(hypothesisId: string): Promise<boolean> {
    if (!this.speculativeManager) return false;
    try {
      const spec = this.speculativeManager.getSpeculative(hypothesisId);
      if (!spec) return false;
      // In speculative execution, a validated branch session is considered promoted
      return true;
    } catch {
      return false;
    }
  }

  async abortBranch(hypothesisId: string): Promise<boolean> {
    if (!this.speculativeManager) return false;
    try {
      const outcome = await this.speculativeManager.abortSpeculative(hypothesisId);
      return Boolean(outcome);
    } catch {
      return false;
    }
  }
}
