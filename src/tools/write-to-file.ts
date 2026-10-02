import fs from 'node:fs/promises';
import path from 'node:path';
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
 * write_to_file Tool (Antigravity & Claude-Code Standard)
 * 
 * Tạo file mới hoặc ghi đè toàn bộ nội dung file trong workspace.
 * Tự động tạo các thư mục cha nếu chưa tồn tại.
 * Mặc định báo lỗi an toàn nếu file đã tồn tại và Overwrite là false.
 */
export const writeToFileTool: ToolDefinition = {
  name: 'write_to_file',
  description: 'Create a new file or overwrite an entire file in the workspace (Antigravity standard). Automatically create parent directories if missing. By default it safely errors if the file already exists on disk unless Overwrite is explicitly true. Automatically returns contentHash, bytesWritten and blast-radius analysis.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: {
        type: Type.STRING,
        description: 'Absolute or relative path to the file to create or overwrite (e.g. "src/utils/helper.ts")',
      },
      CodeContent: {
        type: Type.STRING,
        description: 'Complete source code or text content to write to the file',
      },
      Overwrite: {
        type: Type.BOOLEAN,
        description: 'Required. Set true to allow overwriting if the file already exists; set false to refuse if the file is already on disk to prevent accidental overwrites.',
      },
      Description: {
        type: Type.STRING,
        description: 'Short, concise explanation of the change just made and the design rationale.',
      },
      ArtifactMetadata: {
        type: Type.OBJECT,
        description: 'Optional metadata attached if the created file is a documentation/plan artifact.',
        properties: {
          Summary: { type: Type.STRING, description: 'Summary of the artifact content' },
          UserFacing: { type: Type.BOOLEAN, description: 'True if this artifact is shown to the user' },
          RequestFeedback: { type: Type.BOOLEAN, description: 'True if requesting the user to confirm the plan' },
        },
      },
    },
    required: ['TargetFile', 'CodeContent', 'Overwrite', 'Description'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.TargetFile || args.targetFile || args.path || args.filePath || '').trim();
    const content = String(args.CodeContent ?? args.codeContent ?? args.content ?? '');
    const overwrite = args.Overwrite === true || args.overwrite === true;

    if (!rawPath) {
      return toolError('The "TargetFile" parameter is required.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath) || workspace.isProtectedFile(rawPath)) {
        return toolError(
          `Security: editing or overwriting sensitive configuration file "${rawPath}" is not allowed.`,
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

      if (isExisting && !overwrite) {
        return toolError(
          `File "${rawPath}" already exists on disk. To update part of the content, use replace_file_content; or set Overwrite: true if you are sure you want to overwrite the whole file.`,
          'FILE_ALREADY_EXISTS',
          { TargetFile: rawPath },
          'Use replace_file_content for precise partial edits or set Overwrite=true to overwrite.',
        );
      }

      // Đọc nội dung cũ nếu file đã tồn tại để so sánh symbol
      let oldContent: string | undefined;
      if (isExisting) {
        try {
          oldContent = await fs.readFile(safePath, 'utf-8');
        } catch {}
      }

      // Đảm bảo thư mục cha tồn tại
      const parentDir = path.dirname(safePath);
      await fs.mkdir(parentDir, { recursive: true });

      // Ghi nội dung file
      await fs.writeFile(safePath, content, 'utf-8');
      invalidateTopologyCache();

      let blastRadiusSummary: any;
      try {
        const modifiedSymbols = detectChangedSymbols(rawPath, oldContent, content);
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

      const bytesWritten = Buffer.byteLength(content, 'utf-8');
      const contentHash = computeStringHash(content);

      let diagnosticWarning: string | undefined;
      let syntaxErrors: any[] | undefined;
      try {
        const diags = await CodeSyntaxValidator.validateFile(rawPath, workspace);
        if (diags.length > 0) {
          syntaxErrors = diags;
          diagnosticWarning = `⚠️ LINTER ALERT (${diags.length} unresolved syntax / missing import issue(s)):\n` +
            diags.map((d) => `  • Line ${d.line}: ${d.message}`).join('\n') +
            `\n👉 ACTION REQUIRED: Add the missing import statement at the top of "${rawPath}" or fix the syntax error now.`;
        }
      } catch {}

      return toolSuccess({
        path: workspace.toRelativePath(safePath),
        TargetFile: workspace.toRelativePath(safePath),
        bytesWritten,
        contentHash,
        created: !isExisting,
        isNewFile: !isExisting,
        message: isExisting
          ? `Successfully overwrote file "${rawPath}".`
          : `Successfully created file "${rawPath}".`,
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Failed to write file: ${err.message}`, 'EXECUTION_ERROR', { TargetFile: rawPath });
    }
  },
};
