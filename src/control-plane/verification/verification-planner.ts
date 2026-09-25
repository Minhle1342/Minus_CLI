import type { VerificationContract, VerificationCheck } from '../control-plane-state.js';

export interface PlannedVerificationStep {
  checkId: string;
  checkName: string;
  kind: string;
  recommendedCommand?: string;
  description: string;
}

export class VerificationPlanner {
  /**
   * Plans the sequence of verification steps needed to satisfy pending or stale contract checks.
   */
  static planVerification(params: {
    contract: VerificationContract;
    pendingCheckIds: string[];
    staleCheckIds: string[];
    targetFiles?: string[];
  }): PlannedVerificationStep[] {
    const { contract, pendingCheckIds, staleCheckIds, targetFiles = [] } = params;

    const neededIds = new Set([...pendingCheckIds, ...staleCheckIds]);
    const checksToRun = contract.requiredChecks.filter((c) => neededIds.has(c.id));

    const steps: PlannedVerificationStep[] = [];

    for (const check of checksToRun) {
      let cmd = check.command;
      if (!cmd) {
        if (check.kind === 'test') {
          cmd = 'npm test';
        } else if (check.kind === 'build') {
          cmd = 'npm run build';
        } else if (check.kind === 'typecheck') {
          cmd = 'npx tsc --noEmit';
        }
      }

      steps.push({
        checkId: check.id,
        checkName: check.name,
        kind: check.kind,
        recommendedCommand: cmd,
        description: check.description,
      });
    }

    return steps;
  }
}
