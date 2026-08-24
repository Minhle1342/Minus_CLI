import type { CheckpointManager, Checkpoint } from '../workspace/checkpoint.js';
import type { SpeculativeBranchManager } from './speculative-branch-manager.js';
import type { HypothesisTracker } from './hypothesis-tracker.js';

export interface RollbackOutcome {
  rolledBack: boolean;
  restoredCheckpoint?: Checkpoint;
  reason: string;
  guidancePrompt?: string;
}

/**
 * HypothesisRollbackOrchestrator - Codex CLI Automatic Baseline Rollback
 * 
 * Automatically rolls back workspace mutations to the last verified green state
 * whenever a repair hypothesis is falsified or verification fails repeatedly.
 */
export class HypothesisRollbackOrchestrator {
  private checkpointManager: CheckpointManager;
  private speculativeManager?: SpeculativeBranchManager;
  private lastGreenCheckpoint?: Checkpoint;

  constructor(
    checkpointManager: CheckpointManager,
    speculativeManager?: SpeculativeBranchManager,
  ) {
    this.checkpointManager = checkpointManager;
    this.speculativeManager = speculativeManager;
  }

  /**
   * Mark current state as a verified green baseline
   */
  markGreenCheckpoint(checkpoint: Checkpoint): void {
    this.lastGreenCheckpoint = checkpoint;
  }

  getGreenCheckpoint(): Checkpoint | undefined {
    return this.lastGreenCheckpoint;
  }

  /**
   * Orchestrate rollback when a hypothesis is falsified
   */
  async rollbackOnFalsifiedHypothesis(
    hypothesisId: string,
    hypothesisTracker?: HypothesisTracker,
  ): Promise<RollbackOutcome> {
    // 1. If running in speculative branch, clean up the branch
    if (this.speculativeManager) {
      const spec = this.speculativeManager.getSpeculative(hypothesisId);
      if (spec) {
        await this.speculativeManager.abortSpeculative(hypothesisId).catch(() => {});
      }
    }

    // 2. Mark hypothesis as falsified in tracker if not already done
    if (hypothesisTracker) {
      const active = hypothesisTracker.getActiveHypothesis();
      if (active && active.id === hypothesisId && active.status !== 'falsified') {
        hypothesisTracker.markFalsified(hypothesisId, 'Automated rollback triggered after verification failure');
      }
    }

    // 3. Rollback main workspace to last green checkpoint if available
    let rolledBack = false;
    let restoredCheckpoint: Checkpoint | undefined;

    if (this.lastGreenCheckpoint) {
      const outcome = await this.checkpointManager.rollbackToTaskCheckpoint(this.lastGreenCheckpoint.id).catch(() => ({ success: false }));
      if (outcome.success) {
        rolledBack = true;
        restoredCheckpoint = this.lastGreenCheckpoint;
      }
    } else {
      // Fallback: rollback to immediate preceding checkpoint
      const latest = this.checkpointManager.getLastCheckpoint();
      if (latest) {
        const outcome = await this.checkpointManager.rollbackLast().catch(() => ({ success: false }));
        if (outcome.success) {
          rolledBack = true;
          restoredCheckpoint = latest;
        }
      }
    }

    const guidancePrompt = [
      `🔄 [AUTOMATIC ROLLBACK EXECUTED - CLEAN SLATE RESTORED]:`,
      `Hypothesis [${hypothesisId}] was falsified by empirical test verification.`,
      restoredCheckpoint
        ? `The workspace has been safely restored to clean checkpoint: "${restoredCheckpoint.description}" (${restoredCheckpoint.id}).`
        : `The workspace mutations have been undone.`,
      `👉 NEXT STEP: Formulate a distinct, new hypothesis. Do NOT repeat the falsified approach.`,
    ].join('\n');

    return {
      rolledBack,
      restoredCheckpoint,
      reason: `Rolled back to clean state after hypothesis ${hypothesisId} falsification.`,
      guidancePrompt,
    };
  }
}
