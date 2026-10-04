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
  responseLanguage?: string;
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
  responseLanguage?: string;
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
    description: 'Explicitly submit the finalized solution and empirical verification proof for the current task or goal. PRECONDITION: after your last code edit you must have run a real verification command (test suite such as npm test / pytest / jest, build, lint, typecheck, get_diagnostics, or python -m py_compile for standalone scripts) and seen it pass — running the script you just created (e.g. "python regex.py") does NOT count as verification and the call will be rejected with VERIFICATION_FAILED. Call this tool only when that verification has executed successfully.',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary: {
          type: 'STRING',
          description: 'A comprehensive summary of the implemented solution, files modified, and verified outcomes. MUST be written in the same natural language as the user\'s original prompt (see responseLanguage).',
        },
        responseLanguage: {
          type: 'STRING',
          description: 'The natural language of the user\'s original prompt as typed in the input box (e.g. "Vietnamese", "English", "Japanese"). The summary and the final answer to the user MUST be written in this language. Code, file paths and identifiers stay unchanged.',
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
          description: 'Optional, but must match reality: use automated_test_pass only if a test suite actually passed, static_diagnostics_clean only if get_diagnostics/typecheck ran clean. Just running the file you created is direct_validation at best and never satisfies the pre-call verification gate.',
        },
        verificationEvidence: {
          type: 'STRING',
          description: 'Required in practice. The exact verification command you executed AFTER your last edit (e.g. "npm test", "pytest test_regex.py", "get_diagnostics"). The gate checks the session for this command — a command you never ran, or merely running the script you created, will be rejected.',
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
      const responseLanguage = args.responseLanguage ? String(args.responseLanguage).trim() || undefined : undefined;

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
        userRequest: context?.userRequest,
      });

      if (!audit.allowed) {
        return {
          success: false,
          submitted: false,
          error: audit.reasons.join('\n') || 'submit_solution rejected: missing empirical evidence.',
          errorCode: audit.errorCode || 'INVALID_SUMMARY_CONTENT',
          suggestion: audit.suggestion || 'Put the root-cause analysis, error location and concrete solution directly into the "summary" field.',
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
        responseLanguage,
        resolutionType,
        verificationMethod,
        groundingScore: audit.score,
        informationDensity: audit.informationDensity,
        timestamp,
        nextAction: 'final_answer',
        message: `Solution successfully submitted and verified with empirical evidence. The task is now COMPLETE. You MUST NOT call any further tools. Immediately output your final comprehensive answer and summary to the user in the EXACT SAME LANGUAGE as the user's original request prompt${responseLanguage ? ` (${responseLanguage})` : ' (e.g. Vietnamese if the user asked in Vietnamese)'}. Present your findings, file paths, code logic, and verification proof clearly and professionally. Do not emit generic stubs or English placeholders.`,
      };
    },
  };
}

export function registerSubmitSolutionTool(registry: ToolRegistry, workspace: Workspace): void {
  if (!registry.has('submit_solution')) {
    registry.register(createSubmitSolutionTool(workspace));
  }
}
