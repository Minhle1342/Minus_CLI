import { ToolDefinition } from './types.js';
import { Type } from '@google/genai';
import { ReviewManager, ReviewVerdict } from '../agent/review-manager.js';
import { Workspace } from '../workspace/workspace.js';

export function createReviewTools(reviewManager: ReviewManager): ToolDefinition[] {
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

  return [requestReviewTool, submitReviewTool];
}
