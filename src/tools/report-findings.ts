import type { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { FinalAnswerGuard } from '../agent/final-answer-guard.js';

export interface ReportInvestigationFindingsArgs {
  userFacingReport: string;
  findings?: string[];
  evidence?: string[];
  uncertainties?: string[];
  recommendations?: string[];
  rootCause?: string;
  affectedFilesAndSymbols?: string[];
  evidenceTrace?: string;
  proposedSolution?: string;
}

export interface ReportInvestigationFindingsResult extends ReportInvestigationFindingsArgs {
  success: boolean;
  reported: boolean;
  timestamp: string;
  nextAction: string;
  message: string;
  error?: string;
  errorCode?: string;
  suggestion?: string;
}

/** Optional report storage. Recording a report does not verify its claims or any code changes. */
export function createReportFindingsTool(workspace?: Workspace): ToolDefinition {
  return {
    name: 'report_investigation_findings',
    description: 'Optionally record findings for a code explanation, investigation, or design proposal. You may instead answer directly. Include confirmed findings, evidence, uncertainty, and recommendations where relevant; no root cause, fixed outline, or minimum length is required.',
    parameters: {
      type: 'OBJECT',
      properties: {
        userFacingReport: { type: 'STRING', description: 'The actual answer in the language and level of detail requested by the user. This is a fallback if no newer answer is produced.' },
        findings: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Confirmed findings, when useful.' },
        evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Inspected files, symbols, or observed results supporting findings.' },
        uncertainties: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Unresolved questions or hypotheses. Do not invent a confirmed cause.' },
        recommendations: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional proposals, clearly distinguished from current implementation.' },
        rootCause: { type: 'STRING', description: 'Optional confirmed cause for diagnostic tasks.' },
        affectedFilesAndSymbols: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional related files or symbols.' },
        evidenceTrace: { type: 'STRING', description: 'Optional source or execution trace.' },
        proposedSolution: { type: 'STRING', description: 'Optional proposed change.' },
      },
      required: ['userFacingReport'],
    } as any,
    execute: async (args, workspaceContext, context): Promise<ReportInvestigationFindingsResult> => {
      const userFacingReport = String(args.userFacingReport || '').trim();
      const guard = new FinalAnswerGuard().evaluate(userFacingReport, {
        userRequest: context?.userRequest,
        workspace: workspaceContext || workspace,
      });
      const report: ReportInvestigationFindingsArgs = { userFacingReport };
      for (const key of ['findings', 'evidence', 'uncertainties', 'recommendations', 'affectedFilesAndSymbols'] as const) {
        if (Array.isArray(args[key])) report[key] = args[key].map(String).map((item: string) => item.trim()).filter(Boolean);
      }
      for (const key of ['rootCause', 'evidenceTrace', 'proposedSolution'] as const) {
        if (typeof args[key] === 'string' && args[key].trim()) report[key] = args[key].trim();
      }
      return {
        ...report,
        success: guard.allow,
        reported: guard.allow,
        timestamp: new Date().toISOString(),
        nextAction: guard.allow ? 'final_answer' : 'revise_report',
        message: guard.allow ? 'Report recorded. Answer directly, refining it if needed; recording is not independent verification.' : 'Provide the findings themselves or correct unsupported references.',
        ...(!guard.allow ? {
          error: guard.continuationPrompt,
          errorCode: 'INVALID_REPORT',
          suggestion: 'Use the requested detail and format. State what is known and what remains uncertain.',
        } : {}),
      };
    },
  };
}

export function registerReportFindingsTool(registry: ToolRegistry, workspace?: Workspace): void {
  registry.register(createReportFindingsTool(workspace));
}
