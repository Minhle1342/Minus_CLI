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
    description: 'Submit the actual final answer as the last tool call for the current task, including every read-only question, explanation, review, and investigation. For read-only tasks, put the answer itself in summary; use resolutionType="investigation_only", filesModified=[], and verificationMethod="not_applicable" unless verification actually occurred. No edit or test is required for read-only answers. A report or plain-text answer does not replace successful submission. For tasks with code changes, run a real verification command after the last edit (test/build/lint/typecheck/get_diagnostics); merely running the script you created does not count. After successful submission, call no further tools.',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary: {
          type: 'STRING',
          description: 'The actual user-facing answer at the requested level of detail, not a status stub. For read-only tasks include findings and uncertainty without inventing edits or test results. For changes include the outcome and observed verification. Use the same natural language as the user\'s original prompt.',
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
          description: 'Optional for read-only answers; omit if no verification occurred. For code changes, give the exact verification command executed after the last edit. Never claim a command you did not run or treat merely running the created script as test verification.',
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
      const verificationEvidence = (args.verificationEvidence || '').trim();
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
        message: `Final answer successfully submitted. The task is now COMPLETE. You MUST NOT call any further tools. Return the submitted answer at the requested level of detail in the EXACT SAME LANGUAGE as the user's original request${responseLanguage ? ` (${responseLanguage})` : ''}. Include only findings and verification actually established; do not invent code changes, tests, or root causes.`,
      };
    },
  };
}

export function registerSubmitSolutionTool(registry: ToolRegistry, workspace: Workspace): void {
  if (!registry.has('submit_solution')) {
    registry.register(createSubmitSolutionTool(workspace));
  }
}
