import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from './inspect-symbol.js';
import { toolError, toolSuccess } from './tool-result.js';
import { getOrCreateLspManager } from '../lsp/lsp-manager.js';
import type { DiagnosticItem } from './typescript-service.js';

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

    // Tool-Use Guardian: Pre-call validation cho file path
    if (rawPath) {
      let exists = false;
      try {
        const resolved = workspace.resolveSafePath(rawPath);
        exists = fs.existsSync(resolved);
      } catch {
        exists = fs.existsSync(path.resolve(workspace.rootDir, rawPath));
      }

      if (!exists) {
        return toolError(
          `File "${rawPath}" không tồn tại trên đĩa hoặc không thể truy cập.`,
          'FILE_NOT_FOUND',
          { path: rawPath },
          'Kiểm tra lại đường dẫn file hoặc gọi get_diagnostics không có tham số path để quét toàn bộ workspace.',
        );
      }
    }

    try {
      const usesTypeScriptService = !rawPath || /\.[cm]?[jt]sx?$/i.test(rawPath);
      let tsDiagnostics: DiagnosticItem[] = [];

      // Provider 1: TypeScript In-Memory Language Service
      if (usesTypeScriptService) {
        try {
          tsDiagnostics = getOrCreateTypeScriptService(workspace).getDiagnostics(rawPath);
        } catch (tsErr: any) {
          // Tool-Use Guardian: Ghi nhận cảnh báo và tiếp tục fallback sang LSP
          tsDiagnostics = [{
            file: rawPath || '',
            line: 1,
            character: 1,
            message: `TypeScript Language Service warning: ${tsErr.message}`,
            code: 0,
            category: 'warning',
          }];
        }
      }

      // Provider 2: LSP Manager
      let lspResult: any = {
        available: false,
        diagnostics: [],
        providers: [],
        status: [],
        warnings: [],
      };
      try {
        lspResult = await getOrCreateLspManager(workspace).diagnostics(rawPath, { sync: true, wait: true });
      } catch (lspErr: any) {
        // Tool-Use Guardian: Catch LSP failures gracefully
        lspResult.warnings = [lspErr.message];
      }

      const diagnostics = dedupeDiagnostics([
        ...tsDiagnostics.map((item) => ({ ...item, provider: 'typescript-in-memory' })),
        ...(lspResult.diagnostics || []),
      ]);

      const errors = diagnostics.filter((d) => d.category === 'error');
      const warnings = diagnostics.filter((d) => d.category === 'warning');

      return toolSuccess({
        clean: errors.length === 0,
        totalErrors: errors.length,
        totalWarnings: warnings.length,
        diagnostics: diagnostics.slice(0, 30),
        providers: [
          ...new Set([
            ...(lspResult.providers || []),
            ...(usesTypeScriptService ? ['typescript-in-memory'] : []),
          ]),
        ],
        lspAvailable: Boolean(lspResult.available),
        lspStatus: lspResult.status || [],
        warnings: [...(lspResult.warnings || [])],
      });
    } catch (err: any) {
      return toolError(`Lỗi khi trích xuất diagnostics: ${err.message}`, 'EXECUTION_ERROR');
    }
  },
};

function dedupeDiagnostics<T extends { file: string; line: number; character: number; message: string; code?: string | number }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}:${item.line}:${item.character}:${item.code ?? ''}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
