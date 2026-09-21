import fs from 'node:fs/promises';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeStringHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';
import {
  detectChangedSymbols,
  calculateComprehensiveBlastRadius,
  invalidateTopologyCache,
} from './mutation-blast-radius.js';

/**
 * replace_file_content Tool (Antigravity & Claude-Code Standard)
 * 
 * Thay thế một khối nội dung đơn lẻ liền kề (single contiguous block) trong file
 * theo phạm vi dòng StartLine và EndLine (1-indexed).
 */
export const replaceFileContentTool: ToolDefinition = {
  name: 'replace_file_content',
  description: 'Replace one contiguous content block in an existing file within the 1-based StartLine–EndLine range. TargetContent must exactly match the file content, including indentation. Automatically handles LF/CRLF differences and analyzes blast radius.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: {
        type: Type.STRING,
        description: 'Absolute or workspace-relative path to the file to edit (for example, "src/index.ts").',
      },
      Instruction: {
        type: Type.STRING,
        description: 'Brief summary of the edit being made to the file.',
      },
      Description: {
        type: Type.STRING,
        description: 'Explain the reason for the change and its technical context for the user.',
      },
      StartLine: {
        type: Type.INTEGER,
        description: 'First line of the range containing TargetContent (1-based, inclusive).',
      },
      EndLine: {
        type: Type.INTEGER,
        description: 'Last line of the range containing TargetContent (1-based, inclusive).',
      },
      TargetContent: {
        type: Type.STRING,
        description: 'Exact text or source code to replace. It must exactly match the file content.',
      },
      ReplacementContent: {
        type: Type.STRING,
        description: 'Complete new content that replaces TargetContent.',
      },
      AllowMultiple: {
        type: Type.BOOLEAN,
        description: 'When true, replace every TargetContent occurrence in the range. When false, return an error if more than one occurrence is found.',
      },
      TargetLintErrorIds: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Optional list of lint error IDs this change is intended to resolve.',
      },
    },
    required: [
      'TargetFile',
      'Instruction',
      'Description',
      'StartLine',
      'EndLine',
      'TargetContent',
      'ReplacementContent',
      'AllowMultiple',
    ],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.TargetFile || args.targetFile || args.path || args.filePath || '').trim();
    let targetContent = args.TargetContent;
    if (!targetContent || (typeof targetContent === 'string' && targetContent.trim() === '')) {
      targetContent = args.targetContent ?? args.oldText ?? args.old_text ?? args.searchContent ?? '';
    }
    targetContent = String(targetContent ?? '');

    let replacementContent = args.ReplacementContent;
    if (replacementContent === undefined || replacementContent === null) {
      replacementContent = args.replacementContent ?? args.newText ?? args.new_text ?? args.replaceWith ?? '';
    }
    replacementContent = String(replacementContent ?? '');

    const allowMultiple = args.AllowMultiple === true || args.allowMultiple === true;
    const startLine = typeof args.StartLine === 'number' ? args.StartLine : typeof args.startLine === 'number' ? args.startLine : 1;
    const endLine = typeof args.EndLine === 'number' ? args.EndLine : typeof args.endLine === 'number' ? args.endLine : Infinity;

    if (!rawPath) {
      return toolError('Tham số "TargetFile" là bắt buộc.', 'INVALID_ARGS');
    }
    if (targetContent === '') {
      return toolError(
        'Tham số "TargetContent" không được để trống. replace_file_content yêu cầu nội dung cần thay thế. Nếu muốn tạo mới hoặc ghi đè toàn bộ file, hãy dùng "write_to_file".',
        'INVALID_ARGS',
        { suggestedAction: 'Cung cấp đoạn code cần thay thế vào "TargetContent", hoặc dùng write_to_file để tạo mới/ghi đè toàn bộ file.' }
      );
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return toolError(
          `Bảo mật: Không được phép chỉnh sửa file cấu hình nhạy cảm "${rawPath}".`,
          'SECURITY_VIOLATION',
        );
      }

      let stat;
      try {
        stat = await fs.stat(safePath);
      } catch {
        return toolError(`File "${rawPath}" không tồn tại trên đĩa.`, 'FILE_NOT_FOUND', { TargetFile: rawPath });
      }

      if (!stat.isFile()) {
        return toolError(`"${rawPath}" không phải là file hợp lệ.`, 'INVALID_ARGS', { TargetFile: rawPath });
      }

      const originalRawContent = await fs.readFile(safePath, 'utf-8');
      const isCRLF = originalRawContent.includes('\r\n');
      const normalizedOriginal = originalRawContent.replace(/\r\n/g, '\n');
      const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
      const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n');

      const lines = normalizedOriginal.split('\n');
      const totalLines = lines.length;

      // Giới hạn phạm vi 0-indexed dòng
      const clampedStart = Math.max(0, Math.min(startLine - 1, totalLines - 1));
      const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));

      const rangeLines = lines.slice(clampedStart, clampedEnd);
      const rangeText = rangeLines.join('\n');

      let updatedContent: string;
      let occurrencesReplaced = 0;
      let note: string | undefined;

      if (rangeText.includes(normalizedTarget)) {
        // Tìm thấy trong phạm vi dòng chỉ định
        const occurrences = rangeText.split(normalizedTarget).length - 1;
        if (occurrences > 1 && !allowMultiple) {
          return toolError(
            `TargetContent xuất hiện ${occurrences} lần trong phạm vi dòng [${startLine}, ${endLine}] và AllowMultiple=false. Hãy thu hẹp phạm vi dòng hoặc đặt AllowMultiple=true.`,
            'AMBIGUOUS_REPLACEMENT',
            { TargetFile: rawPath, occurrences },
          );
        }

        const replacedRangeText = allowMultiple
          ? rangeText.replaceAll(normalizedTarget, normalizedReplacement)
          : rangeText.replace(normalizedTarget, normalizedReplacement);

        const beforeRange = lines.slice(0, clampedStart).join('\n');
        const afterRange = lines.slice(clampedEnd).join('\n');

        const parts = [];
        if (clampedStart > 0) parts.push(beforeRange);
        parts.push(replacedRangeText);
        if (clampedEnd < totalLines) parts.push(afterRange);

        updatedContent = parts.join('\n');
        occurrencesReplaced = occurrences;
      } else if (normalizedOriginal.includes(normalizedTarget)) {
        // Fallback: Tìm thấy ở vị trí khác trong file (lệch dòng do sửa đổi trước đó)
        const totalOccurrences = normalizedOriginal.split(normalizedTarget).length - 1;
        if (totalOccurrences > 1 && !allowMultiple) {
          return toolError(
            `Không tìm thấy TargetContent trong dòng [${startLine}, ${endLine}], nhưng tìm thấy ${totalOccurrences} lần trong toàn file. Vì AllowMultiple=false nên không thể tự động thay thế. Hãy chỉ định lại phạm vi dòng chính xác.`,
            'AMBIGUOUS_REPLACEMENT',
            { TargetFile: rawPath, totalOccurrences },
          );
        }

        updatedContent = allowMultiple
          ? normalizedOriginal.replaceAll(normalizedTarget, normalizedReplacement)
          : normalizedOriginal.replace(normalizedTarget, normalizedReplacement);

        occurrencesReplaced = totalOccurrences;
        note = 'Lưu ý: TargetContent không nằm đúng phạm vi dòng chỉ định nhưng đã được tìm thấy và thay thế duy nhất trong file.';
      } else {
        // Không tìm thấy bất kỳ đâu trong file
        return toolError(
          `Không tìm thấy TargetContent trong file "${rawPath}" (phạm vi dòng [${startLine}, ${endLine}]). Hãy kiểm tra lại khoảng trắng đầu dòng hoặc đọc lại file để lấy nội dung mới nhất.`,
          'PATCH_ERROR',
          { TargetFile: rawPath, startLine, endLine },
          'Đọc lại file bằng view_file hoặc read_file để lấy đúng nội dung trước khi thay thế.',
        );
      }

      // Khôi phục kiểu ngắt dòng ban đầu nếu là CRLF
      const finalContent = isCRLF ? updatedContent.replace(/\n/g, '\r\n') : updatedContent;

      await fs.writeFile(safePath, finalContent, 'utf-8');
      invalidateTopologyCache();

      let blastRadiusSummary: any;
      try {
        const modifiedSymbols = detectChangedSymbols(rawPath, originalRawContent, finalContent);
        const blast = calculateComprehensiveBlastRadius({
          workspace,
          filePath: rawPath,
          modifiedSymbols,
          depth: 2,
        });
        blastRadiusSummary = {
          risk: blast.risk,
          score: blast.score,
          depth: blast.depth,
          modifiedSymbols: blast.modifiedSymbols.map((s) => s.name),
          directConsumers: blast.directConsumers,
          transitiveFiles: blast.transitiveFiles,
          impactedTestSuites: blast.impactedTestSuites,
          callersCount: blast.callers.length,
          publicApiAffected: blast.publicApiAffected,
          breakingChange: blast.breakingChange,
          warnings: blast.warnings,
          recommendedActions: blast.recommendedActions,
        };
      } catch {}

      const contentHash = computeStringHash(finalContent);

      let diagnosticWarning: string | undefined;
      let syntaxErrors: any[] | undefined;
      try {
        const diags = await CodeSyntaxValidator.validateFile(rawPath, workspace);
        if (diags.length > 0) {
          syntaxErrors = diags;
          diagnosticWarning = `⚠️ LINTER ALERT (${diags.length} unresolved syntax / missing import issue(s)):\n` +
            diags.map((d) => `  • Line ${d.line}: ${d.message}`).join('\n') +
            `\n👉 ACTION REQUIRED: Fix the syntax errors or missing imports in "${rawPath}".`;
        }
      } catch {}

      return toolSuccess({
        path: workspace.toRelativePath(safePath),
        TargetFile: workspace.toRelativePath(safePath),
        occurrencesReplaced,
        contentHash,
        message: `Đã thay thế thành công ${occurrencesReplaced} vị trí trong file "${rawPath}".${note ? ` (${note})` : ''}`,
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Lỗi khi thay thế nội dung file: ${err.message}`, 'EXECUTION_ERROR', { TargetFile: rawPath });
    }
  },
};
