import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import type { CheckpointManager } from '../workspace/checkpoint.js';

/**
 * Tool: session_diff
 * Harness-native equivalent of OpenCode's GET /session/:id/diff (no HTTP server here):
 * returns the unified diffs of one turn checkpoint (default: last).
 */
export function createSessionDiffTool(getManager: () => CheckpointManager | undefined): ToolDefinition {
  return {
    name: 'session_diff',
    description:
      'Show files changed in one turn checkpoint as unified diffs. ' +
      'Use to review what the current turn modified before verifying or submitting. ' +
      'Covers harness-tool edits; external or shell edits landing after the last recorded mutation may not appear, so treat a clean diff as inconclusive in that case. ' +
      'Returns checkpointId, totalFiles and diffs (filePath, diff, status).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        checkpointId: {
          type: Type.STRING,
          description: 'Turn checkpoint id (default: the last checkpoint).',
        },
      },
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const manager = getManager();
      if (!manager) return { error: 'No checkpoint manager is attached to this session.', errorCode: 'NO_CHECKPOINT_MANAGER' };
      const checkpointId = typeof args.checkpointId === 'string' && args.checkpointId.trim()
        ? args.checkpointId.trim()
        : undefined;
      if (checkpointId && !manager.getHistory().some(cp => cp.id === checkpointId)) {
        return { error: `Checkpoint "${checkpointId}" not found in the current session.`, errorCode: 'CHECKPOINT_NOT_FOUND' };
      }
      const diffs = await manager.diffTurn(checkpointId);
      const resolved = checkpointId ?? manager.getLastCheckpoint()?.id;
      if (!resolved) return { checkpointId: null, totalFiles: 0, diffs: [], message: 'No checkpoint found in the current session.' };
      return { checkpointId: resolved, totalFiles: diffs.length, diffs };
    },
  };
}
