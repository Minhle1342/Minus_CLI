import { ToolDefinition } from './types.js';
import { Type } from '@google/genai';
import { ApprovalManager } from '../agent/approval-manager.js';
import { Workspace } from '../workspace/workspace.js';

export function createApprovalTools(approvalManager: ApprovalManager): ToolDefinition[] {
  const requestApprovalTool: ToolDefinition = {
    name: 'request_approval',
    description: 'Request explicit operator approval or choice for high-impact or ambiguous actions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: 'The name or identifier of the action requiring approval.',
        },
        description: {
          type: Type.STRING,
          description: 'Clear description of why approval is needed and what changes will occur.',
        },
      },
      required: ['action', 'description'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace) => {
      try {
        const req = approvalManager.requestApproval(String(args.action), String(args.description));
        return {
          approvalId: req.id,
          status: req.status,
          message: `Approval request '${req.id}' submitted for action '${args.action}'.`,
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'APPROVAL_REQUEST_FAILED',
        };
      }
    },
  };

  return [requestApprovalTool];
}
