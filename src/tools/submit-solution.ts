import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import type { ToolExecutionContext } from './types.js';
import {
  SolutionGroundingAuditor,
  type ResolutionType,
  type VerificationMethod,
} from '../agent/solution-grounding-auditor.js';

export interface SubmitSolutionArgs {
  summary: string;
  rootCause?: string;
  filesModified?: string[];
  verificationEvidence?: string;
  resolutionType?: ResolutionType;
  verificationMethod?: VerificationMethod;
}

export interface SubmitSolutionResult {
  success: boolean;
  submitted: boolean;
  summary: string;
  rootCause?: string;
  filesModified: string[];
  verificationEvidence: string;
  resolutionType?: ResolutionType;
  verificationMethod?: VerificationMethod;
  groundingScore?: number;
  informationDensity?: number;
  timestamp: string;
  nextAction?: string;
  message: string;
}

/**
 * createSubmitSolutionTool - OpenAI Codex CLI Completion Primitive
 * 
 * In the Codex CLI architecture, the agent explicitly calls `submit_solution`
 * to finalize a task with empirical proof and audit ledger entries.
 */
export function createSubmitSolutionTool(workspace: Workspace): ToolDefinition {
  return {
    name: 'submit_solution',
    description: 'Explicitly submit the finalized solution and empirical verification proof for the current task or goal. Call this tool when all required code changes, diagnostics, and test verification commands have executed successfully.',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary: {
          type: 'STRING',
          description: 'A comprehensive summary of the implemented solution, files modified, and verified outcomes.',
        },
        resolutionType: {
          type: 'STRING',
          enum: ['code_fix', 'code_refactor', 'text_or_asset_edit', 'configuration_change', 'investigation_only', 'feature', 'other'],
          description: 'Optional. Nature of the implemented resolution (e.g. code_fix, text_or_asset_edit).',
        },
        filesModified: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of relative file paths that were modified, created, or deleted as part of the solution.',
        },
        verificationMethod: {
          type: 'STRING',
          enum: ['automated_test_pass', 'static_diagnostics_clean', 'diff_visual_inspection', 'direct_validation', 'not_applicable'],
          description: 'Optional. Verification strategy employed (e.g. automated_test_pass, static_diagnostics_clean, diff_visual_inspection).',
        },
        verificationEvidence: {
          type: 'STRING',
          description: 'Optional. The verification command executed (e.g. "npm test", "pytest") or rationale if automated tests were not executed.',
        },
        rootCause: {
          type: 'STRING',
          description: 'Optional. Explanation of the root cause identified during debugging or investigation.',
        },
      },
      required: ['summary'],
    } as any,
    execute: async (args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext): Promise<SubmitSolutionResult> => {
      const summary = (args.summary || '').trim();
      const verificationEvidence = (args.verificationEvidence || '').trim() || 'Verified via inspection and direct validation';
      const rootCause = args.rootCause ? String(args.rootCause).trim() : undefined;
      const resolutionType = args.resolutionType as ResolutionType | undefined;
      const verificationMethod = args.verificationMethod as VerificationMethod | undefined;

      // Thẩm định bằng chứng thực nghiệm & Information Grounding qua SolutionGroundingAuditor
      const audit = SolutionGroundingAuditor.audit({
        summary,
        rootCause,
        filesModified: args.filesModified,
        verificationEvidence,
        resolutionType,
        verificationMethod,
      }, {
        session: (context as any)?.session,
        turn: context?.turn,
        workspaceRoot: workspace.rootDir,
      });

      if (!audit.allowed) {
        return {
          success: false,
          submitted: false,
          error: audit.reasons.join('\n') || 'submit_solution bị từ chối do thiếu bằng chứng thực nghiệm.',
          errorCode: audit.errorCode || 'INVALID_SUMMARY_CONTENT',
          suggestion: audit.suggestion || 'Hãy đưa trực tiếp kết quả phân tích nguyên nhân gốc rễ, vị trí phát sinh lỗi và giải pháp cụ thể vào trường "summary".',
        } as any;
      }

      const timestamp = new Date().toISOString();

      return {
        success: true,
        submitted: true,
        summary,
        rootCause,
        filesModified: audit.reconciledFilesModified,
        verificationEvidence,
        resolutionType,
        verificationMethod,
        groundingScore: audit.score,
        informationDensity: audit.informationDensity,
        timestamp,
        nextAction: 'final_answer',
        message: 'Solution successfully submitted and verified with empirical evidence. The task is now COMPLETE. You MUST NOT call any further tools. Immediately output your final comprehensive answer and summary to the user in the EXACT SAME LANGUAGE as the user\'s original request prompt (e.g. Vietnamese if the user asked in Vietnamese). Present your findings, file paths, code logic, and verification proof clearly and professionally. Do not emit generic stubs or English placeholders.',
      };
    },
  };
}

export function registerSubmitSolutionTool(registry: ToolRegistry, workspace: Workspace): void {
  if (!registry.has('submit_solution')) {
    registry.register(createSubmitSolutionTool(workspace));
  }
}
