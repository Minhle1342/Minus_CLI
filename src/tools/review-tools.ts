import { ToolDefinition } from './types.js';
import { Type } from '@google/genai';
import { ReviewManager, ReviewVerdict } from '../agent/review-manager.js';
import { Workspace } from '../workspace/workspace.js';
import { OcrReviewService, type OcrReviewMode } from '../review/open-code-review.js';

export function createReviewTools(reviewManager: ReviewManager, ocrReview?: OcrReviewService): ToolDefinition[] {
  const requestReviewTool: ToolDefinition = {
    name: 'request_review',
    description: 'Submit an implementation task for spec compliance and architecture review before completing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: { type: Type.INTEGER, description: 'ID of the task in the plan.' },
        title: { type: Type.STRING, description: 'Title or summary of the completed work.' },
        diffSummary: { type: Type.STRING, description: 'Summary of files and lines changed.' },
        evidence: { type: Type.STRING, description: 'Test execution or verification output proof.' },
      },
      required: ['taskId', 'title'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace) => {
      try {
        const req = reviewManager.requestReview(Number(args.taskId), String(args.title), {
          diffSummary: args.diffSummary ? String(args.diffSummary) : undefined,
          evidence: args.evidence ? String(args.evidence) : undefined,
        });
        return {
          success: true,
          reviewRequestId: req.id,
          status: req.status,
          message: `Task #${args.taskId} submitted for review with request ID '${req.id}'.`,
        };
      } catch (err: any) {
        return { error: err.message, errorCode: 'REVIEW_REQUEST_FAILED' };
      }
    },
  };

  const submitReviewTool: ToolDefinition = {
    name: 'submit_review',
    description: 'Submit a review verdict (approved or changes_requested) for a task review request.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reviewRequestId: { type: Type.STRING, description: 'The review request ID.' },
        verdict: {
          type: Type.STRING,
          description: 'The review decision: "approved" or "changes_requested".',
        },
        comments: { type: Type.STRING, description: 'Detailed review feedback or approval comments.' },
      },
      required: ['reviewRequestId', 'verdict', 'comments'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace) => {
      try {
        const verdict = args.verdict as ReviewVerdict;
        const record = reviewManager.submitReview(String(args.reviewRequestId), verdict, String(args.comments));
        return {
          success: true,
          reviewId: record.id,
          verdict: record.verdict,
          message: `Review recorded with verdict '${record.verdict}'.`,
        };
      } catch (err: any) {
        return { error: err.message, errorCode: 'REVIEW_SUBMISSION_FAILED' };
      }
    },
  };

  const tools = [requestReviewTool, submitReviewTool];
  if (!ocrReview) return tools;

  const runCodeReviewTool: ToolDefinition = {
    name: 'run_code_review',
    description: 'Run OpenCodeReview over workspace changes, a branch range, a commit, or complete files and return structured findings.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          description: 'Review mode: workspace, range, commit, or scan. Defaults to workspace.',
        },
        from: { type: Type.STRING, description: 'Base ref for range mode.' },
        to: { type: Type.STRING, description: 'Target ref for range mode.' },
        commit: { type: Type.STRING, description: 'Commit hash or ref for commit mode.' },
        paths: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Repository-relative paths for scan scope or completion identity.',
        },
        background: { type: Type.STRING, description: 'Requirements or business context for the reviewer.' },
        rulePath: { type: Type.STRING, description: 'Workspace-relative custom OCR rule file.' },
        resumeSessionId: { type: Type.STRING, description: 'OCR session to resume for range or commit mode.' },
        force: { type: Type.BOOLEAN, description: 'Ignore a fresh cached result and run OCR again.' },
      },
    },
    execute: async (args, _workspace, context) => {
      try {
        const run = await ocrReview.run({
          mode: (args.mode ? String(args.mode) : 'workspace') as OcrReviewMode,
          from: args.from ? String(args.from) : undefined,
          to: args.to ? String(args.to) : undefined,
          commit: args.commit ? String(args.commit) : undefined,
          paths: Array.isArray(args.paths) ? args.paths.map(String) : undefined,
          background: args.background ? String(args.background) : context?.userRequest,
          rulePath: args.rulePath ? String(args.rulePath) : undefined,
          resumeSessionId: args.resumeSessionId ? String(args.resumeSessionId) : undefined,
          force: Boolean(args.force),
          trigger: 'manual',
          signal: context?.signal,
        });
        return { success: run.status !== 'failed', ...run };
      } catch (err: any) {
        return { success: false, error: err.message, errorCode: 'OCR_REVIEW_FAILED' };
      }
    },
  };

  const getCodeReviewStatusTool: ToolDefinition = {
    name: 'get_code_review_status',
    description: 'Inspect OpenCodeReview enablement, gate settings, and the latest review result without running a review.',
    parameters: { type: Type.OBJECT, properties: {} },
    execute: async () => ({
      success: true,
      config: ocrReview.getConfig(),
      lastRun: ocrReview.getLastRun(),
    }),
  };

  return [...tools, runCodeReviewTool, getCodeReviewStatusTool];
}
