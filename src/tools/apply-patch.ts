import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { PatchEngine } from '../patch/patch-engine.js';
import { computeFileHash, computeStringHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';

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
        description: 'Mức độ chấp nhận sai lệch (0: exact line/text, 1: normalize whitespace/indentation, 2: context reduction, 3: fuzzy similarity advisory). Mặc định là 2.',
      },
      expectedFileHashes: {
        type: Type.OBJECT,
        description: 'Bản đồ đường dẫn file -> contentHash (lấy từ read_file) để ngăn ngừa ghi đè nội dung cũ (optimistic locking).',
        additionalProperties: {
          type: Type.STRING,
        },
      } as any,
    },
    required: ['patch'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPatch = String(args.patch || '').trim();
    const defaultPath = args.path ? String(args.path).trim() : undefined;
    const fuzzLevel = typeof args.fuzzLevel === 'number' ? Math.max(0, Math.min(3, args.fuzzLevel)) : 2;
    const expectedFileHashes = (typeof args.expectedFileHashes === 'object' && args.expectedFileHashes !== null)
      ? (args.expectedFileHashes as Record<string, string>)
      : undefined;

    if (!rawPatch) {
      return toolError('Tham số "patch" không được để trống.', 'INVALID_ARGS');
    }

    try {
      // 1. Parse patch để kiểm tra danh sách file và tính an toàn
      const parsed = PatchEngine.parsePatch(rawPatch, defaultPath);

      if (parsed.files.length === 0) {
        return toolError('Nội dung patch không chứa hunk hoặc file hợp lệ nào.', 'INVALID_PATCH');
      }

      // 2. Kiểm tra an toàn path, protected files và expectedFileHashes cho tất cả các file
      for (const file of parsed.files) {
        const targetPath = file.newPath || file.oldPath || defaultPath;
        if (targetPath) {
          let safePath: string;
          try {
            safePath = workspace.resolveSafePath(targetPath);
          } catch (err: any) {
            return toolError(`Đường dẫn "${targetPath}" vi phạm an toàn workspace: ${err.message}`, 'SECURITY_VIOLATION');
          }

          if (workspace.isProtectedFile(safePath)) {
            return toolError(`Security violation: Cannot modify or delete protected configuration file "${targetPath}".`, 'SECURITY_VIOLATION');
          }

          if (expectedFileHashes && expectedFileHashes[targetPath]) {
            const currentHash = await computeFileHash(safePath);
            const expectedHash = expectedFileHashes[targetPath];
            if (currentHash !== expectedHash) {
              return toolError(
                `Content conflict (Stale File Hash) for "${targetPath}". On-disk hash (${currentHash}) does not match expected hash (${expectedHash}).`,
                'STALE_FILE_HASH',
                { path: targetPath, expectedHash, currentHash },
                'Use read_file to inspect latest content and recreate the patch.',
              );
            }
          }
        }
      }

      // 3. Thực thi áp dụng Patch qua PatchEngine
      const result = await PatchEngine.applyPatch(parsed, workspace, {
        defaultPath,
        maxFuzzLevel: fuzzLevel,
      });

      if (!result.success) {
        const failedFile = result.fileResults.find((f) => !f.success);
        const failedHunk = failedFile?.hunkResults.find((h) => !h.applied);
        const failedHunkNumber = failedHunk ? failedHunk.hunkIndex + 1 : undefined;

        let suggestedRead: { path: string; startLine: number; endLine: number } | undefined;
        if (failedFile && failedFile.path && failedFile.path !== 'unknown') {
          const hunkData = parsed.files.find((f) => (f.newPath || f.oldPath || defaultPath) === failedFile.path)?.hunks[failedHunk?.hunkIndex ?? 0];
          const approxLine = hunkData?.oldStart || 1;
          suggestedRead = {
            path: failedFile.path,
            startLine: Math.max(1, approxLine - 10),
            endLine: approxLine + Math.max(20, hunkData?.oldLines || 10) + 10,
          };
        }

        return {
          success: false,
          error: result.error || 'Failed to apply patch.',
          errorCode: result.error?.includes('FUZZY_CANDIDATE_FOUND') ? 'FUZZY_CANDIDATE_FOUND' : 'PATCH_APPLY_FAILED',
          failedFile: failedFile?.path,
          failedHunkNumber,
          suggestedRead,
          recommendedFallback: 'replace_text',
          suggestion: suggestedRead
            ? `Use read_file with path: "${suggestedRead.path}", startLine: ${suggestedRead.startLine}, endLine: ${suggestedRead.endLine} to inspect exact line context, or switch to replace_text.`
            : 'Use read_file to inspect latest content or switch to replace_text with exact strings.',
          fileResults: result.fileResults,
        };
      }

      const diffHash = computeStringHash(JSON.stringify(result.fileResults));

      let diagnosticWarning: string | undefined;
      let syntaxErrors: any[] | undefined;
      try {
        const touched = [...(result.filesModified || []), ...(result.filesCreated || [])];
        const diags = await CodeSyntaxValidator.validateFiles(touched, workspace);
        if (diags.length > 0) {
          syntaxErrors = diags;
          diagnosticWarning = `⚠️ LINTER ALERT (${diags.length} unresolved syntax / missing import issue(s)):\n` +
            diags.map((d) => `  • [${d.file}] Line ${d.line}: ${d.message}`).join('\n') +
            `\n👉 ACTION REQUIRED: Add the missing import statement at the top of the file(s) or fix the syntax error now.`;
        }
      } catch {}

      return {
        success: true,
        filesModified: result.filesModified,
        filesCreated: result.filesCreated,
        filesDeleted: result.filesDeleted,
        totalHunks: result.totalHunks,
        hunksApplied: result.hunksApplied,
        fileResults: result.fileResults,
        diffHash,
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      };
    } catch (err: any) {
      return toolError(`Lỗi xử lý patch: ${err.message}`, 'PATCH_ERROR');
    }
  },
};