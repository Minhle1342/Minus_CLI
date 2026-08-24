import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from './inspect-symbol.js';
import { toolError, toolSuccess } from './tool-result.js';

/**
 * Tool get_diagnostics
 * 
 * Lấy danh sách lỗi cú pháp (syntactic) và ngữ nghĩa (semantic) của TypeScript
 * cho một file cụ thể hoặc toàn bộ dự án trực tiếp qua TypeScript Language Service trong RAM.
 */
export const getDiagnosticsTool: ToolDefinition = {
  name: 'get_diagnostics',
  description: 'Lấy danh sách lỗi cú pháp và kiểu dữ liệu (TypeScript syntactic & semantic diagnostics) trực tiếp trong bộ nhớ RAM mà không cần chạy lại toàn bộ tsc CLI.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Tùy chọn: Đường dẫn file cần kiểm tra lỗi (nếu bỏ trống, sẽ quét toàn bộ workspace).',
      },
    },
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = args.path ? String(args.path).trim() : undefined;

    try {
      const tsService = getOrCreateTypeScriptService(workspace);
      const diagnostics = tsService.getDiagnostics(rawPath);

      const errors = diagnostics.filter((d) => d.category === 'error');
      const warnings = diagnostics.filter((d) => d.category === 'warning');

      return toolSuccess({
        clean: errors.length === 0,
        totalErrors: errors.length,
        totalWarnings: warnings.length,
        diagnostics: diagnostics.slice(0, 30),
      });
    } catch (err: any) {
      return toolError(`Lỗi khi trích xuất diagnostics: ${err.message}`, 'EXECUTION_ERROR');
    }
  },
};
