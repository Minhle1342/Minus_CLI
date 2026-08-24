import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeStringHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';

/**
 * Tool 5: write_file
 * Tạo một file mới hoặc ghi đè toàn bộ nội dung của một file trong workspace.
 * Tự động tạo các thư mục cha nếu chưa tồn tại.
 */
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Tạo một file mới hoặc ghi đè toàn bộ nội dung file trong workspace. Thích hợp khi tạo file mới hoàn toàn.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file cần tạo hoặc ghi đè (ví dụ: "src/utils/helper.ts")',
      },
      content: {
        type: Type.STRING,
        description: 'Toàn bộ nội dung văn bản sẽ ghi vào file',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '');
    const content = String(args.content ?? '');

    if (!rawPath) {
      return toolError('Tham số "path" là bắt buộc.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      
      if (workspace.isProtectedFile(safePath)) {
        return toolError(
          `Bảo mật: Không được phép chỉnh sửa hoặc ghi đè file cấu hình nhạy cảm "${rawPath}".`,
          'SECURITY_VIOLATION',
        );
      }

      // Kiểm tra xem file đã tồn tại trước đó chưa
      let isExisting = false;
      try {
        await fs.access(safePath);
        isExisting = true;
      } catch {
        isExisting = false;
      }

      // Đảm bảo thư mục cha tồn tại
      const parentDir = path.dirname(safePath);
      await fs.mkdir(parentDir, { recursive: true });

      // Ghi nội dung file
      await fs.writeFile(safePath, content, 'utf-8');

      const bytesWritten = Buffer.byteLength(content, 'utf-8');
      const contentHash = computeStringHash(content);

      return toolSuccess({
        path: workspace.toRelativePath(safePath),
        bytesWritten,
        contentHash,
        created: !isExisting,
        message: isExisting
          ? `Đã ghi đè thành công file "${rawPath}".`
          : `Đã tạo mới thành công file "${rawPath}".`,
      });
    } catch (err: any) {
      return toolError(`Không thể ghi file: ${err.message}`, 'EXECUTION_ERROR', { path: rawPath });
    }
  },
};
