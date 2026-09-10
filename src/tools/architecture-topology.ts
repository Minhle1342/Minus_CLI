import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { CodebaseIntelligenceService } from './codebase-intelligence.js';

let sharedIntelligenceService: CodebaseIntelligenceService | undefined;

export function getIntelligenceService(workspace: Workspace): CodebaseIntelligenceService {
  if (!sharedIntelligenceService) {
    sharedIntelligenceService = new CodebaseIntelligenceService(workspace);
  }
  return sharedIntelligenceService;
}

export function createGetArchitectureTopologyTool(service?: CodebaseIntelligenceService): ToolDefinition {
  return {
    name: 'get_architecture_topology',
    description:
      'Phân tích bản đồ kiến trúc & topo phân tầng của codebase (Controllers, Services, Repositories, UI, Tools, Config, Utils, Tests). ' +
      'Sử dụng TypeScript Compiler AST & Module Resolution để giải quyết chính xác đường dẫn import (bao gồm tsconfig paths aliases). ' +
      'Tự động phát hiện Circular Dependencies (vòng lặp phụ thuộc), vi phạm phân tầng Clean Architecture, và tính toán chỉ số ghép nối Robert C. Martin (Afferent/Efferent coupling, Instability, Hub nodes). ' +
      'Hỗ trợ tham số mode ("summary" | "detailed" | "full") để tối ưu hóa cửa sổ ngữ cảnh token cho LLM.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        entryDir: {
          type: Type.STRING,
          description: 'Thư mục gốc bắt đầu quét topo (mặc định "src" hoặc ".").',
        },
        mode: {
          type: Type.STRING,
          description:
            'Chế độ hiển thị kết quả nhằm tối ưu token: ' +
            '"summary" (mặc định - trả về số lượng tầng, metrics bất ổn định, top hub nodes, các chu trình vòng lặp và vi phạm phân tầng; tiết kiệm >90% token), ' +
            '"detailed" (bao gồm danh sách file cụ thể từng tầng), ' +
            '"full" (trả về toàn bộ ma trận dependencyGraph thô của tất cả các file).',
          enum: ['summary', 'detailed', 'full'],
        },
        focusLayer: {
          type: Type.STRING,
          description:
            'Tùy chọn lọc chỉ xem thông tin của một tầng kiến trúc cụ thể (ví dụ: "controller", "service", "repository", "ui", "tools", "utils", "config", "test").',
          enum: ['controller', 'service', 'repository', 'ui', 'tools', 'utils', 'config', 'test', 'other'],
        },
        forceRefresh: {
          type: Type.BOOLEAN,
          description: 'Bỏ qua bộ nhớ đệm 30s và quét mới toàn bộ từ đĩa (mặc định false).',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const entryDir = args.entryDir ? String(args.entryDir).trim() : 'src';
      const mode = (args.mode as 'summary' | 'detailed' | 'full') || 'summary';
      const focusLayer = args.focusLayer ? String(args.focusLayer).trim() : undefined;
      const forceRefresh = Boolean(args.forceRefresh);

      const engine = service || getIntelligenceService(workspace);
      const rawTopology = engine.getArchitectureTopology(entryDir, {
        mode,
        focusLayer,
        forceRefresh,
      });

      // Lọc theo focusLayer nếu có
      let layers = rawTopology.layers;
      if (focusLayer && layers[focusLayer]) {
        layers = { [focusLayer]: layers[focusLayer] };
      }

      // Xây dựng response phù hợp với mode theo nguyên lý Tool Design
      if (mode === 'summary') {
        const layerSummaries: Record<string, { name: string; fileCount: number }> = {};
        for (const [key, layer] of Object.entries(layers)) {
          layerSummaries[key] = {
            name: layer.name,
            fileCount: layer.files.length,
          };
        }

        return {
          success: true,
          mode: 'summary',
          topology: {
            totalFiles: rawTopology.totalFiles,
            totalDependencies: rawTopology.totalDependencies,
            layers,
            circularCycles: rawTopology.circularCycles,
            layerViolations: rawTopology.layerViolations,
            metrics: rawTopology.metrics,
          },
          summary: {
            layerDistribution: layerSummaries,
            circularCycleCount: rawTopology.circularCycles.length,
            layerViolationCount: rawTopology.layerViolations.length,
            averageInstability: rawTopology.metrics?.averageInstability,
            topHubs: rawTopology.metrics?.hubNodes.slice(0, 3),
          },
          hint: 'To see detailed file lists per layer, use mode="detailed". To retrieve the full raw dependency graph, use mode="full".',
        };
      }

      if (mode === 'detailed') {
        return {
          success: true,
          mode: 'detailed',
          topology: {
            totalFiles: rawTopology.totalFiles,
            totalDependencies: rawTopology.totalDependencies,
            layers,
            circularCycles: rawTopology.circularCycles,
            layerViolations: rawTopology.layerViolations,
            metrics: rawTopology.metrics,
          },
        };
      }

      // mode === 'full'
      return {
        success: true,
        mode: 'full',
        topology: {
          ...rawTopology,
          layers,
        },
      };
    },
  };
}

export const getArchitectureTopologyTool = createGetArchitectureTopologyTool();

