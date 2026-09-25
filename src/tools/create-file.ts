import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeFileHash, computeStringHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';

/**
 * Tool create_file (Surgical Create-Only Tool)
 * 
 * Tạo một file mới trong workspace với semantic create-only.
 * Mặc định từ chối ghi đè file đã tồn tại (expectedAbsent: true).
 */
export const createFileTool: ToolDefinition = {
  name: 'create_file',
  description: 'Create a new file in the workspace. By default overwriting existing files is disallowed. To modify existing files, use replace_text or apply_patch.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Relative path to the new file to create (e.g. "src/utils/helper.ts")',
      },
      content: {
        type: Type.STRING,
        description: 'Complete text content for the new file',
      },
      expectedAbsent: {
        type: Type.BOOLEAN,
        description: 'Require that the file does not already exist on disk (default: true).',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '').trim();
    const content = String(args.content ?? '');
    const expectedAbsent = args.expectedAbsent !== false;

    if (!rawPath) {
      return toolError('"path" parameter is required.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return toolError(
          `Security violation: Cannot create or overwrite protected configuration file "${rawPath}".`,
          'SECURITY_VIOLATION',
        );
      }

      const currentHash = await computeFileHash(safePath);
      if (currentHash !== 'sha256:absent' && expectedAbsent) {
        return toolError(
          `File "${rawPath}" already exists on disk. create_file does not allow overwrite. Use replace_text or apply_patch to update.`,
          'FILE_ALREADY_EXISTS',
          { path: rawPath, currentHash },
          'Use read_file to inspect the current file content and use replace_text or apply_patch to modify.',
        );
      }

      const parentDir = path.dirname(safePath);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(safePath, content, 'utf-8');

      const contentHash = computeStringHash(content);
      const bytes = Buffer.byteLength(content, 'utf-8');

      return toolSuccess({
        path: workspace.toRelativePath(safePath),
        created: true,
        bytes,
        contentHash,
        message: `Đã tạo mới thành công file "${rawPath}" (${bytes} bytes).`,
      });
    } catch (err: any) {
      return toolError(`Không thể tạo file: ${err.message}`, 'EXECUTION_ERROR', { path: rawPath });
    }
  },
};
