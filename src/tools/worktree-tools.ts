import { ToolDefinition } from './types.js';
import { Type } from '@google/genai';
import { WorktreeManager } from '../workspace/worktree-manager.js';
import { Workspace } from '../workspace/workspace.js';

export function createWorktreeTools(worktreeManager: WorktreeManager): ToolDefinition[] {
  const createWorktreeTool: ToolDefinition = {
    name: 'create_worktree',
    description: 'Create an isolated Git worktree workspace inside .codingagent/worktrees for clean feature development.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        branch: {
          type: Type.STRING,
          description: 'The target git branch name to checkout in the worktree.',
        },
        name: {
          type: Type.STRING,
          description: 'Optional custom folder name for the worktree.',
        },
      },
      required: ['branch'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace) => {
      try {
        const result = await worktreeManager.create(String(args.branch), args.name ? String(args.name) : undefined);
        return {
          success: true,
          worktreePath: result.worktreePath,
          branch: result.branch,
          message: `Created isolated worktree at '${result.worktreePath}' on branch '${result.branch}'.`,
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'WORKTREE_CREATE_FAILED',
        };
      }
    },
  };

  const listWorktreesTool: ToolDefinition = {
    name: 'list_worktrees',
    description: 'List all existing Git worktrees in this repository.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
    execute: async (_args: Record<string, any>, _workspace: Workspace) => {
      try {
        const worktrees = await worktreeManager.list();
        return {
          worktrees,
          count: worktrees.length,
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'WORKTREE_LIST_FAILED',
        };
      }
    },
  };

  const removeWorktreeTool: ToolDefinition = {
    name: 'remove_worktree',
    description: 'Safely remove an isolated Git worktree that is no longer needed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        worktreePath: {
          type: Type.STRING,
          description: 'Path of the worktree directory to remove.',
        },
        force: {
          type: Type.BOOLEAN,
          description: 'Whether to force removal even if there are uncommitted changes.',
        },
      },
      required: ['worktreePath'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace) => {
      try {
        await worktreeManager.remove(String(args.worktreePath), args.force === true);
        return {
          success: true,
          message: `Worktree '${args.worktreePath}' was successfully removed.`,
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'WORKTREE_REMOVE_FAILED',
        };
      }
    },
  };

  return [createWorktreeTool, listWorktreesTool, removeWorktreeTool];
}
