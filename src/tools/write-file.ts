import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeStringHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';

/**
 * Tool 5: write_file
 * Tạo một file mới hoặc ghi đè toàn bộ nội dung của một file trong workspace.
 * Tự động tạo các thư mục cha nếu chưa tồn tại.
 */
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Tạo một file mới hoặc ghi đè toàn bộ nội dung file trong workspace. Tự động kiểm tra chống Lazy Code Placeholder và bảo vệ chống ghi đè mù lên file lớn có sẵn.',
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
        description: 'Bắt buộc truyền true nếu muốn ghi đè lên file lớn đã có sẵn (> 30 dòng). Mặc định false để bảo vệ mã nguồn cũ.',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '');
    const content = String(args.content ?? '');
    const overwrite = args.overwrite === true;

    if (!rawPath) {
      return toolError('Tham số "path" là bắt buộc.', 'INVALID_ARGS');
    }

    // 1. Chống Lazy Code Placeholder (Claude Code & OpenHands standard)
    const LAZY_CODE_REGEX = /(?:\/\/|\/\*|#|<!--)\s*\.\.\.\s*(?:existing|rest|unchanged|remains|more|other|code\s+remains|implementation\s+remains)/i;
    if (LAZY_CODE_REGEX.test(content)) {
      return toolError(
        `Phát hiện Lazy Code Placeholder trong content (ví dụ: "// ... existing code ..."). write_file yêu cầu toàn bộ nội dung mã nguồn đầy đủ, không chấp nhận comment viết tắt. Để sửa đổi cục bộ, hãy sử dụng tool "replace_text".`,
        'LAZY_CODE_PLACEHOLDER_DETECTED',
        { path: rawPath },
      );
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
        const existingStat = await fs.stat(safePath);
        isExisting = true;

        // 2. Chống ghi đè mù lên file lớn có sẵn (SWE-agent standard)
        if (!overwrite) {
          const existingContent = await fs.readFile(safePath, 'utf-8');
          const lineCount = existingContent.split('\n').length;
          if (lineCount > 30 || existingStat.size > 1024) {
            return toolError(
              `File "${rawPath}" đã tồn tại và có dung lượng lớn (${lineCount} dòng, ${existingStat.size} bytes). Để tránh vô tình xóa mất logic cũ khi ghi đè toàn bộ, hãy dùng tool "replace_text" để sửa đổi chính xác từng phần. Nếu bạn thực sự muốn ghi đè toàn bộ file, hãy truyền thêm tham số overwrite: true.`,
              'LARGE_FILE_OVERWRITE_PROTECTION',
              { path: rawPath, lineCount, sizeBytes: existingStat.size },
              'Use replace_text for surgical updates, or set overwrite: true to force rewrite.',
            );
          }
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          // Ignore other stat errors
        }
        isExisting = false;
      }

      // Đảm bảo thư mục cha tồn tại
      const parentDir = path.dirname(safePath);
      await fs.mkdir(parentDir, { recursive: true });

      // Ghi nội dung file
      await fs.writeFile(safePath, content, 'utf-8');

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
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Không thể ghi file: ${err.message}`, 'EXECUTION_ERROR', { path: rawPath });
    }
  },
};
