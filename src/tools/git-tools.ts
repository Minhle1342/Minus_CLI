import { ToolDefinition, ToolExecutionContext } from './types.js';
import { Type } from '@google/genai';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Workspace } from '../workspace/workspace.js';
import {
  extractRequestedGitBranch,
  isForcePushAuthorized,
  isGitMutationAuthorized,
  GitMutationOperation,
} from './git-intent.js';
import { classifyGitCommand, isGitCommandAuthorized, validateGitCommandScope } from './git-command-policy.js';

const execFileAsync = promisify(execFile);

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

interface InstalledGitCommand {
  name: string;
  description: string;
  source: 'builtin' | 'external' | 'helper';
}

export function createGitTools(workspace: Workspace): ToolDefinition[] {
  let installedCommandsPromise: Promise<InstalledGitCommand[]> | undefined;
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

  const getInstalledCommands = async (): Promise<InstalledGitCommand[]> => {
    if (!installedCommandsPromise) {
      installedCommandsPromise = Promise.all([
        runGit(['help', '-a', '--external-commands', '--no-aliases']),
        runGit(['--list-cmds=main,others']),
      ]).then(([helpResult, runtimeResult]) => mergeInstalledGitCommands(
        parseInstalledGitCommands(helpResult.stdout),
        runtimeResult.stdout,
      ));
    }
    return installedCommandsPromise;
  };

  const gitListCommandsTool: ToolDefinition = {
    name: 'git_list_commands',
    description: 'List every built-in and installed external Git subcommand that git_command can invoke, with its runtime risk classification.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Optional case-insensitive command-name or description filter.' },
      },
    },
    execute: async (args: Record<string, any>) => {
      try {
        const query = String(args.query || '').trim().toLowerCase();
        const commands = (await getInstalledCommands())
          .filter((command) => !query || command.name.includes(query) || command.description.toLowerCase().includes(query))
          .map((command) => ({ ...command, risk: classifyGitCommand(command.name).risk }));
        return { success: true, count: commands.length, commands };
      } catch (err: any) {
        return gitFailure(err, 'GIT_COMMAND_DISCOVERY_FAILED');
      }
    },
  };

  const gitCommandTool: ToolDefinition = {
    name: 'git_command',
    description: 'Run any installed Git subcommand without a shell. Read-only commands are always available; write, network, and destructive commands require a matching explicit user request. Use git_list_commands to discover all available commands.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        subcommand: { type: Type.STRING, description: 'Git subcommand without the "git" prefix.' },
        args: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Exact argv items passed after the subcommand. Shell syntax is not evaluated.',
        },
        cwd: { type: Type.STRING, description: 'Optional workspace-relative working directory.' },
        stdin: { type: Type.STRING, description: 'Optional standard input for the Git process.' },
        timeout_ms: { type: Type.NUMBER, description: 'Timeout in milliseconds (1000-300000).' },
        output_encoding: {
          type: Type.STRING,
          enum: ['utf8', 'base64'],
          description: 'Use base64 only when binary output is required.',
        },
      },
      required: ['subcommand'],
    },
    execute: async (args: Record<string, any>, _workspace: Workspace, context?: ToolExecutionContext) => {
      const subcommand = String(args.subcommand || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(subcommand) || subcommand.includes('..')) {
        return { error: `Invalid Git subcommand: "${subcommand}".`, errorCode: 'GIT_INVALID_SUBCOMMAND' };
      }
      const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      if (commandArgs.length > 256 || commandArgs.some((arg: string) => arg.includes('\0') || arg.length > 16384)) {
        return { error: 'Git argv exceeds the supported safety limits.', errorCode: 'GIT_INVALID_ARGS' };
      }
      const stdin = args.stdin === undefined ? undefined : String(args.stdin);
      if (stdin && Buffer.byteLength(stdin, 'utf8') > 1024 * 1024) {
        return { error: 'Git stdin exceeds the 1 MiB limit.', errorCode: 'GIT_STDIN_TOO_LARGE' };
      }

      try {
        const installedCommands = await getInstalledCommands();
        if (!installedCommands.some((command) => command.name === subcommand)) {
          return {
            error: `Git subcommand "${subcommand}" is not installed or is only configured as a shell alias.`,
            errorCode: 'GIT_SUBCOMMAND_NOT_AVAILABLE',
            suggestion: 'Call git_list_commands to inspect available commands.',
          };
        }
        const cwd = args.cwd ? workspace.resolveSafePath(String(args.cwd)) : workspace.rootDir;
        const scopeDecision = validateGitCommandScope(subcommand, commandArgs, workspace.rootDir, cwd);
        if (!scopeDecision.allowed) return scopeDecision;

        const classification = classifyGitCommand(subcommand, commandArgs);
        if (!isGitCommandAuthorized(context?.userRequest, subcommand, classification)) {
          return {
            error: `Git ${subcommand} (${classification.risk}) is not authorized by the current user request.`,
            errorCode: classification.risk === 'destructive'
              ? 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED'
              : 'GIT_OPERATION_NOT_AUTHORIZED',
            risk: classification.risk,
            suggestion: `Ask the user to explicitly request git ${subcommand}${classification.risk === 'destructive' ? ' and its destructive behavior' : ''}.`,
          };
        }
        if (subcommand === 'push') {
          const requestedBranch = extractRequestedGitBranch(context?.userRequest);
          if (requestedBranch && !pushArgsTargetBranch(commandArgs, requestedBranch)) {
            return {
              error: `Push arguments do not target the user-requested branch "${requestedBranch}".`,
              errorCode: 'GIT_BRANCH_NOT_AUTHORIZED',
              requestedBranch,
            };
          }
        }

        const requestedTimeout = Number(args.timeout_ms);
        const timeoutMs = Math.min(300000, Math.max(1000, Number.isFinite(requestedTimeout) ? requestedTimeout : 120000));
        const outputEncoding = args.output_encoding === 'base64' ? 'base64' : 'utf8';
        const result = await executeGitProcess([subcommand, ...commandArgs], {
          cwd,
          stdin,
          timeoutMs,
          outputEncoding,
        });
        const response = {
          success: result.exitCode === 0 && !result.timedOut,
          subcommand,
          args: redactGitArguments(commandArgs),
          risk: classification.risk,
          exitCode: result.exitCode,
          stdout: redactGitOutput(result.stdout),
          stderr: redactGitOutput(result.stderr),
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
          outputEncoding,
        };
        return response.success ? response : {
          ...response,
          error: result.timedOut
            ? `git ${subcommand} timed out after ${timeoutMs}ms.`
            : redactGitOutput(result.stderr || result.stdout || `git ${subcommand} exited with code ${result.exitCode}.`),
          errorCode: result.timedOut ? 'GIT_COMMAND_TIMEOUT' : 'GIT_COMMAND_FAILED',
        };
      } catch (err: any) {
        return gitFailure(err, 'GIT_COMMAND_FAILED');
      }
    },
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

  return [gitListCommandsTool, gitCommandTool, gitStatusTool, gitDiffTool, gitAddTool, gitCommitTool, gitPushTool];
}

