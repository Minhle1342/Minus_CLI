import type { ToolRegistry } from './registry.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { normalizeForMatching } from '../agent/final-answer-guard.js';

export interface ReportInvestigationFindingsArgs {
  rootCause: string;
  affectedFilesAndSymbols: string[];
  evidenceTrace: string;
  proposedSolution: string;
  userFacingReport: string;
}

export interface ReportInvestigationFindingsResult {
  success: boolean;
  reported: boolean;
  rootCause: string;
  affectedFilesAndSymbols: string[];
  evidenceTrace: string;
  proposedSolution: string;
  userFacingReport: string;
  timestamp: string;
  nextAction: string;
  message: string;
  error?: string;
  errorCode?: string;
  suggestion?: string;
}

/**
 * createReportFindingsTool - Dedicated Structured Investigation Reporting Primitive
 * 
 * Used for diagnostic, analytical, root-cause, and architectural investigation tasks.
 * Enforces concrete findings, specific file/symbol coordinates, and an in-depth user-facing report.
 */
export function createReportFindingsTool(workspace?: Workspace): ToolDefinition {
  return {
    name: 'report_investigation_findings',
    description: 'Báo cáo toàn diện kết quả điều tra nguyên nhân sự cố hoặc phân tích logic mã nguồn cho người dùng. Bắt buộc phải cung cấp đầy đủ nguyên nhân gốc rễ, các file/hàm liên quan, dẫn chứng mã nguồn và bản báo cáo chi tiết bằng Markdown cho người dùng.',
    parameters: {
      type: 'OBJECT',
      properties: {
        rootCause: {
          type: 'STRING',
          description: 'Giải thích chi tiết nguyên nhân gốc rễ dẫn tới lỗi hoặc hành vi bất thường (yêu cầu tối thiểu 50 ký tự).',
        },
        affectedFilesAndSymbols: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Danh sách các file, hàm, component, class hoặc biến trực tiếp liên quan đến vấn đề.',
        },
        evidenceTrace: {
          type: 'STRING',
          description: 'Dẫn chứng cụ thể: đoạn mã bị lỗi, số dòng hoặc luồng dữ liệu (data flow) gây ra sự cố.',
        },
        proposedSolution: {
          type: 'STRING',
          description: 'Phương án khắc phục kỹ thuật, bản vá đề xuất hoặc các bước khắc phục chi tiết.',
        },
        userFacingReport: {
          type: 'STRING',
          description: 'Bản báo cáo kỹ thuật hoàn chỉnh bằng Markdown gửi trực tiếp tới người dùng bằng tiếng Việt (yêu cầu tối thiểu 250 ký tự). Bản báo cáo này sẽ trở thành câu trả lời chính thức cho người dùng.',
        },
      },
      required: ['rootCause', 'affectedFilesAndSymbols', 'evidenceTrace', 'proposedSolution', 'userFacingReport'],
    } as any,
    execute: async (
      args: Record<string, any>,
      workspaceContext?: Workspace,
      context?: ToolExecutionContext,
    ): Promise<ReportInvestigationFindingsResult> => {
      const rootCause = String(args.rootCause || '').trim();
      const affectedFilesAndSymbols = Array.isArray(args.affectedFilesAndSymbols)
        ? args.affectedFilesAndSymbols.map((item) => String(item).trim()).filter(Boolean)
        : [];
      const evidenceTrace = String(args.evidenceTrace || '').trim();
      const proposedSolution = String(args.proposedSolution || '').trim();
      const userFacingReport = String(args.userFacingReport || '').trim();

      // 1. Kiểm tra trường rootCause
      if (!rootCause || rootCause.length < 50) {
        return {
          success: false,
          reported: false,
          error: `report_investigation_findings bị từ chối: trường "rootCause" quá ngắn (${rootCause.length} ký tự, yêu cầu tối thiểu 50 ký tự). Hãy giải thích rõ ràng nguyên nhân kỹ thuật gốc rễ.`,
          errorCode: 'INSUFFICIENT_ROOT_CAUSE',
          suggestion: 'Hãy nêu rõ cơ chế logic nào bị sai hoặc thiếu sót dẫn đến hành vi lỗi.',
          rootCause,
          affectedFilesAndSymbols,
          evidenceTrace,
          proposedSolution,
          userFacingReport,
          timestamp: new Date().toISOString(),
          nextAction: 'retry_with_full_details',
          message: 'Failed to record findings due to insufficient root cause.',
        };
      }

      // 2. Kiểm tra affectedFilesAndSymbols
      if (affectedFilesAndSymbols.length === 0) {
        return {
          success: false,
          reported: false,
          error: 'report_investigation_findings bị từ chối: trường "affectedFilesAndSymbols" không được để trống. Hãy cung cấp ít nhất một file hoặc hàm/component liên quan trong workspace.',
          errorCode: 'MISSING_AFFECTED_COMPONENTS',
          suggestion: 'Ví dụ: ["public/app.js", "QuizManager.filterWikiNodesByKeyword"]',
          rootCause,
          affectedFilesAndSymbols,
          evidenceTrace,
          proposedSolution,
          userFacingReport,
          timestamp: new Date().toISOString(),
          nextAction: 'retry_with_full_details',
          message: 'Failed to record findings due to missing affected components.',
        };
      }

      // 3. Kiểm tra userFacingReport (Phải là bài báo cáo thực sự, không được là pseudo-claim)
      if (!userFacingReport || userFacingReport.length < 250) {
        return {
          success: false,
          reported: false,
          error: `report_investigation_findings bị từ chối: trường "userFacingReport" quá ngắn (${userFacingReport.length} ký tự, yêu cầu tối thiểu 250 ký tự). Đây là báo cáo trực tiếp gửi người dùng, không được tóm tắt sơ sài.`,
          errorCode: 'INSUFFICIENT_USER_REPORT',
          suggestion: 'Hãy viết bản phân tích hoàn chỉnh gồm các mục: 1. Tổng quan vấn đề, 2. Phân tích nguyên nhân, 3. Dẫn chứng mã nguồn, 4. Giải pháp đề xuất.',
          rootCause,
          affectedFilesAndSymbols,
          evidenceTrace,
          proposedSolution,
          userFacingReport,
          timestamp: new Date().toISOString(),
          nextAction: 'retry_with_full_details',
          message: 'Failed to record findings due to insufficient user report length.',
        };
      }

      const normalizedReport = normalizeForMatching(userFacingReport);
      const isPseudoClaim = (
        /\b(?:da|vua)\s+(?:cung cap|tra loi|giai thich|bao cao|trinh bay)\s+.*?(?:nguyen nhan|ly do|khong hien thi|khong goi y)\b/.test(normalizedReport)
        || /\b(?:se|will)\s+(?:bao cao|trinh bay|giai thich|cung cap)\s+(?:chi tiet|day du)/.test(normalizedReport)
      ) && userFacingReport.length < 350 && !/[-*•\d]\.\s|```|\*\*|###/.test(userFacingReport);

      if (isPseudoClaim) {
        return {
          success: false,
          reported: false,
          error: 'report_investigation_findings bị từ chối: trường "userFacingReport" chỉ là câu thông báo hoàn tất suông ("Đã cung cấp câu trả lời...") mà không chứa nội dung phân tích thực tế.',
          errorCode: 'PSEUDO_REPORT_REJECTED',
          suggestion: 'Hãy trình bày trực tiếp nội dung kỹ thuật vào trường userFacingReport.',
          rootCause,
          affectedFilesAndSymbols,
          evidenceTrace,
          proposedSolution,
          userFacingReport,
          timestamp: new Date().toISOString(),
          nextAction: 'retry_with_full_details',
          message: 'Failed to record findings due to pseudo-completion content.',
        };
      }

      const timestamp = new Date().toISOString();
      return {
        success: true,
        reported: true,
        rootCause,
        affectedFilesAndSymbols,
        evidenceTrace,
        proposedSolution,
        userFacingReport,
        timestamp,
        nextAction: 'final_answer',
        message: 'Investigation findings successfully recorded and verified with full technical depth. Output this userFacingReport directly to the user as your final response.',
      };
    },
  };
}

export function registerReportFindingsTool(registry: ToolRegistry, workspace?: Workspace): void {
  registry.register(createReportFindingsTool(workspace));
}
