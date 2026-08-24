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
  description: 'Di chuyển hoặc đổi tên một file trong workspace. Tự động tạo thư mục đích nếu cần và chống ghi đè lên file đích đã tồn tại.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      sourcePath: {
        type: Type.STRING,
        description: 'Đường dẫn file nguồn hiện tại (ví dụ: "src/old-name.ts")',
      },
      targetPath: {
        type: Type.STRING,
        description: 'Đường dẫn file đích mới (ví dụ: "src/new-name.ts")',
      },
      expectedSourceHash: {
        type: Type.STRING,
        description: 'Tuỳ chọn: contentHash của file nguồn từ read_file để đảm bảo phiên bản chính xác.',
      },
    },
    required: ['sourcePath', 'targetPath'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawSource = String(args.sourcePath || '').trim();
    const rawTarget = String(args.targetPath || '').trim();
    const expectedSourceHash = args.expectedSourceHash ? String(args.expectedSourceHash).trim() : undefined;

    if (!rawSource || !rawTarget) {
      return toolError('Cả "sourcePath" và "targetPath" đều là bắt buộc.', 'INVALID_ARGS');
    }

    try {
      const safeSource = workspace.resolveSafePath(rawSource);
      const safeTarget = workspace.resolveSafePath(rawTarget);

      if (workspace.isProtectedFile(safeSource) || workspace.isProtectedFile(safeTarget)) {
        return toolError(
          'Bảo mật: Không được phép di chuyển hoặc đổi tên file cấu hình nhạy cảm.',
          'SECURITY_VIOLATION',
        );
      }

      const sourceHash = await computeFileHash(safeSource);
      if (sourceHash === 'sha256:absent') {
        return toolError(`File nguồn "${rawSource}" không tồn tại.`, 'FILE_NOT_FOUND', { path: rawSource });
      }

      if (expectedSourceHash && expectedSourceHash !== sourceHash) {
        return toolError(
          `Xung đột nội dung khi di chuyển "${rawSource}". Hash thực tế (${sourceHash}) khác với expectedSourceHash (${expectedSourceHash}).`,
          'STALE_FILE_HASH',
          { path: rawSource, expectedHash: expectedSourceHash, currentHash: sourceHash },
        );
      }

      const targetHash = await computeFileHash(safeTarget);
      if (targetHash !== 'sha256:absent') {
        return toolError(
          `File đích "${rawTarget}" đã tồn tại. move_file không cho phép ghi đè.`,
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
        message: `Đã di chuyển thành công từ "${rawSource}" sang "${rawTarget}".`,
      });
    } catch (err: any) {
      return toolError(`Không thể di chuyển file: ${err.message}`, 'EXECUTION_ERROR', { sourcePath: rawSource, targetPath: rawTarget });
    }
  },
};