function parseInstalledGitCommands(helpOutput: string): InstalledGitCommand[] {
  const commands = new Map<string, InstalledGitCommand>();
  let includeSection = true;
  let source: InstalledGitCommand['source'] = 'builtin';
  for (const line of helpOutput.split(/\r?\n/)) {
    if (line && !/^\s/.test(line)) {
      includeSection = !line.startsWith('User-facing repository') && !line.startsWith('Developer-facing file');
      source = line.startsWith('External commands') ? 'external' : 'builtin';
      continue;
    }
    if (!includeSection) continue;
    const match = line.match(/^\s{3}([a-z0-9][a-z0-9._-]*)(?:\s{2,}(.+))?$/i);
    if (!match) continue;
    commands.set(match[1], {
      name: match[1],
      description: match[2]?.trim() || `Installed external Git command: ${match[1]}`,
      source,
    });
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeInstalledGitCommands(
  documentedCommands: InstalledGitCommand[],
  runtimeOutput: string,
): InstalledGitCommand[] {
  const commands = new Map(documentedCommands.map((command) => [command.name, command]));
  for (const name of runtimeOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..') || commands.has(name)) continue;
    commands.set(name, {
      name,
      description: `Installed Git runtime/helper command: ${name}`,
      source: 'helper',
    });
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface GitProcessOptions {
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  outputEncoding: 'utf8' | 'base64';
}

async function executeGitProcess(
  args: string[],
  options: GitProcessOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; durationMs: number }> {
  const startedAt = Date.now();
  const maxCaptureBytes = 10 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_EDITOR: 'true',
        GIT_SEQUENCE_EDITOR: 'true',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        LC_ALL: 'C',
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (capturedBytes >= maxCaptureBytes) {
        truncated = true;
        return;
      }
      const remaining = maxCaptureBytes - capturedBytes;
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(accepted);
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderrChunks, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: '', stderr: error.message, timedOut: false, truncated, durationMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const encode = (chunks: Buffer[]) => {
        const buffer = Buffer.concat(chunks);
        return options.outputEncoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8');
      };
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: encode(stdoutChunks),
        stderr: encode(stderrChunks),
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
    child.stdin.end(options.stdin || '');
  });
}

function pushArgsTargetBranch(args: string[], requestedBranch: string): boolean {
  const positional = args.filter((arg) => !arg.startsWith('-'));
  return positional.length >= 2
    && positional.slice(1).some((refspec) => refspec === requestedBranch || refspec.endsWith(`:${requestedBranch}`));
}

function redactGitOutput(value: string): string {
  return value
    .replace(/^(password|passwd|token|oauth_token|access_token|secret)=.*$/gim, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, 50000);
}

function redactGitArguments(args: string[]): string[] {
  return args.map((arg, index) => {
    if (index > 0 && /^(?:--password|--token|--secret)$/i.test(args[index - 1])) return '[REDACTED]';
    return redactGitOutput(arg);
  });
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
