import type { GreenCheckpoint } from '../control-plane-state.js';

export class GreenCheckpointManager {
  private checkpoints: GreenCheckpoint[] = [];
  private counter = 0;

  recordGreenCheckpoint(params: {
    workspaceDigest: string;
    mutationSeq: number;
    evidenceIds: string[];
    description: string;
    gitState?: string;
    verifiedInvariants?: string[];
  }): GreenCheckpoint {
    this.counter++;
    const checkpointId = `G${this.counter}_${Date.now()}`;

    const cp: GreenCheckpoint = {
      checkpointId,
      workspaceDigest: params.workspaceDigest,
      mutationSeq: params.mutationSeq,
      evidenceIds: [...params.evidenceIds],
      gitState: params.gitState,
      createdAt: Date.now(),
      verifiedInvariants: params.verifiedInvariants || ['INV_COMPILER_SYNTAX', 'INV_FRESH_EVIDENCE'],
      description: params.description,
    };

    this.checkpoints.push(cp);
    return cp;
  }

  getLastGreen(): GreenCheckpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  getCheckpoint(checkpointId: string): GreenCheckpoint | undefined {
    return this.checkpoints.find((c) => c.checkpointId === checkpointId);
  }

  getAll(): GreenCheckpoint[] {
    return [...this.checkpoints];
  }

  truncateAfter(checkpointId: string): void {
    const idx = this.checkpoints.findIndex((c) => c.checkpointId === checkpointId);
    if (idx >= 0) {
      this.checkpoints = this.checkpoints.slice(0, idx + 1);
    }
  }
}
