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
 * Tool 5: write_file
 * Tạo một file mới hoặc ghi đè toàn bộ nội dung của một file trong workspace.
 * Tự động tạo các thư mục cha nếu chưa tồn tại.
 */
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create a new file or overwrite an entire file in the workspace. Set overwrite to false to prevent accidentally replacing an existing file.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Workspace-relative path of the file to create or overwrite (for example, "src/utils/helper.ts").',
      },
      content: {
        type: Type.STRING,
        description: 'Complete text content to write to the file.',
      },
      overwrite: {
        type: Type.BOOLEAN,
        description: 'Allow overwriting an existing file (default: true). When false, the tool refuses to overwrite a file that already exists.',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    const content = String(args.content ?? '');
    const overwrite = args.overwrite !== false;

    if (!rawPath) {
      return toolError('The "path" parameter is required.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      
      if (workspace.isProtectedFile(safePath)) {
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
          `File "${rawPath}" already exists on disk. To update part of the content, use replace_text; or set overwrite: true to overwrite the whole file.`,
          'FILE_ALREADY_EXISTS',
          { path: rawPath },
          'Use replace_text for precise partial edits or set overwrite=true to overwrite.',
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
        bytesWritten,
        contentHash,
        created: !isExisting,
        message: isExisting
          ? `Successfully overwrote file "${rawPath}".`
          : `Successfully created file "${rawPath}".`,
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Failed to write file: ${err.message}`, 'EXECUTION_ERROR', { path: rawPath });
    }
  },
};
