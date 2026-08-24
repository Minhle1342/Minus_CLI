import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from './inspect-symbol.js';
import { toolError, toolSuccess } from './tool-result.js';

/**
 * Tool find_references
 * 
 * Tìm kiếm các vị trí tham chiếu (references) thực tế tới symbol trong toàn bộ codebase
 * bằng semantic analysis thay vì dùng regex grep.
 */
export const findReferencesTool: ToolDefinition = {
  name: 'find_references',
  description: 'Tìm kiếm tất cả các vị trí tham chiếu (references) thực tế tới một symbol trong toàn bộ dự án bằng TypeScript Language Service.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn file định nghĩa symbol (ví dụ: "src/services/user-service.ts")',
      },
      symbol: {
        type: Type.STRING,
        description: 'Tên symbol cần tìm tham chiếu',
      },
      limit: {
        type: Type.INTEGER,
        description: 'Số lượng kết quả tối đa cần trả về (mặc định: 50).',
      },
    },
    required: ['path', 'symbol'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '').trim();
    const symbol = String(args.symbol || '').trim();
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 50;

    if (!rawPath || !symbol) {
      return toolError('Cả "path" và "symbol" đều là bắt buộc.', 'INVALID_ARGS');
    }

    try {
      const tsService = getOrCreateTypeScriptService(workspace);
      const references = tsService.findReferences(rawPath, symbol, limit);

      const filesAffected = Array.from(new Set(references.map((r) => r.file)));

      return toolSuccess({
        symbol,
        path: rawPath,
        totalReferences: references.length,
        filesAffectedCount: filesAffected.length,
        filesAffected,
        references,
      });
    } catch (err: any) {
      return toolError(`Lỗi khi tìm kiếm references: ${err.message}`, 'EXECUTION_ERROR');
    }
  },
};
