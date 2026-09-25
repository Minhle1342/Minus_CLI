import type { CheckpointManager } from '../../workspace/checkpoint.js';
import type { GreenCheckpoint } from '../control-plane-state.js';
import type { GreenCheckpointManager } from './green-checkpoint-manager.js';

export interface RollbackResult {
  success: boolean;
  restoredCheckpointId?: string;
  reason: string;
  revertedFiles: string[];
}

export class ControlPlaneRollbackEngine {
  private checkpointManager?: CheckpointManager;
  private greenManager: GreenCheckpointManager;

  constructor(greenManager: GreenCheckpointManager, checkpointManager?: CheckpointManager) {
    this.greenManager = greenManager;
    this.checkpointManager = checkpointManager;
  }

  setCheckpointManager(checkpointManager: CheckpointManager): void {
    this.checkpointManager = checkpointManager;
  }

  /**
   * Rolls back the workspace to the specified or latest green checkpoint.
   */
  async rollbackToGreen(targetCheckpointId?: string, reason = 'Rollback to verified green state'): Promise<RollbackResult> {
    const target = targetCheckpointId
      ? this.greenManager.getCheckpoint(targetCheckpointId)
      : this.greenManager.getLastGreen();

    if (!target) {
      // Fallback to git / checkpoint manager immediate undo
      if (this.checkpointManager) {
        const fallback = await this.checkpointManager.rollbackLast();
        return {
          success: fallback.success,
          restoredCheckpointId: fallback.checkpoint?.id,
          reason: fallback.message,
          revertedFiles: [],
        };
      }

      return {
        success: false,
        reason: 'No green checkpoint available to restore.',
        revertedFiles: [],
      };
    }

    if (this.checkpointManager) {
      const outcome = await this.checkpointManager.rollbackToTaskCheckpoint(target.checkpointId).catch(async () => {
        // Fallback to last checkpoint
        return await this.checkpointManager!.rollbackLast();
      });

      this.greenManager.truncateAfter(target.checkpointId);

      return {
        success: outcome.success,
        restoredCheckpointId: target.checkpointId,
        reason: `${reason} -> Restored ${target.checkpointId} ("${target.description}")`,
        revertedFiles: [],
      };
    }

    this.greenManager.truncateAfter(target.checkpointId);
    return {
      success: true,
      restoredCheckpointId: target.checkpointId,
      reason: `${reason} -> Restored ${target.checkpointId}`,
      revertedFiles: [],
    };
  }
}
