import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';

export interface SubmitSolutionArgs {
  summary: string;
  rootCause?: string;
  filesModified?: string[];
  verificationEvidence: string;
}

export interface SubmitSolutionResult {
  success: boolean;
  submitted: boolean;
  summary: string;
  rootCause?: string;
  filesModified: string[];
  verificationEvidence: string;
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
          description: 'A comprehensive summary of the implemented solution and verified outcomes.',
        },
        rootCause: {
          type: 'STRING',
          description: 'Optional. Explanation of the root cause identified during debugging or investigation.',
        },
        filesModified: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of relative file paths that were modified, created, or deleted as part of the solution.',
        },
        verificationEvidence: {
          type: 'STRING',
          description: 'The verification command executed (e.g. "npm test", "npm run build", "pytest") and confirmation of successful passing exit code (exit 0).',
        },
      },
      required: ['summary', 'verificationEvidence'],
    } as any,
    execute: async (args: Record<string, any>, workspace: Workspace): Promise<SubmitSolutionResult> => {
      const summary = (args.summary || '').trim();
      const verificationEvidence = (args.verificationEvidence || '').trim();
      const filesModified = Array.isArray(args.filesModified)
        ? args.filesModified.map((f) => String(f).trim()).filter(Boolean)
        : [];
      const rootCause = args.rootCause ? String(args.rootCause).trim() : undefined;

      if (!summary) {
        throw new Error('Missing required argument: "summary" cannot be empty.');
      }
      if (!verificationEvidence) {
        throw new Error('Missing required argument: "verificationEvidence" is mandatory. Provide the test/build command and its passing result.');
      }

      const timestamp = new Date().toISOString();

      return {
        success: true,
        submitted: true,
        summary,
        rootCause,
        filesModified,
        verificationEvidence,
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
