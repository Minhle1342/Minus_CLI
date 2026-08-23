import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { PatchEngine } from '../patch/patch-engine.js';

/**
 * Tool apply_patch (Codex CLI Unified Patch Engine)
 * 
 * Áp dụng Unified Diff patch để sửa đổi, tạo mới, hoặc xóa file với engine Fuzz Matching thông minh.
 * Hỗ trợ multi-file diff, tự động bù trừ lệch dòng (line offset), chuẩn hóa thụt đầu dòng (indentation tolerance), và matching mờ (fuzzy context matching).
 */
export const applyPatchTool: ToolDefinition = {
  name: 'apply_patch',
  description: 'Áp dụng Unified Diff patch (chuẩn Codex CLI) để sửa đổi, tạo mới, hoặc xóa file với engine Fuzz Matching thông minh. Hỗ trợ multi-file diff, tự động bù trừ lệch dòng (line offset), chuẩn hóa thụt đầu dòng (indentation tolerance), và matching mờ (fuzzy context matching).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      patch: {
        type: Type.STRING,
        description: 'Nội dung Unified Diff patch (bao gồm --- / +++ / @@ hunks) hoặc khối diff. Có thể chứa nhiều file trong cùng một patch.',
      },
      path: {
        type: Type.STRING,
        description: 'Tùy chọn: Đường dẫn file mục tiêu nếu patch chỉ chứa các khối hunk @@ mà không có header file (--- / +++).',
      },
      fuzzLevel: {
        type: Type.INTEGER,
        description: 'Mức độ chấp nhận sai lệch (0: exact line/text, 1: normalize whitespace/indentation, 2: context reduction, 3: fuzzy similarity). Mặc định là 2.',
      },
    },
    required: ['patch'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPatch = String(args.patch || '').trim();
    const defaultPath = args.path ? String(args.path).trim() : undefined;
    const fuzzLevel = typeof args.fuzzLevel === 'number' ? Math.max(0, Math.min(3, args.fuzzLevel)) : 2;

    if (!rawPatch) {
      return { error: 'Tham số "patch" không được để trống.' };
    }

    try {
      // 1. Parse patch để kiểm tra danh sách file và tính an toàn
      const parsed = PatchEngine.parsePatch(rawPatch, defaultPath);

      if (parsed.files.length === 0) {
        return {
          error: 'Nội dung patch không chứa hunk hoặc file hợp lệ nào.',
          errorCode: 'INVALID_PATCH',
        };
      }

      // 2. Kiểm tra an toàn path và protected files cho tất cả các file trong patch
      for (const file of parsed.files) {
        const targetPath = file.newPath || file.oldPath || defaultPath;
        if (targetPath) {
          try {
            workspace.resolveSafePath(targetPath);
          } catch (err: any) {
            return {
              error: `Đường dẫn "${targetPath}" vi phạm an toàn workspace: ${err.message}`,
              errorCode: 'SECURITY_VIOLATION',
            };
          }

          if (workspace.isProtectedFile(targetPath)) {
            return {
              error: `Bảo mật: Không được phép chỉnh sửa hoặc xóa file cấu hình nhạy cảm "${targetPath}".`,
              errorCode: 'SECURITY_VIOLATION',
            };
          }
        }
      }

      // 3. Thực thi áp dụng Patch qua PatchEngine
      const result = await PatchEngine.applyPatch(parsed, workspace, {
        defaultPath,
        maxFuzzLevel: fuzzLevel,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Áp dụng patch thất bại.',
          errorCode: 'PATCH_APPLY_FAILED',
          fileResults: result.fileResults,
          suggestion: 'Hãy đọc lại file bằng read_file để lấy nội dung mới nhất hoặc giảm bớt context trong khối hunk @@.',
        };
      }

      return {
        success: true,
        filesModified: result.filesModified,
        filesCreated: result.filesCreated,
        filesDeleted: result.filesDeleted,
        totalHunks: result.totalHunks,
        hunksApplied: result.hunksApplied,
        fileResults: result.fileResults,
      };
    } catch (err: any) {
      return {
        error: `Lỗi xử lý patch: ${err.message}`,
        errorCode: 'PATCH_ERROR',
      };
    }
  },
};