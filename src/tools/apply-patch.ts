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
  description: 'Apply a Unified Diff patch (Codex CLI standard) to modify, create, or delete files with a smart Fuzz Matching engine. Supports multi-file diffs, automatic line-offset compensation, indentation normalization, and fuzzy context matching.\n\nSample 1-Shot Unified Diff:\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,3 +10,3 @@\n context line\n-old line\n+new line\n context line',
  parameters: {
    type: Type.OBJECT,
    properties: {
      patch: {
        type: Type.STRING,
        description: 'Unified Diff patch content (including --- / +++ / @@ hunks) or diff block. May contain multiple files in one patch. 1-Shot example:\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,3 +10,3 @@\n context line\n-old line\n+new line\n context line',
      },
      path: {
        type: Type.STRING,
        description: 'Optional: target file path if the patch only contains @@ hunk blocks without file headers (--- / +++).',
      },
      fuzzLevel: {
        type: Type.INTEGER,
        description: 'Tolerance for mismatch (0: exact line/text, 1: normalize whitespace/indentation, 2: context reduction, 3: fuzzy similarity advisory). Default is 2.',
      },
      expectedFileHashes: {
        type: Type.OBJECT,
        description: 'Map of file path -> LATEST contentHash from the most recent read_file to prevent overwriting stale content (optimistic locking). After each file edit the old hash expires: the next patch must read_file again for a fresh hash. Never reuse a hash across 2 edits, and never omit this field to bypass conflicts.',
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
      return toolError('The "patch" parameter must not be empty.', 'INVALID_ARGS');
    }

    try {
      // 1. Parse patch để kiểm tra danh sách file và tính an toàn
      const parsed = PatchEngine.parsePatch(rawPatch, defaultPath);

      if (parsed.files.length === 0) {
        return toolError('Patch content contains no valid hunks or files.', 'INVALID_PATCH');
      }

      // 2. Kiểm tra an toàn path, protected files và expectedFileHashes cho tất cả các file
      for (const file of parsed.files) {
        const targetPath = file.newPath || file.oldPath || defaultPath;
        if (targetPath) {
          let safePath: string;
          try {
            safePath = workspace.resolveSafePath(targetPath);
          } catch (err: any) {
            return toolError(`Path "${targetPath}" violates workspace safety: ${err.message}`, 'SECURITY_VIOLATION');
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
                'Do NOT retry with the same patch or merely swap in the returned hash: the file changed since your last read (possibly by your own earlier edit). Re-read the current content with read_file, rebuild the patch against that version, and retry with its new contentHash. Never omit expectedFileHashes to bypass a conflict.',
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
        let similarFiles: string[] = [];
        if (failedFile && failedFile.path && failedFile.path !== 'unknown') {
          const hunkData = parsed.files.find((f) => (f.newPath || f.oldPath || defaultPath) === failedFile.path)?.hunks[failedHunk?.hunkIndex ?? 0];
          const approxLine = hunkData?.oldStart || 1;
          suggestedRead = {
            path: failedFile.path,
            startLine: Math.max(1, approxLine - 10),
            endLine: approxLine + Math.max(20, hunkData?.oldLines || 10) + 10,
          };
          if (failedFile.error && (failedFile.error.includes('ENOENT') || failedFile.error.includes('Cannot read file'))) {
            try {
              similarFiles = await workspace.findSimilarWorkspaceFiles(failedFile.path, 3);
            } catch {}
          }
        }

        let suggestion = 'Use read_file to inspect latest content or switch to replace_text with exact strings.';
        if (result.error?.includes('PRE_COMMIT_SYNTAX_ERROR')) {
          suggestion = 'Check and fix the syntax errors in the patch before retrying.';
        } else if (similarFiles.length > 0) {
          suggestion = `File "${failedFile?.path}" does not exist. Found similar files: ${JSON.stringify(similarFiles)}. Call apply_patch or replace_text again with the correct path "${similarFiles[0]}".`;
        } else if (suggestedRead) {
          suggestion = `Use read_file with path: "${suggestedRead.path}", startLine: ${suggestedRead.startLine}, endLine: ${suggestedRead.endLine} to inspect exact line context, or switch to replace_text.`;
        }

        return {
          success: false,
          error: result.error || 'Failed to apply patch.',
          errorCode: result.error?.includes('PRE_COMMIT_SYNTAX_ERROR')
            ? 'PRE_COMMIT_SYNTAX_ERROR'
            : result.error?.includes('TRANSACTION_ROLLBACK')
            ? 'TRANSACTION_ROLLBACK'
            : result.error?.includes('FUZZY_CANDIDATE_FOUND')
            ? 'FUZZY_CANDIDATE_FOUND'
            : 'PATCH_APPLY_FAILED',
          failedFile: failedFile?.path,
          failedHunkNumber,
          suggestedRead,
          similarFiles: similarFiles.length > 0 ? similarFiles : undefined,
          recommendedFallback: 'replace_text',
          suggestion,
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
      return toolError(`Failed to process patch: ${err.message}`, 'PATCH_ERROR');
    }
  },
};