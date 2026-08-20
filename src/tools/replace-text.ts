import fs from 'node:fs/promises';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

/**
 * Tool 4: replace_text
 * Thay thế một đoạn văn bản/code chính xác (surgical edit) trong một file.
 * Bắt buộc oldText phải khớp duy nhất 1 lần để tránh sửa nhầm chỗ.
 */
export const replaceTextTool: ToolDefinition = {
  name: 'replace_text',
  description: 'Thay thế một đoạn văn bản chính xác (oldText) bằng đoạn văn bản mới (newText) trong một file. Yêu cầu oldText phải khớp duy nhất 1 lần.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn tương đối tới file cần sửa (ví dụ: "src/index.ts")',
      },
      oldText: {
        type: Type.STRING,
        description: 'Đoạn văn bản/code gốc cần thay thế (phải trùng khớp chính xác 100%, bao gồm khoảng trắng/xuống dòng)',
      },
      newText: {
        type: Type.STRING,
        description: 'Đoạn văn bản/code mới sẽ thay thế vào',
      },
    },
    required: ['path', 'oldText', 'newText'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '');
    const oldText = String(args.oldText ?? '');
    const newText = String(args.newText ?? '');

    if (!rawPath) {
      return { error: 'Tham số "path" là bắt buộc.' };
    }
    if (!oldText) {
      return { error: 'Tham số "oldText" không được để trống.' };
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (!stat.isFile()) {
        return { path: rawPath, error: `"${rawPath}" không phải là file.` };
      }

      const content = await fs.readFile(safePath, 'utf-8');

      // Đếm số lần xuất hiện của oldText
      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        return {
          path: rawPath,
          error: `Không tìm thấy đoạn text gốc (oldText) trong "${rawPath}". Vui lòng dùng tool "read_file" để kiểm tra nội dung chính xác trước khi sửa.`,
        };
      }

      if (occurrences > 1) {
        return {
          path: rawPath,
          error: `Đoạn text gốc (oldText) xuất hiện ${occurrences} lần trong "${rawPath}". Vui lòng lấy thêm các dòng ngữ cảnh xung quanh để đảm bảo tính duy nhất.`,
        };
      }

      // Thay thế chính xác duy nhất 1 lần
      const updatedContent = content.replace(oldText, newText);
      await fs.writeFile(safePath, updatedContent, 'utf-8');

      return {
        path: rawPath,
        success: true,
        message: `Đã thay thế thành công 1 vị trí trong "${rawPath}".`,
      };
    } catch (err: any) {
      return {
        path: rawPath,
        error: `Không thể thay thế nội dung file: ${err.message}`,
      };
    }
  },
};
