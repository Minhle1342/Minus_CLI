import { ToolDefinition } from './types.js';
import { Type } from '@google/genai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Workspace } from '../workspace/workspace.js';

const execFileAsync = promisify(execFile);

export function createGitTools(workspace: Workspace): ToolDefinition[] {
  const runGit = async (args: string[]) => {
    return execFileAsync('git', args, {
      cwd: workspace.rootDir,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  };

  const gitStatusTool: ToolDefinition = {
    name: 'git_status',
    description: 'Inspect the current Git status of files in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
    execute: async () => {
      try {
        const { stdout } = await runGit(['status', '--short']);
        const lines = stdout.trim().split('\n').filter(Boolean);
        return {
          status: lines,
          clean: lines.length === 0,
          raw: stdout,
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'GIT_STATUS_FAILED',
        };
      }
    },
  };

  const gitDiffTool: ToolDefinition = {
    name: 'git_diff',
    description: 'Show changes between commits, commit and working tree, etc.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        staged: {
          type: Type.BOOLEAN,
          description: 'Whether to show staged changes (--cached).',
        },
        filePath: {
          type: Type.STRING,
          description: 'Optional specific file path to diff.',
        },
      },
    },
    execute: async (args: Record<string, any>) => {
      try {
        const cmdArgs = ['diff'];
        if (args.staged) cmdArgs.push('--cached');
        if (args.filePath) cmdArgs.push(String(args.filePath));

        const { stdout } = await runGit(cmdArgs);
        return {
          diff: stdout.slice(0, 50000),
          truncated: stdout.length > 50000,
          totalLength: stdout.length,
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'GIT_DIFF_FAILED',
        };
      }
    },
  };

  const gitCommitTool: ToolDefinition = {
    name: 'git_commit',
    description: 'Create an atomic Git commit with a structured commit message.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: {
          type: Type.STRING,
          description: 'The commit message.',
        },
        all: {
          type: Type.BOOLEAN,
          description: 'Whether to automatically stage modified and deleted files (-a).',
        },
      },
      required: ['message'],
    },
    execute: async (args: Record<string, any>) => {
      try {
        const cmdArgs = ['commit', '-m', String(args.message)];
        if (args.all) cmdArgs.push('-a');

        const { stdout } = await runGit(cmdArgs);
        return {
          success: true,
          output: stdout.trim(),
        };
      } catch (err: any) {
        return {
          error: err.message,
          errorCode: 'GIT_COMMIT_FAILED',
        };
      }
    },
  };

  return [gitStatusTool, gitDiffTool, gitCommitTool];
}
