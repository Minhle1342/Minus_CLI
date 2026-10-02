import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeFileHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';

/**
 * Tool move_file (Safe File Move / Rename)
 * 
 * Di chuyển hoặc đổi tên file an toàn trong workspace.
 * Kiểm tra hash file nguồn và đảm bảo không ghi đè file đích.
 */
export const moveFileTool: ToolDefinition = {
  name: 'move_file',
  description: 'Move or rename a workspace file with this tool, not a shell command such as `mv`, `move`, or `Move-Item` (those are platform/shell dependent). Call with exactly `sourcePath` for the current path and `targetPath` for the new destination path; `targetPath` is required. Do not use `destinationPath` or `to`. Creates destination directories as needed and prevents overwriting an existing destination file.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      sourcePath: {
        type: Type.STRING,
        description: 'Required current source-file path, workspace-relative (for example, "src/old-name.ts").',
      },
      targetPath: {
        type: Type.STRING,
        description: 'Required new destination-file path, workspace-relative (for example, "src/new-name.ts"). Use this exact parameter name; do not send destinationPath or to.',
      },
      expectedSourceHash: {
        type: Type.STRING,
        description: 'Optional source-file contentHash from read_file to ensure the expected version is moved.',
      },
    },
    required: ['sourcePath', 'targetPath'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawSource = String(args.sourcePath || '').trim();
    const rawTarget = String(args.targetPath || '').trim();
    const expectedSourceHash = args.expectedSourceHash ? String(args.expectedSourceHash).trim() : undefined;

    if (!rawSource || !rawTarget) {
      return toolError('Both "sourcePath" and "targetPath" are required.', 'INVALID_ARGS');
    }

    try {
      const safeSource = workspace.resolveSafePath(rawSource);
      const safeTarget = workspace.resolveSafePath(rawTarget);

      if (workspace.isProtectedFile(safeSource) || workspace.isProtectedFile(safeTarget)) {
        return toolError(
          'Security: moving or renaming sensitive configuration files is not allowed.',
          'SECURITY_VIOLATION',
        );
      }

      const sourceHash = await computeFileHash(safeSource);
      if (sourceHash === 'sha256:absent') {
        return toolError(`Source file "${rawSource}" does not exist.`, 'FILE_NOT_FOUND', { path: rawSource });
      }

      if (expectedSourceHash && expectedSourceHash !== sourceHash) {
        return toolError(
          `Content conflict when moving "${rawSource}". On-disk hash (${sourceHash}) does not match expectedSourceHash (${expectedSourceHash}).`,
          'STALE_FILE_HASH',
          { path: rawSource, expectedHash: expectedSourceHash, currentHash: sourceHash },
        );
      }

      const targetHash = await computeFileHash(safeTarget);
      if (targetHash !== 'sha256:absent') {
        return toolError(
          `Target file "${rawTarget}" already exists. move_file does not allow overwriting.`,
          'FILE_ALREADY_EXISTS',
          { path: rawTarget },
        );
      }

      await fs.mkdir(path.dirname(safeTarget), { recursive: true });
      await fs.rename(safeSource, safeTarget);

      return toolSuccess({
        moved: true,
        sourcePath: workspace.toRelativePath(safeSource),
        targetPath: workspace.toRelativePath(safeTarget),
        contentHash: sourceHash,
        message: `Successfully moved from "${rawSource}" to "${rawTarget}".`,
      });
    } catch (err: any) {
      return toolError(`Failed to move file: ${err.message}`, 'EXECUTION_ERROR', { sourcePath: rawSource, targetPath: rawTarget });
    }
  },
};
