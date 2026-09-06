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
  description: 'Tạo file mới hoặc ghi đè toàn bộ nội dung file trong workspace. Hỗ trợ tham số overwrite: false để bảo đảm an toàn chống ghi đè nhầm file đã tồn tại.',
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
      overwrite: {
        type: Type.BOOLEAN,
        description: 'Cho phép ghi đè nếu file đã tồn tại (mặc định: true). Nếu đặt false, tool sẽ từ chối ghi đè nếu file đã có sẵn.',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    const content = String(args.content ?? '');
    const overwrite = args.overwrite !== false;

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

      if (isExisting && !overwrite) {
        return toolError(
          `File "${rawPath}" đã tồn tại trên đĩa. Để cập nhật một phần nội dung, hãy dùng replace_text; hoặc đặt overwrite: true nếu muốn ghi đè toàn bộ.`,
          'FILE_ALREADY_EXISTS',
          { path: rawPath },
          'Sử dụng replace_text để sửa đổi chính xác từng phần hoặc đặt overwrite=true để ghi đè.',
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
          ? `Đã ghi đè thành công file "${rawPath}".`
          : `Đã tạo mới thành công file "${rawPath}".`,
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Không thể ghi file: ${err.message}`, 'EXECUTION_ERROR', { path: rawPath });
    }
  },
};
