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
        description: 'Đường dẫn file định nghĩa symbol (ví dụ: "src/services/user-service.ts"). Alias: "filePath".',
      },
      filePath: {
        type: Type.STRING,
        description: 'Alias cho "path": Đường dẫn file định nghĩa symbol.',
      },
      symbol: {
        type: Type.STRING,
        description: 'Tên symbol cần tìm tham chiếu. Alias: "symbolName".',
      },
      symbolName: {
        type: Type.STRING,
        description: 'Alias cho "symbol": Tên symbol cần tìm tham chiếu.',
      },
      limit: {
        type: Type.INTEGER,
        description: 'Số lượng kết quả tối đa cần trả về (mặc định: 50).',
      },
    },
    required: [],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    let symbol = String(args.symbol || args.symbolName || '').trim();
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 50;

    if (!symbol && rawPath) {
      const baseName = rawPath.split(/[/\\]/).pop() || '';
      const dotIndex = baseName.lastIndexOf('.');
      symbol = dotIndex > 0 ? baseName.substring(0, dotIndex) : baseName;
    }

    if (!rawPath || !symbol) {
      return toolError('Cả "path" (hoặc "filePath") và "symbol" (hoặc "symbolName") đều là bắt buộc.', 'INVALID_ARGS');
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
