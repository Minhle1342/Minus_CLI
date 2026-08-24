import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { getOrCreateTypeScriptService } from './inspect-symbol.js';
import { toolError, toolSuccess } from './tool-result.js';

export type ImpactRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ImpactAnalysisResult {
  risk: ImpactRiskLevel;
  path: string;
  symbol?: string;
  definition?: {
    path: string;
    line?: number;
    kind?: string;
    typeSignature?: string;
  };
  directReferences: number;
  callers: number;
  dependentFiles: string[];
  relatedTests: string[];
  publicApiAffected: boolean;
  warnings: string[];
  recommendedVerification: string[];
}

/**
 * Tool analyze_impact (Blast Radius & Semantic Impact Analysis)
 * 
 * Đánh giá mức độ rủi ro và phạm vi ảnh hưởng (blast radius) của một thay đổi
 * trước khi áp dụng mutation vào codebase.
 */
export const analyzeImpactTool: ToolDefinition = {
  name: 'analyze_impact',
  description: 'Phân tích phạm vi ảnh hưởng (Blast Radius & Impact Analysis) của một symbol hoặc file: tìm các file phụ thuộc, bài kiểm thử liên quan, và tính toán mức độ rủi ro (LOW/MEDIUM/HIGH/CRITICAL) để chọn quy trình kiểm thử phù hợp.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Đường dẫn file cần phân tích (ví dụ: "src/services/user-service.ts")',
      },
      symbol: {
        type: Type.STRING,
        description: 'Tùy chọn: Tên symbol cụ thể (hàm, interface, class) cần phân tích tác động',
      },
      depth: {
        type: Type.INTEGER,
        description: 'Độ sâu phân tích chuỗi phụ thuộc (mặc định: 2).',
      },
    },
    required: ['path'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.path || '').trim();
    const symbol = args.symbol ? String(args.symbol).trim() : undefined;

    if (!rawPath) {
      return toolError('Tham số "path" là bắt buộc.', 'INVALID_ARGS');
    }

    try {
      const tsService = getOrCreateTypeScriptService(workspace);
      const warnings: string[] = [];
      let directReferences = 0;
      let callers = 0;
      let dependentFiles: string[] = [];
      let relatedTests: string[] = [];
      let publicApiAffected = false;
      let definitionInfo: ImpactAnalysisResult['definition'];

      if (symbol) {
        const symDef = tsService.inspectSymbol(rawPath, symbol);
        if (symDef.found) {
          definitionInfo = {
            path: symDef.file || rawPath,
            line: symDef.line,
            kind: symDef.kind,
            typeSignature: symDef.typeSignature,
          };
          publicApiAffected = Boolean(symDef.isExported);
          if (symDef.isExported) {
            warnings.push(`Symbol "${symbol}" được export công khai; thay đổi có thể ảnh hưởng API bên ngoài.`);
          }
        }

        const refs = tsService.findReferences(rawPath, symbol, 100);
        directReferences = refs.filter((r) => !r.isDefinition).length;
        const distinctFiles = Array.from(new Set(refs.map((r) => r.file)));
        dependentFiles = distinctFiles.filter((f) => f !== rawPath);
        callers = refs.filter((r) => !r.isDefinition && r.file !== rawPath).length;

        relatedTests = distinctFiles.filter((f) => /test|spec/i.test(f));
      } else {
        // Quét toàn bộ file
        const allDiag = tsService.getDiagnostics(rawPath);
        if (allDiag.length > 0) {
          warnings.push(`File "${rawPath}" hiện có ${allDiag.length} cảnh báo/lỗi diagnostics từ trước.`);
        }
      }

      // Xác định Risk Level
      let risk: ImpactRiskLevel = 'LOW';
      if (publicApiAffected && directReferences > 10) {
        risk = 'HIGH';
      } else if (publicApiAffected || directReferences > 3 || dependentFiles.length > 2) {
        risk = 'MEDIUM';
      }

      const recommendedVerification: string[] = ['get_diagnostics'];
      if (risk === 'MEDIUM') {
        recommendedVerification.push('tsc --noEmit', 'run targeted tests');
      } else if (risk === 'HIGH') {
        recommendedVerification.push('tsc --noEmit', 'run relevant tests', 'npm test (full test suite)');
      }

      const result: ImpactAnalysisResult = {
        risk,
        path: rawPath,
        symbol,
        definition: definitionInfo,
        directReferences,
        callers,
        dependentFiles,
        relatedTests,
        publicApiAffected,
        warnings,
        recommendedVerification,
      };

      return toolSuccess(result);
    } catch (err: any) {
      return toolError(`Lỗi khi phân tích blast radius: ${err.message}`, 'EXECUTION_ERROR');
    }
  },
};
