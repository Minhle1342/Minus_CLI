import { ToolDefinition, ToolExecutionContext } from './types.js';
import { Type } from '@google/genai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import {
  extractRequestedGitBranch,
  isForcePushAuthorized,
  isGitMutationAuthorized,
  GitMutationOperation,
} from './git-intent.js';

const execFileAsync = promisify(execFile);

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export function createGitTools(workspace: Workspace): ToolDefinition[] {
  const runGit = async (args: string[]): Promise<GitCommandResult> => {
    const result = await execFileAsync('git', args, {
      cwd: workspace.rootDir,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };

  const requireAuthorization = (
    context: ToolExecutionContext | undefined,
    operation: GitMutationOperation,
  ): Record<string, any> | undefined => {
    if (isGitMutationAuthorized(context?.userRequest, operation)) return undefined;
    return {
      error: `Git ${operation} is not authorized for this turn. The user must explicitly request this Git operation.`,
      errorCode: 'GIT_OPERATION_NOT_AUTHORIZED',
      operation,
      suggestion: `Ask the user to explicitly request Git ${operation}; do not use run_command to bypass this policy.`,
    };
  };

  const gitStatusTool: ToolDefinition = {
    name: 'git_status',
    description: 'Inspect the current Git branch and working-tree status before staging, committing, or pushing.',
    parameters: { type: Type.OBJECT, properties: {} },
    execute: async () => {
      try {
        const [{ stdout }, branchResult] = await Promise.all([
          runGit(['status', '--short']),
          runGit(['branch', '--show-current']),
        ]);
        const lines = stdout.trim().split('\n').filter(Boolean);
        return {
          status: lines,
          clean: lines.length === 0,
          branch: branchResult.stdout.trim() || null,
          raw: stdout,
        };
      } catch (err: any) {
        return gitFailure(err, 'GIT_STATUS_FAILED');
      }
    },
  };

  const gitDiffTool: ToolDefinition = {
    name: 'git_diff',
    description: 'Inspect unstaged or staged Git changes before creating a commit.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        staged: { type: Type.BOOLEAN, description: 'Whether to show staged changes (--cached).' },
        filePath: { type: Type.STRING, description: 'Optional workspace-relative file path to diff.' },
      },
    },
    execute: async (args: Record<string, any>) => {
      try {
        const cmdArgs = ['diff'];
        if (args.staged) cmdArgs.push('--cached');
        if (args.filePath) {
          const safePath = workspace.resolveSafePath(String(args.filePath));
          cmdArgs.push('--', path.relative(workspace.rootDir, safePath));
        }
        const { stdout } = await runGit(cmdArgs);
        return {
          diff: stdout.slice(0, 50000),
          truncated: stdout.length > 50000,
          totalLength: stdout.length,
        };
      } catch (err: any) {
        return gitFailure(err, 'GIT_DIFF_FAILED');
      }
    },
  };

  const gitAddTool: ToolDefinition = {
    name: 'git_add',
    description: 'Stage workspace changes for a commit. Available only when the current user explicitly requests staging or committing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        all: {
          type: Type.BOOLEAN,
          description: 'Stage all tracked, untracked, and deleted workspace files. Defaults to true when paths are omitted.',
        },
        paths: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Optional workspace-relative paths to stage selectively.',
        },
      },
    },
    execute: async (args: Record<string, any>, _workspace: Workspace, context?: ToolExecutionContext) => {
      const denied = requireAuthorization(context, 'stage');
      if (denied) return denied;
      try {
        const requestedPaths = Array.isArray(args.paths)
          ? args.paths.map(String).filter((item: string) => item.trim().length > 0)
          : [];
        const cmdArgs = ['add'];
        if (args.all === true || requestedPaths.length === 0) {
          cmdArgs.push('--all');
        } else {
          const safePaths = requestedPaths.map((item: string) => {
            const safePath = workspace.resolveSafePath(item);
            return path.relative(workspace.rootDir, safePath);
          });
          cmdArgs.push('--', ...safePaths);
        }
        await runGit(cmdArgs);
        const { stdout } = await runGit(['status', '--short']);
        return { success: true, staged: stdout.trim().split('\n').filter(Boolean) };
      } catch (err: any) {
        return gitFailure(err, 'GIT_ADD_FAILED');
      }
    },
  };

  const gitCommitTool: ToolDefinition = {
    name: 'git_commit',
    description: 'Create a local Git commit after verification and staging. Available only when the current user explicitly requests a commit.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: { type: Type.STRING, description: 'The commit message.' },
        all: {
          type: Type.BOOLEAN,
          description: 'Automatically stage modified and deleted tracked files (-a). This does not include untracked files.',
        },
      },
      required: ['message'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace, context?: ToolExecutionContext) => {
      const denied = requireAuthorization(context, 'commit');
      if (denied) return denied;
      try {
        const cmdArgs = ['commit', '-m', String(args.message)];
        if (args.all) cmdArgs.push('-a');
        const { stdout, stderr } = await runGit(cmdArgs);
        const { stdout: commitHash } = await runGit(['rev-parse', 'HEAD']);
        return {
          success: true,
          commit: commitHash.trim(),
          output: [stdout, stderr].filter(Boolean).join('\n').trim(),
        };
      } catch (err: any) {
        return gitFailure(err, 'GIT_COMMIT_FAILED');
      }
    },
  };

  const gitPushTool: ToolDefinition = {
    name: 'git_push',
    description: 'Push the current HEAD to a configured Git remote and destination branch. Available only when the current user explicitly requests a push.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        remote: { type: Type.STRING, description: 'Configured remote name. Defaults to "origin".' },
        branch: { type: Type.STRING, description: 'Destination branch on the remote. Defaults to the current local branch.' },
        setUpstream: { type: Type.BOOLEAN, description: 'Set the upstream tracking branch. Defaults to true.' },
        forceWithLease: { type: Type.BOOLEAN, description: 'Use --force-with-lease. Never uses an unconditional force push.' },
      },
    },
    execute: async (args: Record<string, any>, _workspace: Workspace, context?: ToolExecutionContext) => {
      const denied = requireAuthorization(context, 'push');
      if (denied) return denied;
      if (args.forceWithLease === true && !isForcePushAuthorized(context?.userRequest)) {
        return {
          error: 'Force-with-lease push is not authorized for this turn. The user requested a normal push.',
          errorCode: 'GIT_FORCE_PUSH_NOT_AUTHORIZED',
        };
      }
      try {
        const remote = String(args.remote || 'origin').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
          return { error: `Invalid Git remote name: "${remote}".`, errorCode: 'GIT_INVALID_REMOTE' };
        }

        const { stdout: remotesOutput } = await runGit(['remote']);
        const remotes = remotesOutput.trim().split('\n').filter(Boolean);
        if (!remotes.includes(remote)) {
          return {
            error: `Git remote "${remote}" is not configured. Available remotes: ${remotes.join(', ') || '(none)'}.`,
            errorCode: 'GIT_REMOTE_NOT_FOUND',
            remotes,
          };
        }

        const { stdout: currentBranchOutput } = await runGit(['branch', '--show-current']);
        const currentBranch = currentBranchOutput.trim();
        const requestedBranch = extractRequestedGitBranch(context?.userRequest);
        const branch = String(args.branch || requestedBranch || currentBranch).trim();
        if (!branch) {
          return {
            error: 'Cannot infer a destination branch while HEAD is detached. Pass the branch argument explicitly.',
            errorCode: 'GIT_BRANCH_REQUIRED',
          };
        }
        if (requestedBranch && branch !== requestedBranch) {
          return {
            error: `Destination branch "${branch}" does not match the user-requested branch "${requestedBranch}".`,
            errorCode: 'GIT_BRANCH_NOT_AUTHORIZED',
            requestedBranch,
          };
        }
        await runGit(['check-ref-format', '--branch', branch]);

        const cmdArgs = ['push'];
        if (args.setUpstream !== false) cmdArgs.push('--set-upstream');
        if (args.forceWithLease === true) cmdArgs.push('--force-with-lease');
        cmdArgs.push(remote, `HEAD:${branch}`);
        const { stdout, stderr } = await runGit(cmdArgs);
        const { stdout: commitHash } = await runGit(['rev-parse', 'HEAD']);
        return {
          success: true,
          remote,
          branch,
          commit: commitHash.trim(),
          forcedWithLease: args.forceWithLease === true,
          output: [stdout, stderr].filter(Boolean).join('\n').trim(),
        };
      } catch (err: any) {
        return gitFailure(err, 'GIT_PUSH_FAILED');
      }
    },
  };

  return [gitStatusTool, gitDiffTool, gitAddTool, gitCommitTool, gitPushTool];
}

function gitFailure(err: any, errorCode: string): Record<string, any> {
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : '';
  return {
    error: stderr || stdout || err?.message || 'Unknown Git error.',
    errorCode,
    exitCode: typeof err?.code === 'number' ? err.code : undefined,
  };
}
