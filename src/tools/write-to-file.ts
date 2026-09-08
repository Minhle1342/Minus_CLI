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
  description: 'Tạo file mới hoặc ghi đè toàn bộ nội dung file trong workspace theo tiêu chuẩn Antigravity. Tự động tạo thư mục cha nếu chưa tồn tại. Mặc định sẽ báo lỗi an toàn nếu file đã tồn tại trên đĩa trừ khi tham số Overwrite được chỉ định rõ là true. Tự động trả về contentHash, bytesWritten và phân tích Blast Radius.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: {
        type: Type.STRING,
        description: 'Đường dẫn tuyệt đối hoặc tương đối tới file cần tạo hoặc ghi đè (ví dụ: "src/utils/helper.ts")',
      },
      CodeContent: {
        type: Type.STRING,
        description: 'Toàn bộ nội dung mã nguồn hoặc văn bản sẽ ghi vào file',
      },
      Overwrite: {
        type: Type.BOOLEAN,
        description: 'Bắt buộc. Đặt true để cho phép ghi đè nếu file đã tồn tại; đặt false để từ chối nếu file đã có sẵn trên đĩa nhằm chống ghi đè nhầm.',
      },
      Description: {
        type: Type.STRING,
        description: 'Giải thích ngắn gọn, súc tích về thay đổi vừa thực hiện và lý do thiết kế.',
      },
      ArtifactMetadata: {
        type: Type.OBJECT,
        description: 'Metadata tùy chọn đính kèm nếu file tạo ra là một artifact tài liệu/kế hoạch.',
        properties: {
          Summary: { type: Type.STRING, description: 'Tóm tắt nội dung của artifact' },
          UserFacing: { type: Type.BOOLEAN, description: 'True nếu artifact này hiển thị cho người dùng xem' },
          RequestFeedback: { type: Type.BOOLEAN, description: 'True nếu yêu cầu người dùng xác nhận kế hoạch' },
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
      return toolError('Tham số "TargetFile" là bắt buộc.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath) || workspace.isProtectedFile(rawPath)) {
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
          `File "${rawPath}" đã tồn tại trên đĩa. Để cập nhật một phần nội dung, hãy dùng replace_file_content; hoặc đặt Overwrite: true nếu bạn chắc chắn muốn ghi đè toàn bộ.`,
          'FILE_ALREADY_EXISTS',
          { TargetFile: rawPath },
          'Sử dụng replace_file_content để sửa đổi chính xác từng phần hoặc đặt Overwrite=true để ghi đè.',
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
          ? `Đã ghi đè thành công file "${rawPath}".`
          : `Đã tạo mới thành công file "${rawPath}".`,
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Không thể ghi file: ${err.message}`, 'EXECUTION_ERROR', { TargetFile: rawPath });
    }
  },
};
