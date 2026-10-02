import fs from 'node:fs/promises';
import { createPatch } from 'diff';
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
      return toolError('The "TargetFile" parameter is required.', 'INVALID_ARGS');
    }
    if (targetContent === '') {
      return toolError(
        'The "TargetContent" parameter must not be empty. replace_file_content requires content to replace. To create a new file or overwrite an entire file, use "write_to_file".',
        'INVALID_ARGS',
        { suggestedAction: 'Provide the code to replace in "TargetContent", or use write_to_file to create/overwrite an entire file.' }
      );
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return toolError(
          `Security: editing sensitive configuration file "${rawPath}" is not allowed.`,
          'SECURITY_VIOLATION',
        );
      }

      let stat;
      try {
        stat = await fs.stat(safePath);
      } catch {
        return toolError(`File "${rawPath}" does not exist on disk.`, 'FILE_NOT_FOUND', { TargetFile: rawPath });
      }

      if (!stat.isFile()) {
        return toolError(`"${rawPath}" is not a valid file.`, 'INVALID_ARGS', { TargetFile: rawPath });
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
            `TargetContent occurs ${occurrences} times in line range [${startLine}, ${endLine}] and AllowMultiple=false. Narrow the line range or set AllowMultiple=true.`,
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
            `TargetContent not found in lines [${startLine}, ${endLine}], but found ${totalOccurrences} time(s) in the whole file. Since AllowMultiple=false it cannot be replaced automatically. Specify the line range precisely.`,
            'AMBIGUOUS_REPLACEMENT',
            { TargetFile: rawPath, totalOccurrences },
          );
        }

        updatedContent = allowMultiple
          ? normalizedOriginal.replaceAll(normalizedTarget, normalizedReplacement)
          : normalizedOriginal.replace(normalizedTarget, normalizedReplacement);

        occurrencesReplaced = totalOccurrences;
        note = 'Note: TargetContent was outside the specified line range but was found and replaced uniquely in the file.';
      } else {
        // Không tìm thấy bất kỳ đâu trong file
        return toolError(
          `TargetContent not found in file "${rawPath}" (line range [${startLine}, ${endLine}]). Check the leading whitespace or re-read the file for the latest content.`,
          'PATCH_ERROR',
          { TargetFile: rawPath, startLine, endLine },
          'Re-read the file with view_file or read_file to get the exact content before replacing.',
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

      let unifiedDiff: string | undefined;
      try {
        const patch = createPatch(rawPath, originalRawContent, finalContent, 'before', 'after');
        unifiedDiff = patch.length > 4000 ? patch.slice(0, 4000) + '\n... [diff truncated]' : patch;
      } catch {}

      return toolSuccess({
        path: workspace.toRelativePath(safePath),
        TargetFile: workspace.toRelativePath(safePath),
        occurrencesReplaced,
        contentHash,
        message: `Successfully replaced ${occurrencesReplaced} occurrence(s) in file "${rawPath}".${note ? ` (${note})` : ''}`,
        ...(unifiedDiff ? { unifiedDiff } : {}),
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Failed to replace file content: ${err.message}`, 'EXECUTION_ERROR', { TargetFile: rawPath });
    }
  },
};
