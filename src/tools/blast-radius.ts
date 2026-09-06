import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from './inspect-symbol.js';
import { toolError, toolSuccess } from './tool-result.js';
import {
  calculateComprehensiveBlastRadius,
  type ImpactRiskLevel,
  type EnrichedBlastRadius,
} from './mutation-blast-radius.js';

export type { ImpactRiskLevel };

export interface ImpactAnalysisResult {
  risk: ImpactRiskLevel;
  path: string;
  symbol?: string;
  depth: number;
  definition?: {
    path: string;
    line?: number;
    kind?: string;
    typeSignature?: string;
  };
  directReferences: number;
  callers: number;
  dependentFiles: string[];
  directConsumers: string[];
  transitiveFiles: string[];
  relatedTests: string[];
  impactedTestSuites: string[];
  publicApiAffected: boolean;
  breakingChange?: boolean;
  score: number;
  warnings: string[];
  recommendedVerification: string[];
  recommendedActions: string[];
}

/**
 * Tool analyze_impact (Industrial-grade Blast Radius & Semantic Impact Analysis)
 * 
 * Đánh giá mức độ rủi ro và phạm vi ảnh hưởng (blast radius) đa tầng (multi-hop) của một thay đổi
 * trước khi áp dụng mutation vào codebase, bám sát tiêu chuẩn Cursor / Claude Code harness.
 */
export const analyzeImpactTool: ToolDefinition = {
  name: 'analyze_impact',
  description: 'Phân tích toàn diện phạm vi ảnh hưởng (Blast Radius đa tầng): tìm chính xác các file phụ thuộc trực tiếp và gián tiếp (transitive consumers), bài kiểm thử liên quan, callers thực tế, và đánh giá mức độ rủi ro (LOW/MEDIUM/HIGH/CRITICAL) để dẫn hướng kiểm thử.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn file cần phân tích (ví dụ: "src/tools/registry.ts"). Alias: "filePath".',
      },
      filePath: {
        type: Type.STRING,
        description: 'Alias cho "path": Đường dẫn file cần phân tích.',
      },
      symbol: {
        type: Type.STRING,
        description: 'Tùy chọn: Tên symbol cụ thể (hàm, interface, class, method) cần phân tích tác động. Alias: "symbolName".',
      },
      symbolName: {
        type: Type.STRING,
        description: 'Alias cho "symbol": Tên symbol cụ thể cần phân tích.',
      },
      depth: {
        type: Type.INTEGER,
        description: 'Độ sâu phân tích chuỗi phụ thuộc gián tiếp (mặc định: 2, tối đa: 5).',
      },
    },
    required: [],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.filePath || '').trim();
    const symbol = args.symbol || args.symbolName ? String(args.symbol || args.symbolName).trim() : undefined;
    const depth = typeof args.depth === 'number' ? args.depth : 2;

    if (!rawPath) {
      return toolError('Tham số "path" (hoặc "filePath") là bắt buộc.', 'INVALID_ARGS');
    }

    try {
      // 1. Phân tích đồ thị phụ thuộc toàn diện đa tầng
      const blast = calculateComprehensiveBlastRadius({
        workspace,
        filePath: rawPath,
        symbol,
        depth,
      });

      const tsService = getOrCreateTypeScriptService(workspace);
      let definitionInfo: ImpactAnalysisResult['definition'];
      let directReferences = 0;
      let callersCount = blast.callers.length;

      // 2. Nếu có symbol, lấy thêm thông tin chi tiết về symbol definition
      if (symbol) {
        const symDef = tsService.inspectSymbol(rawPath, symbol);
        if (symDef.found) {
          definitionInfo = {
            path: symDef.file || rawPath,
            line: symDef.line,
            kind: symDef.kind,
            typeSignature: symDef.typeSignature,
          };
        }

        const refs = tsService.findReferences(rawPath, symbol, 100);
        directReferences = refs.filter((r) => !r.isDefinition).length;
        if (callersCount === 0) {
          callersCount = refs.filter((r) => !r.isDefinition && r.file !== rawPath).length;
        }
      } else {
        // Quét diagnostics trước đó của file
        const allDiag = tsService.getDiagnostics(rawPath);
        if (allDiag.length > 0) {
          blast.warnings.push(`File "${rawPath}" hiện có ${allDiag.length} cảnh báo/lỗi diagnostics từ trước.`);
        }
      }

      // 3. Chuẩn bị recommendedVerification (tương thích ngược)
      const recommendedVerification = [...blast.recommendedActions];

      const result: ImpactAnalysisResult = {
        risk: blast.risk,
        score: blast.score,
        path: blast.targetFile,
        symbol,
        depth: blast.depth,
        definition: definitionInfo,
        directReferences,
        callers: callersCount,
        dependentFiles: blast.directConsumers,
        directConsumers: blast.directConsumers,
        transitiveFiles: blast.transitiveFiles,
        relatedTests: blast.impactedTestSuites,
        impactedTestSuites: blast.impactedTestSuites,
        publicApiAffected: blast.publicApiAffected,
        breakingChange: blast.breakingChange,
        warnings: blast.warnings,
        recommendedVerification,
        recommendedActions: blast.recommendedActions,
      };

      return toolSuccess(result);
    } catch (err: any) {
      return toolError(`Lỗi khi phân tích blast radius: ${err.message}`, 'EXECUTION_ERROR');
    }
  },
};
