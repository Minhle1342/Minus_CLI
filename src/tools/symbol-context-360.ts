import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from './codebase-intelligence.js';

let sharedIntelligenceService: CodebaseIntelligenceService | undefined;

function getIntelligenceService(workspace: Workspace): CodebaseIntelligenceService {
  if (!sharedIntelligenceService) {
    sharedIntelligenceService = new CodebaseIntelligenceService(workspace);
  }
  return sharedIntelligenceService;
}

export function createGetSymbolContext360Tool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'get_symbol_context_360',
    description: 'Cung cấp góc nhìn toàn cảnh 360 độ về một symbol trong 1 payload duy nhất: Định nghĩa, Type signature, Doc comments, Callers (ai gọi nó), Callees (nó gọi ai), Imports phụ thuộc, Referencing files và các file Test liên quan.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol: {
          type: Type.STRING,
          description: 'Tên symbol cần lấy ngữ cảnh 360 độ (function, class, interface, type, variable). Có thể dùng alias symbolName.',
        },
        symbolName: {
          type: Type.STRING,
          description: 'Alias cho symbol: tên symbol cần tra cứu.',
        },
        path: {
          type: Type.STRING,
          description: 'Đường dẫn tương đối tới file gợi ý nơi định nghĩa symbol. Có thể dùng alias filePath.',
        },
        filePath: {
          type: Type.STRING,
          description: 'Alias cho path: đường dẫn file gợi ý.',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const symbolName = String(args.symbol || args.symbolName || '').trim();
      if (!symbolName) {
        return { error: 'Tham số "symbol" (hoặc "symbolName") là bắt buộc.' };
      }

      const filePath = String(args.path || args.filePath || '').trim() || undefined;
      const engine = service || getIntelligenceService(workspace);
      const result = engine.getSymbolContext360(symbolName, filePath);

      return {
        success: true,
        context360: result,
      };
    },
  };
}

export const getSymbolContext360Tool = createGetSymbolContext360Tool();
