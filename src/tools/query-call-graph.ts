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

export function createQueryCallGraphTool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'query_call_graph',
    description: 'Truy vấn đồ thị gọi hàm (Call Graph & Call Hierarchy) 2 chiều (Callers: hàm nào gọi nó, Callees: nó gọi những hàm nào) theo độ sâu tùy chỉnh. Giúp LLM nắm bắt luồng thực thi trong 1 bước.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbolName: {
          type: Type.STRING,
          description: 'Tên hàm, method, hoặc class cần truy vết luồng gọi (ví dụ: "submitSolution", "generateStream", "executePlanTask").',
        },
        filePath: {
          type: Type.STRING,
          description: 'Đường dẫn file định nghĩa symbol (tùy chọn nhưng giúp tăng độ chính xác).',
        },
        direction: {
          type: Type.STRING,
          description: 'Chiều phân tích: "callers" (hàm cha gọi nó), "callees" (hàm con nó gọi), hoặc "both" (mặc định "both").',
        },
        depth: {
          type: Type.INTEGER,
          description: 'Độ sâu cây phân cấp gọi hàm cần mở rộng (mặc định 2, tối đa 5).',
        },
      },
      required: ['symbolName'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const symbolName = String(args.symbolName || '').trim();
      if (!symbolName) {
        return { error: 'Tham số "symbolName" là bắt buộc.' };
      }

      const filePath = args.filePath ? String(args.filePath).trim() : undefined;
      const direction = (args.direction === 'callers' || args.direction === 'callees' ? args.direction : 'both') as 'callers' | 'callees' | 'both';
      const depth = typeof args.depth === 'number' ? args.depth : 2;

      const engine = service || getIntelligenceService(workspace);
      const result = engine.queryCallGraph(symbolName, filePath, direction, depth);

      return {
        success: true,
        callGraph: result,
      };
    },
  };
}

export const queryCallGraphTool = createQueryCallGraphTool();
