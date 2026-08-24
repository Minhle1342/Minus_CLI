import fs from 'node:fs/promises';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeFileHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';

/**
 * Tool delete_file (Dedicated Safe File Deletion)
 * 
 * Xóa an toàn một file trong workspace với yêu cầu giải trình lý do (reason)
 * và kiểm tra hash để đảm bảo không xóa nhầm file đã bị sửa đổi.
 */
export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Safely delete a file from the workspace. Requires an explicit reason. Supports expectedFileHash to prevent deleting a modified file.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Relative path to the file to delete (e.g. "src/legacy-helper.ts")',
      },
      reason: {
        type: Type.STRING,
        description: 'Clear rationale explaining why this file should be removed from the codebase.',
      },
      expectedFileHash: {
        type: Type.STRING,
        description: 'Optional: contentHash from read_file to ensure deleting the expected version.',
      },
    },
    required: ['path', 'reason'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '').trim();
    const reason = String(args.reason || '').trim();
    const expectedFileHash = args.expectedFileHash ? String(args.expectedFileHash).trim() : undefined;

    if (!rawPath) {
      return toolError('"path" parameter is required.', 'INVALID_ARGS');
    }
    if (!reason) {
      return toolError('"reason" parameter explaining deletion is required.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return toolError(
          `Security violation: Cannot delete protected configuration file "${rawPath}".`,
          'SECURITY_VIOLATION',
        );
      }

      const currentHash = await computeFileHash(safePath);
      if (currentHash === 'sha256:absent') {
        return toolError(`File "${rawPath}" does not exist on disk to delete.`, 'FILE_NOT_FOUND', { path: rawPath });
      }

      if (expectedFileHash && expectedFileHash !== currentHash) {
        return toolError(
          `Content conflict (Stale File Hash) when deleting "${rawPath}". On-disk hash (${currentHash}) does not match expectedFileHash (${expectedFileHash}).`,
          'STALE_FILE_HASH',
          { path: rawPath, expectedHash: expectedFileHash, currentHash },
          'Inspect file content with read_file before deleting.',
        );
      }

      await fs.unlink(safePath);

      return toolSuccess({
        deleted: true,
        path: workspace.toRelativePath(safePath),
        previousHash: currentHash,
        reason,
        message: `Đã xóa thành công file "${rawPath}".`,
      });
    } catch (err: any) {
      return toolError(`Không thể xóa file: ${err.message}`, 'EXECUTION_ERROR', { path: rawPath });
    }
  },
};
