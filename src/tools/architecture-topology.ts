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

export function createGetArchitectureTopologyTool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'get_architecture_topology',
    description: 'Phân tích bản đồ kiến trúc & topo phân tầng của codebase (Controllers, Services, Repositories/Models, Tools, Utils, Tests). Xây dựng đồ thị phụ thuộc module, tự động phát hiện Circular Dependencies (vòng lặp phụ thuộc) và các vi phạm phân tầng kiến trúc.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        entryDir: {
          type: Type.STRING,
          description: 'Thư mục gốc bắt đầu quét topo (mặc định "src" hoặc ".").',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const entryDir = args.entryDir ? String(args.entryDir).trim() : 'src';
      const engine = service || getIntelligenceService(workspace);
      const topology = engine.getArchitectureTopology(entryDir);

      return {
        success: true,
        topology,
      };
    },
  };
}

export const getArchitectureTopologyTool = createGetArchitectureTopologyTool();
