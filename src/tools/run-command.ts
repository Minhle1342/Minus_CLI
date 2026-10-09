import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition, type ToolExecutionContext } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { diagnoseCommandFailure, getDevToolSuggestion } from '../sandbox/command-diagnostics.js';
import { LocalProcessSandbox } from '../sandbox/local-sandbox.js';
import { executeRipgrepEmulation, parseRipgrepCommand } from './rg-emulator.js';
import { TaskManager } from '../tasks/task-manager.js';
import { analyzeShellCommand } from '../security/shell-segmenter.js';
import {
  sanitizeTerminalOutput,
  distillTestOutput,
  truncateTerminalOutput,
  offloadLargeLogToDisk,
} from './terminal-sanitizer.js';
import {
  evaluateCommandPreflight,
  normalizeWindowsCommand,
  probeMissingBinary,
  clearBinaryProbeCache,
} from './command-preflight-guard.js';
import { annotateCommandResult } from './command-outcome.js';
import { ToolchainProvisioner } from '../toolchains/toolchain-provisioner.js';
import { findRecipeForBinary } from '../toolchains/toolchain-recipes.js';
import { findMissingExecutable } from '../sandbox/command-diagnostics.js';
import { evaluateHostCommandPolicy, mustBlockUnisolatedAutoExecution } from '../sandbox/command-isolation-policy.js';
import { classifyGitCommand, isBroadAddWithCommitIntent, isExplicitGitAddPathList, isGitCommandAuthorized, parseGitInvocation, validateGitCommandScope } from './git-command-policy.js';
import { extractRequestedGitBranch } from './git-intent.js';
import { pushArgsTargetBranch } from './git-tools.js';
import { buildSafeChildEnv, collectSecretsFromEnv, redactSecretsFromText } from '../security/env-scrub.js';
import { evaluateCommandHooks } from '../sandbox/command-hooks.js';
import {
  resolveSessionCwd,
  trackSessionEnv,
  tryHandleCdCommand,
} from './shell-session.js';

const MAX_COMMAND_BUFFER_BYTES = 5 * 1024 * 1024;

/**
 * Soft-timeout → background auto-promotion (Claude Code parity, lite).
 * Only for explicit long jobs (timeout_ms=0 or >120s, i.e. the caller already
 * signaled "this will take a while") so ordinary build/test stays sync.
 * Returns the auto wait window (ms) or undefined when sync should proceed.
 */
export function resolveAutoBackgroundWait(
  waitMsBeforeAsync: number | undefined,
  timeoutMs: number,
  taskManager?: TaskManager,
): number | undefined {
  if (waitMsBeforeAsync !== undefined && waitMsBeforeAsync > 0) return waitMsBeforeAsync;
  if (!taskManager) return undefined;
  if (process.env.MINUS_AUTO_BACKGROUND?.toLowerCase() === 'off') return undefined;
  if (timeoutMs !== 0 && !(timeoutMs > 120000)) return undefined;
  const soft = Number(process.env.MINUS_SOFT_TIMEOUT_MS);
  const softMs = Number.isFinite(soft) && soft > 0 ? Math.min(10000, soft) : 10000;
  return waitMsBeforeAsync !== undefined ? waitMsBeforeAsync : softMs;
}

// Danh sách các tiền tố lệnh an toàn khi chạy ở chế độ Host / Unsandboxed (Terminal-First Exploration & Build)
const ALLOWED_COMMAND_PREFIXES = [
  // Khám phá Codebase & Điều tra tệp tin (Terminal-First)
  'cat ',
  'cat',
  'type ',
  'type',
  'Get-Content',
  'gc ',
  'head ',
  'head',
  'tail ',
  'tail',
  'more ',
  'more',
  'less ',
  'less',
  'ls',
  'ls ',
  'dir',
  'dir ',
  'tree',
  'Get-ChildItem',
  'gci ',
  'grep ',
  'rg ',
  'ripgrep ',
  'findstr ',
  'Select-String',
  'sls ',
  'find ',
  'find.',
  'fd ',
  'wc ',
  'wc',
  'which ',
  'where ',
  'pwd',
  'echo ',
  'printf ',
  'env',
  'printenv',
  'set ',
  '$env:',
  'jq ',
  'jq',
  'sed ',
  'awk ',
  // Điều hướng shell & plumbing an toàn trong workspace (cwd đã cố định workspaceRoot)
  'cd ',
  'mkdir ',
  'cp ',
  'sleep ',
  'timeout ',
  // Build, Test & Package Management
  'npm test',
  'npm run ',
  'npm start',
  'npm --version',
  'npm list',
  'npx ',
  'npx tsx',
  'npx tsc',
  'npx eslint',
  'npx prettier',
  'npx jest',
  'npx vitest',
  'bun ',
  'bun',
  'bunx ',
  'bunx',
  'node ',
  'node -v',
  'node --version',
  'uv ',
  'uv',
  'uvx ',
  'uvx',
  'dotnet ',
  'dotnet',
  'python ',
  'python3 ',
  'pip ',
  'pip3 ',
  'pytest ',
  'mvn ',
  'gradle ',
  './gradlew',
  'gradlew',
  'go ',
  'cargo ',
  'rustc ',
  'tsc',
  'curl ',
  'wget ',
  // Bare JS/TS binaries (không qua npx) cho build/test/lint
  'tsc ',
  'eslint ',
  'jest ',
  'vitest ',
  'prettier ',
  // Docker chỉ-đọc để chẩn đoán sandbox (không cho approvals rộng: subcommands ghi vẫn cần approval)
  'docker ps',
  'docker ps ',
  'docker images',
  'docker images ',
  'docker --version',
  // Git commands (Tiêu chuẩn Công nghiệp: Cho phép thao tác Git qua run_command, chặn unrequested push lên main)
  'git status',
  'git status ',
  'git diff',
  'git diff ',
  'git log',
  'git log ',
  'git branch',
  'git branch ',
  'git show',
  'git show ',
  'git rev-parse',
  'git rev-parse ',
  'git describe',
  'git describe ',
  'git tag',
  'git tag ',
  'git add',
  'git add ',
  'git commit',
  'git commit ',
  'git checkout',
  'git checkout ',
  'git switch',
  'git switch ',
  'git restore',
  'git restore ',
  'git stash',
  'git stash ',
  'git reset',
  'git reset ',
  'git merge',
  'git merge ',
  'git rebase',
  'git rebase ',
  'git cherry-pick',
  'git cherry-pick ',
  'git fetch',
  'git fetch ',
  'git pull',
  'git pull ',
  'git rm',
  'git rm ',
  'git mv',
  'git mv ',
  'git init',
  'git init ',
  'git clone',
  'git clone ',
  'git clean',
  'git clean ',
  'git remote',
  'git remote ',
  'git config',
  'git config ',
  'git check-ignore',
  'git check-ignore ',
  'git blame',
  'git blame ',
  'git shortlog',
  'git shortlog ',
  'git push',
  'git push ',
];

/**
 * Làm sạch và cắt ngắn output nếu quá dài để bảo vệ context window của LLM (RTK & SWE-agent standard).
 */
export function truncateOutput(
  text: string,
  maxLength?: number,
  options?: { logFilePath?: string; exitCode?: number }
): string {
  if (!text) return '';
  const sanitized = sanitizeTerminalOutput(text);
  const distilled = distillTestOutput(sanitized, options?.exitCode);
  const result = truncateTerminalOutput(distilled, {
    maxLength,
    logFilePath: options?.logFilePath,
    exitCode: options?.exitCode,
  });
  return result.text;
}

/**
 * Xử lý hoàn tất output lệnh:
 * - Làm sạch ANSI và \r
 * - Bóc tách lỗi kiểm thử nếu fail
 * - Tự động offload full log ra đĩa nếu vượt ngưỡng (mặc định 8,000 ký tự)
 * - Cắt ngắn và đính kèm đường dẫn log file cho LLM
 */
export async function finalizeCommandResult(
  baseResult: {
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    success?: boolean;
    [key: string]: any;
  },
  workspace: Workspace,
  extra?: { preflightAdvisory?: string },
): Promise<Record<string, any>> {
  const classifiedResult = annotateCommandResult(baseResult.command, baseResult);
  const exitCode = typeof classifiedResult.exitCode === 'number' ? classifiedResult.exitCode : 0;
  // Env-scrub: redact secret values before they can enter LLM context or disk.
  const secrets = collectSecretsFromEnv({ ...(process.env as Record<string, string>), ...((baseResult as any).envForRedaction || {}) });
  const cleanStdout = redactSecretsFromText(sanitizeTerminalOutput(baseResult.stdout || ''), secrets);
  const cleanStderr = redactSecretsFromText(sanitizeTerminalOutput(baseResult.stderr || ''), secrets);
  const distilledStdout = distillTestOutput(cleanStdout, exitCode);

  const configuredMax = Number(process.env.MINUS_TERMINAL_MAX_OUTPUT_CHARS);
  const maxLength = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 8000;

  let logFilePath: string | undefined;
  const combinedLength = distilledStdout.length + cleanStderr.length;
  if (combinedLength > maxLength) {
    const redactedRawStdout = redactSecretsFromText(baseResult.stdout || '', secrets);
    const redactedRawStderr = redactSecretsFromText(baseResult.stderr || '', secrets);
    const fullLog = `=== COMMAND ===\n${baseResult.command}\n\n=== STDOUT ===\n${redactedRawStdout}\n\n=== STDERR ===\n${redactedRawStderr}`;
    logFilePath = await offloadLargeLogToDisk(workspace.rootDir, fullLog, baseResult.command);
  }

  const truncatedStdout = truncateTerminalOutput(distilledStdout, {
    maxLength,
    exitCode,
    logFilePath,
  });
  const truncatedStderr = truncateTerminalOutput(cleanStderr, {
    maxLength: Math.floor(maxLength / 2),
    exitCode,
    logFilePath,
  });

  return {
    ...classifiedResult,
    stdout: truncatedStdout.text,
    stderr: truncatedStderr.text,
    exitCode,
    durationMs: typeof baseResult.durationMs === 'number' ? baseResult.durationMs : 0,
    success: classifiedResult.success,
    verificationOutputComplete: truncatedStdout.savedChars === 0 && truncatedStderr.savedChars === 0,
    ...(logFilePath ? { logFilePath } : {}),
    ...(truncatedStdout.savedChars > 0 ? { savedTokensEstimate: truncatedStdout.savedTokensEstimate } : {}),
    ...(extra?.preflightAdvisory ? { preflightAdvisory: extra.preflightAdvisory } : {}),
  };
}

/**
 * Kiểm tra xem lệnh Git push có nhắm tới nhánh main/master hay không.
 * Tuân thủ nghiêm ngặt User Rule 2: Chặn tự động push lên main để không kích hoạt CI/CD Railway.
 */
export function isBlockedGitPushToMain(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!/\bgit(?:\.exe)?\b/i.test(trimmed)) return false;
  const subcmd = findGitSubcommand(command);
  if (subcmd !== 'push') return false;
  // Match: git push origin main, git push -u origin main, git push origin HEAD:main, git push ... master
  return /\b(?:origin\s+)?(?:HEAD:)?(?:main|master)\b/i.test(trimmed);
}

/**
 * Kiểm tra xem lệnh có nằm trong danh sách an toàn hay không (cho Host mode).
 */
export function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (ALLOWED_COMMAND_PREFIXES.some((prefix) => {
    const exact = prefix.trim();
    return trimmed === exact || (prefix.endsWith(' ') && trimmed.startsWith(prefix));
  })) {
    return true;
  }
  // Cho phép ctest và thực thi test binary cục bộ trong workspace (bin/Debug/..., target/debug/..., x64/Debug/...)
  if (
    /^(?:ctest\b)/i.test(trimmed)
    || /^(?:\.?[\/\\])?(?:bin|target|build|x64|x86)[\/\\](?:debug|release)[\/\\][a-zA-Z0-9_.-]*test[a-zA-Z0-9_.-]*(?:\.exe)?(?:\s+.*)?$/i.test(trimmed)
  ) {
    return true;
  }
  // Cho phép các lệnh gán biến môi trường an toàn ($env:VAR=..., set VAR=..., export VAR=...)
  if (
    /^\$env:[a-zA-Z_][a-zA-Z0-9_]*\s*=/i.test(trimmed)
    || /^set\s+(?:"?[a-zA-Z_][a-zA-Z0-9_]*=)/i.test(trimmed)
    || /^export\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=/i.test(trimmed)
  ) {
    return true;
  }
  // Cho phép mọi lệnh Git thông thường nếu subcommand hợp lệ
  const gitSub = findGitSubcommand(command);
  if (gitSub) {
    const safeGitSubcommands = new Set([
      'status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'describe', 'tag',
      'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'reset', 'merge',
      'rebase', 'cherry-pick', 'fetch', 'pull', 'rm', 'mv', 'init', 'clone',
      'clean', 'remote', 'config', 'check-ignore', 'blame', 'shortlog', 'push',
    ]);
    if (safeGitSubcommands.has(gitSub)) {
      return true;
    }
  }
  return false;
}

export function isAllowedShellCommand(command: string): boolean {
  const analysis = analyzeShellCommand(command);
  if (analysis.error) return false;
  if (!analysis.complex && analysis.segments.every(isAllowedCommand)) return true;
  // Item 12: bounded two-segment pipelines of allowlisted commands skip approval.
  return isBoundedAllowlistedPipeline(analysis);
}

/**
 * A single `|` joining exactly two allowlisted segments, with no redirect,
 * backgrounding, or substitution anywhere. Anything else keeps the old
 * approval requirement.
 */
export function isBoundedAllowlistedPipeline(analysis: ReturnType<typeof analyzeShellCommand>): boolean {
  if (analysis.error || analysis.operators.length !== 1 || analysis.operators[0] !== '|') return false;
  if (analysis.segments.length !== 2 || !analysis.segments.every(isAllowedCommand)) return false;
  return analysis.segments.every((segment) => !/[><]|`|\$\(/.test(segment));
}

export interface GitShellPolicyViolation {
  error: string;
  errorCode: string;
  suggestion?: string;
  requestedBranch?: string;
}

/**
 * F3: whether a user is present to answer approval prompts. A permission
 * manager without a prompt handler (headless/CI runs deny approvals) means no
 * approval can ever arrive, so suggestions must redirect to allowlisted
 * commands instead of telling the model to wait for a user.
 */
export function hasApprovalChannel(permissionManager: any): boolean {
  try {
    return typeof permissionManager?.hasApprovalChannel === 'function'
      ? Boolean(permissionManager.hasApprovalChannel())
      : false;
  } catch {
    return false;
  }
}

/** Approval suggestion branched by session interactivity; errorCodes are untouched. */
export function approvalSuggestion(permissionManager: any, misuse?: { tool: string; reason: string }): string {
  if (hasApprovalChannel(permissionManager)) {
    return misuse
      ? `Recommend switching to the dedicated tool "${misuse.tool}": ${misuse.reason}`
      : 'Ask the user to approve permission (Permission Approval) or switch to a dedicated tool.';
  }
  return misuse
    ? `No approval channel is available in this session: use the dedicated tool "${misuse.tool}" instead of waiting for approval (${misuse.reason}).`
    : 'No approval channel is available in this session: switch to an allowlisted command or a dedicated tool instead of waiting for approval.';
}

/**
 * Item 9: merge double denials. When no approval channel exists, a permission
 * denial is not a second verdict — fall through to the single
 * COMMAND_NOT_ALLOWED below. User rejections, read-only mode, and unexpected
 * errors still return immediately with their own codes.
 */
export function shouldReturnPermissionDenial(
  permissionManager: any,
  permCheck: { allowed?: boolean; deniedByUser?: boolean; errorCode?: string },
): boolean {
  if (permCheck.allowed) return false;
  if (hasApprovalChannel(permissionManager)) return true;
  if (permCheck.deniedByUser === true) return true;
  try {
    if (typeof permissionManager?.getMode === 'function' && permissionManager.getMode() === 'read_only') return true;
  } catch {
    return true;
  }
  return permCheck.errorCode === 'PERMISSION_ERROR';
}

/**
 * Chốt policy Git duy nhất cho `run_command` (thay thế các tool `git_*` chuyên dụng
 * đã gỡ đăng ký): mọi phân đoạn chứa `git ...` đều phải qua cùng kiểm tra
 * `validateGitCommandScope` + `isGitCommandAuthorized` + ràng buộc nhánh push.
 * Từ chối cứng, không thể bypass bằng approval chung.
 */
export function checkGitPolicyForShell(
  segments: string[],
  workspaceRoot: string,
  userRequest?: string,
  approvalAvailable = true,
): GitShellPolicyViolation | undefined {
  for (const segment of segments) {
    const invocation = parseGitInvocation(segment);
    if (!invocation) continue;
    if (['clone', 'fetch', 'pull', 'ls-remote'].includes(invocation.subcommand)) {
      for (const arg of invocation.args) {
        if (!/^https?:\/\//i.test(arg)) continue;
        let remote: URL;
        try { remote = new URL(arg); } catch { continue; }
        if (remote.hostname.toLowerCase() === 'github.com' && (remote.username || remote.password || remote.search || remote.hash)) {
          return {
            error: 'GitHub remote URLs must not contain credentials, query parameters, or fragments.',
            errorCode: 'GIT_CREDENTIAL_IN_URL',
            suggestion: 'Use a clean HTTPS GitHub URL and sign in to Git Credential Manager on the host.',
          };
        }
      }
    }
    const scopeDecision = validateGitCommandScope(invocation.subcommand, invocation.args, workspaceRoot, workspaceRoot);
    if (!scopeDecision.allowed) {
      return { error: scopeDecision.error, errorCode: scopeDecision.errorCode };
    }
    const classification = classifyGitCommand(invocation.subcommand, invocation.args);
    if (invocation.subcommand === 'add' && !isExplicitGitAddPathList(invocation.args)) {
      if (!isBroadAddWithCommitIntent(invocation.args, userRequest)) {
        return {
          error: 'Broad Git staging is blocked. Use `git add -- <explicit workspace-relative file paths>`; -A/--all, ., wildcard, and pathspec staging are never authorized by a commit request.',
          errorCode: 'GIT_BROAD_STAGING_NOT_AUTHORIZED',
          suggestion: 'Inspect git status/diff, then stage only the changed file paths that belong in the requested commit.',
        };
      }
    }
    if (!isGitCommandAuthorized(userRequest, invocation.subcommand, classification, invocation.args)) {
      return {
        error: `Git ${invocation.subcommand} (${classification.risk}) is not authorized by the current user request.`,
        errorCode: classification.risk === 'destructive'
          ? 'GIT_DESTRUCTIVE_OPERATION_NOT_AUTHORIZED'
          : 'GIT_OPERATION_NOT_AUTHORIZED',
        suggestion: approvalAvailable
          ? `Ask the user to explicitly request git ${invocation.subcommand}${classification.risk === 'destructive' ? ' and its destructive behavior' : ''}.`
          : `No approval channel is available in this session: re-run with arguments matching the current task intent, or use an allowlisted read-only git command (status/diff/log).`,
      };
    }
    if (invocation.subcommand === 'push') {
      const requestedBranch = extractRequestedGitBranch(userRequest);
      if (requestedBranch && !pushArgsTargetBranch(invocation.args, requestedBranch)) {
        return {
          error: `Push arguments do not target the user-requested branch "${requestedBranch}".`,
          errorCode: 'GIT_BRANCH_NOT_AUTHORIZED',
          requestedBranch,
          suggestion: `Push to "${requestedBranch}" instead (e.g. git push origin ${requestedBranch}), or restate the request with the intended branch.`,
        };
      }
    }
  }
  return undefined;
}

/** All Git commands use argv-based Git tools so aliases/shell text cannot bypass policy. */
export function findGitSubcommand(command: string): string | undefined {
  const invocations = command.toLowerCase().matchAll(/\bgit(?:\.exe)?\b([^;&|\n]*)/g);
  for (const invocation of invocations) {
    const tokens = (String(invocation[1] || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
      .map((token) => token.replace(/^["']|["']$/g, ''));
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=') || token.startsWith('--namespace=')) {
        index++;
        continue;
      }
      if (token.startsWith('-')) {
        index++;
        continue;
      }
      return token;
    }
  }
  return undefined;
}

export interface FileMisuseDetection {
  tool: string;
  reason: string;
  suggestedArgs?: Record<string, any>;
}

/** Phát hiện hành vi dùng nhầm run_command để đọc file / duyệt thư mục / tìm kiếm */
export function detectFileCommandMisuse(command: string): FileMisuseDetection | undefined {
  const trimmed = command.trim();

  // 1.1. Đọc cắt đoạn file qua sed -n 'start,endp' filePath
  const sedSliceMatch = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (sedSliceMatch) {
    const startLine = parseInt(sedSliceMatch[1], 10);
    const endLine = sedSliceMatch[2] ? parseInt(sedSliceMatch[2], 10) : startLine;
    const filePath = sedSliceMatch[3].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Read a file by exact line range (no permission round-trip, provides contentHash) instead of slicing with sed',
      suggestedArgs: { path: filePath, startLine, endLine },
    };
  }

  // 1.2. Đọc file qua shell (cat, type, Get-Content, gc, head, tail, more, less, sed)
  const readMatch = trimmed.match(/^(?:cat|type|Get-Content|gc|head|tail|more|less)\s+([^\s;&|]+)/i);
  if (readMatch) {
    const filePath = readMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Read file content with hashing and token safety',
      suggestedArgs: { path: filePath },
    };
  }

  // 1.3. Trích xuất text hoặc code qua awk
  const awkMatch = trimmed.match(/^awk\s+.*?((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (awkMatch && !trimmed.includes('|')) {
    const filePath = awkMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Read file content or extract symbols with read_file (symbol) / inspect_symbol',
      suggestedArgs: { path: filePath },
    };
  }

  // 2. Duyệt file/thư mục qua shell (ls, dir, tree, Get-ChildItem, gci)
  const listMatch = trimmed.match(/^(?:ls|dir|tree|Get-ChildItem|gci)(?:\s+(?:-[a-zA-Z0-9/]+\s*)*)?(?:\s+([^\s;&|]+))?$/i);
  if (listMatch) {
    const rawTarget = (listMatch[1] || '').replace(/^["']|["']$/g, '');
    const dirPath = rawTarget && !rawTarget.startsWith('-') && !rawTarget.startsWith('/') ? rawTarget : undefined;
    return {
      tool: 'list_files',
      reason: 'List directory structure with automatic node_modules/.git filtering',
      suggestedArgs: dirPath ? { dirPath } : {},
    };
  }

  // 3. Tìm kiếm chuỗi qua shell (grep, findstr, Select-String, sls)
  const grepMatch = trimmed.match(/^(?:grep|findstr|Select-String|sls)\s+(?:-[a-zA-Z0-9-]+\s+)*['"]?([^'"]+)['"]?/i);
  if (grepMatch) {
    const query = grepMatch[1];
    return {
      tool: 'search_codebase_fast',
      reason: 'Fast BM25 search across the whole codebase at no token cost',
      suggestedArgs: { query },
    };
  }

  // 4. Xóa file / thư mục qua shell (rm, del, erase, rmdir, rd, Remove-Item, ri)
  if (/^(?:rm|del|erase|rmdir|rd|Remove-Item|ri)\b/i.test(trimmed) && !/[;&|]/.test(trimmed)) {
    const parsed = parseRmCommand(trimmed);
    const targetPath = parsed?.targetPaths?.[0];
    return {
      tool: 'delete_file',
      reason: 'Delete files/directories safely via Node.js I/O (hash checks, isProtectedFile, cross-platform) instead of shell commands missing on Windows or costing approval',
      suggestedArgs: targetPath ? { path: targetPath, reason: 'Clean up files with the dedicated tool' } : undefined,
    };
  }

  // 5. Di chuyển / đổi tên file qua shell (mv, move, Move-Item, mi)
  const mvMatch = trimmed.match(/^(?:mv|move|Move-Item|mi)\s+(?:-[a-zA-Z0-9-]+\s+)*((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (mvMatch && !/[;&|]/.test(trimmed)) {
    const sourcePath = mvMatch[1].replace(/^["']|["']$/g, '');
    const targetPath = mvMatch[2].replace(/^["']|["']$/g, '');
    return {
      tool: 'move_file',
      reason: 'Move or rename files safely in the workspace (prevents accidental overwrites)',
      suggestedArgs: { sourcePath, targetPath },
    };
  }

  // 6. Tạo file rỗng qua shell (touch, New-Item, ni)
  const touchMatch = trimmed.match(/^(?:touch|New-Item|ni)\s+(?:-[a-zA-Z0-9-]+\s+)*((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (touchMatch && !/[;&|]/.test(trimmed)) {
    const filePath = touchMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'create_file',
      reason: 'Create new files safely in the workspace without depending on POSIX shell binaries',
      suggestedArgs: { path: filePath, content: '' },
    };
  }

  return undefined;
}

export interface CatParsedOptions {
  filePath: string;
  headLines?: number;
  tailLines?: number;
}

/**
 * Phân tích cú pháp lệnh đọc file nhanh qua shell (cat, type, head, tail)
 */
export function parseCatCommand(command: string): CatParsedOptions | null {
  const trimmed = command.trim();
  if (/[;&|]/.test(trimmed)) return null;

  const headMatch = trimmed.match(/^head(?:\s+-n\s+(\d+))?\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (headMatch) {
    const lines = headMatch[1] ? parseInt(headMatch[1], 10) : 20;
    return {
      filePath: headMatch[2].replace(/^["']|["']$/g, ''),
      headLines: lines,
    };
  }

  const tailMatch = trimmed.match(/^tail(?:\s+-n\s+(\d+))?\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (tailMatch) {
    const lines = tailMatch[1] ? parseInt(tailMatch[1], 10) : 20;
    return {
      filePath: tailMatch[2].replace(/^["']|["']$/g, ''),
      tailLines: lines,
    };
  }

  const catMatch = trimmed.match(/^(?:cat|type)\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (catMatch) {
    return {
      filePath: catMatch[1].replace(/^["']|["']$/g, ''),
    };
  }

  return null;
}

/**
 * Giả lập thực thi cat/type/head/tail siêu tốc qua Node.js I/O (<2ms)
 * Tránh lỗi 'cat is not recognized' trên Windows cmd.exe và tiết kiệm nguyên 1 turn lỗi cho LLM.
 */
export async function executeCatEmulation(
  parsed: CatParsedOptions,
  workspace: Workspace,
): Promise<{ stdout: string; stderr: string; success: boolean; durationMs: number; exitCode: number; emulated: boolean; suggestion: string }> {
  const startTime = Date.now();
  try {
    const safePath = workspace.resolveSafePath(parsed.filePath);
    const content = await fs.readFile(safePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    let selectedLines = lines;
    if (parsed.headLines) {
      selectedLines = lines.slice(0, parsed.headLines);
    } else if (parsed.tailLines) {
      selectedLines = lines.slice(-parsed.tailLines);
    }
    const stdout = truncateOutput(selectedLines.join('\n'));
    return {
      stdout,
      stderr: '',
      success: true,
      durationMs: Date.now() - startTime,
      exitCode: 0,
      emulated: true,
      suggestion: 'Tip: for speed and token efficiency, use the read_file tool directly with path, startLine, endLine or symbol.',
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: `cat: cannot read file '${parsed.filePath}': ${err.message}`,
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
      emulated: true,
      suggestion: 'Check the file path again or use the dedicated "read_file" tool.',
    };
  }
}

export interface LsParsedOptions {
  targetPath: string;
  all: boolean;
  long: boolean;
}

/**
 * Phân tích cú pháp lệnh duyệt thư mục (ls, dir)
 */
export function parseLsCommand(command: string): LsParsedOptions | null {
  const trimmed = command.trim();
  if (/[;&|]/.test(trimmed)) return null;

  const prefixMatch = trimmed.match(/^(?:ls|dir)\b/i);
  if (!prefixMatch) return null;

  const rawArgs = trimmed.slice(prefixMatch[0].length).trim();
  const tokens = (rawArgs.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.trim());

  let all = false;
  let long = false;
  let targetPath = '.';

  if (prefixMatch[0].toLowerCase() === 'dir') {
    long = true;
  }

  for (const token of tokens) {
    if (token.startsWith('-') || token.startsWith('/')) {
      const lower = token.toLowerCase();
      if (lower.includes('a')) all = true;
      if (lower.includes('l')) long = true;
    } else {
      targetPath = token.replace(/^["']|["']$/g, '');
    }
  }

  if (tokens.length === 0 || tokens.some((t) => t.startsWith('-') && t.includes('l'))) {
    long = true;
  }

  return {
    targetPath,
    all,
    long,
  };
}

/**
 * Giả lập thực thi ls/dir siêu tốc qua Node.js I/O (<2ms)
 * Tránh lỗi 'ls is not recognized' trên Windows cmd.exe và hoạt động nhất quán đa nền tảng.
 */
export async function executeLsEmulation(
  parsed: LsParsedOptions,
  workspace: Workspace,
): Promise<{ stdout: string; stderr: string; success: boolean; durationMs: number; exitCode: number; emulated: boolean; suggestion?: string }> {
  const startTime = Date.now();
  try {
    const safePath = workspace.resolveSafePath(parsed.targetPath);
    const stat = await fs.stat(safePath);
    if (!stat.isDirectory()) {
      return {
        stdout: '',
        stderr: `ls: cannot access '${parsed.targetPath}': Not a directory`,
        success: false,
        durationMs: Date.now() - startTime,
        exitCode: 1,
        emulated: true,
        suggestion: 'The specified path is a file, not a directory.',
      };
    }

    const dirents = await fs.readdir(safePath, { withFileTypes: true });

    // Sắp xếp thư mục trước, sau đó theo alphabet A-Z
    dirents.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = [];
    for (const d of dirents) {
      if (!parsed.all && d.name.startsWith('.')) continue;

      const isDir = d.isDirectory();
      const typeChar = isDir ? 'd' : '-';
      const perms = isDir ? 'rwxr-xr-x' : 'rw-r--r--';

      let sizeStr = '       0';
      let dateStr = '                ';
      try {
        const itemStat = await fs.stat(path.join(safePath, d.name));
        sizeStr = String(itemStat.size).padStart(8, ' ');
        dateStr = itemStat.mtime.toISOString().slice(0, 16).replace('T', ' ');
      } catch {
        // Bỏ qua lỗi permission denied cho file con
      }

      if (parsed.long) {
        lines.push(`${typeChar}${perms}  ${sizeStr}  ${dateStr}  ${d.name}${isDir ? '/' : ''}`);
      } else {
        lines.push(`${d.name}${isDir ? '/' : ''}`);
      }
    }

    const MAX_LS_ITEMS = 50;
    const totalCount = lines.length;
    const isCapped = totalCount > MAX_LS_ITEMS;
    const displayLines = isCapped ? lines.slice(0, MAX_LS_ITEMS) : lines;
    if (isCapped) {
      displayLines.push(
        `... [Trimmed ${totalCount - MAX_LS_ITEMS} entries to protect the context window. Use the "list_files" tool to browse the filtered directory tree and save tokens]`,
      );
    }

    const header = `total ${totalCount} items in ${parsed.targetPath}`;
    const output = [header, ...displayLines].join('\n');

    return {
      stdout: truncateOutput(output),
      stderr: '',
      success: true,
      durationMs: Date.now() - startTime,
      exitCode: 0,
      emulated: true,
      suggestion: isCapped
        ? 'Directory has many entries. For token efficiency and standard structure management, use the "list_files" tool.'
        : 'Tip: for token efficiency and standard directory-tree management, use the dedicated "list_files" tool.',
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: `ls: cannot access '${parsed.targetPath}': ${err.message}`,
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
      emulated: true,
      suggestion: 'Check the directory path again or use the "list_files" tool.',
    };
  }
}

export interface SedSliceOptions {
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Phân tích cú pháp lệnh sed cắt dòng (ví dụ: sed -n '2228,2280p' server.js)
 */
export function parseSedSliceCommand(command: string): SedSliceOptions | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (!match) return null;
  const startLine = parseInt(match[1], 10);
  const endLine = match[2] ? parseInt(match[2], 10) : startLine;
  const filePath = match[3].replace(/^["']|["']$/g, '');
  return {
    filePath,
    startLine,
    endLine,
  };
}

/**
 * Giả lập thực thi sed cắt dòng siêu tốc qua Node.js I/O (tránh độ trễ 3-13s khi spawn shell trên Windows)
 */
export async function executeSedSliceEmulation(
  parsed: SedSliceOptions,
  workspace: Workspace,
): Promise<{ stdout: string; success: boolean; durationMs: number; exitCode: number }> {
  const startTime = Date.now();
  try {
    const safePath = workspace.resolveSafePath(parsed.filePath);
    const content = await fs.readFile(safePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const s = Math.max(1, parsed.startLine);
    const e = Math.min(lines.length, parsed.endLine);
    const selected = lines.slice(s - 1, e);
    return {
      stdout: selected.join('\n'),
      success: true,
      durationMs: Date.now() - startTime,
      exitCode: 0,
    };
  } catch {
    return {
      stdout: '',
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
    };
  }
}

export interface RmParsedOptions {
  targetPaths: string[];
  recursive: boolean;
  force: boolean;
}

/**
 * Phân tích cú pháp lệnh xóa file/thư mục qua shell (rm, del, erase, rmdir, rd, Remove-Item, ri)
 */
export function parseRmCommand(command: string): RmParsedOptions | null {
  const trimmed = command.trim();
  const prefixMatch = trimmed.match(/^(rm|del|erase|rmdir|rd|Remove-Item|ri)\b/i);
  if (!prefixMatch) return null;

  // Lệnh phức tạp có pipe/chaining không xử lý qua emulator đơn
  if (/[;&|]/.test(trimmed)) return null;

  const rawArgs = trimmed.slice(prefixMatch[0].length).trim();
  if (!rawArgs) return null;

  const tokens = (rawArgs.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.trim());
  if (tokens.length === 0) return null;

  let recursive = false;
  let force = false;
  const pathTokens: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === '-r' || lower === '-rf' || lower === '-fr' || lower === '--recursive' || lower === '/s') {
      recursive = true;
      if (lower.includes('f')) force = true;
    } else if (lower === '-f' || lower === '--force' || lower === '/f' || lower === '/q') {
      force = true;
    } else if (lower === '-recurse') {
      recursive = true;
    } else if (lower === '-force') {
      force = true;
    } else if (token.startsWith('-') || token.startsWith('/')) {
      if (/r/i.test(token)) recursive = true;
      if (/f|q/i.test(token)) force = true;
    } else {
      pathTokens.push(token.replace(/^["']|["']$/g, ''));
    }
  }

  if (/^(rmdir|rd)$/i.test(prefixMatch[1])) {
    recursive = true;
  }

  if (pathTokens.length === 0) return null;

  return {
    targetPaths: pathTokens,
    recursive,
    force,
  };
}

/**
 * Giả lập thực thi rm/del siêu tốc qua Node.js I/O (<5ms)
 * Đảm bảo an toàn:
 * 1. Không vượt ra ngoài workspace (resolveSafePath)
 * 2. Bảo vệ file cấu hình hệ thống nhạy cảm (workspace.isProtectedFile)
 * 3. Tương thích chéo đa nền tảng (không phụ thuộc rm.exe hay cmd.exe trên Windows)
 */
export async function executeRmEmulation(
  parsed: RmParsedOptions,
  workspace: Workspace,
): Promise<{ stdout: string; stderr: string; success: boolean; durationMs: number; exitCode: number; suggestion?: string }> {
  const startTime = Date.now();
  const deletedPaths: string[] = [];
  try {
    for (const targetPath of parsed.targetPaths) {
      const safePath = workspace.resolveSafePath(targetPath);
      if (workspace.isProtectedFile(safePath)) {
        return {
          stdout: deletedPaths.length > 0 ? `Deleted: ${deletedPaths.join(', ')}` : '',
          stderr: `Security violation: deleting sensitive configuration or protected files "${targetPath}" is not allowed.`,
          success: false,
          durationMs: Date.now() - startTime,
          exitCode: 1,
          suggestion: 'This file is in the workspace system-protection list and cannot be deleted.',
        };
      }

      try {
        await fs.access(safePath);
      } catch {
        if (!parsed.force) {
          return {
            stdout: deletedPaths.length > 0 ? `Deleted: ${deletedPaths.join(', ')}` : '',
            stderr: `rm: cannot remove '${targetPath}': No such file or directory`,
            success: false,
            durationMs: Date.now() - startTime,
            exitCode: 1,
            suggestion: 'Check the file path again or use the dedicated "delete_file" tool.',
          };
        }
        continue;
      }

      await fs.rm(safePath, { recursive: parsed.recursive, force: parsed.force });
      deletedPaths.push(targetPath);
    }

    const count = deletedPaths.length;
    return {
      stdout: count > 0
        ? `Deleted ${count} item(s) (${deletedPaths.join(', ')}) safely via RmEmulation (${Date.now() - startTime}ms).`
        : '',
      stderr: '',
      success: true,
      durationMs: Date.now() - startTime,
      exitCode: 0,
      suggestion: 'Tip: use the dedicated "delete_file" tool directly (cross-platform, hash-safe, <2ms) for optimization.',
    };
  } catch (err: any) {
    return {
      stdout: deletedPaths.length > 0 ? `Deleted: ${deletedPaths.join(', ')}` : '',
      stderr: `rm: failed to remove: ${err.message}`,
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
    };
  }
}

/**
 * Resolve the effective synchronous timeout for run_command.
 * Convention: timeout_ms === 0 disables the timeout entirely (long Playwright/
 * browser/E2E scripts); any other finite value is clamped to [1000, 300000].
 * The abort signal and output truncation still apply when disabled.
 */
export function resolveRunCommandTimeout(requestedMs: unknown, configuredDefaultMs: unknown): number {
  const requested = Number(requestedMs);
  if (requested === 0) return 0;
  const configured = Number(configuredDefaultMs);
  const defaultTimeout = Number.isFinite(configured) && configured > 0 ? configured : 120000;
  return Math.min(
    300000,
    Math.max(1000, Number.isFinite(requested) && requested > 0 ? requested : defaultTimeout),
  );
}
/**
 * Tạo Tool run_command có tích hợp SandboxManager và TaskManager (Chuẩn Antigravity CLI Unified Command Execution)
 */
export function createRunCommandTool(sandboxManager?: SandboxManager, taskManager?: TaskManager, permissionManager?: any): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Run terminal commands for builds, tests, linting, scripts, and Git. Use execution_target="auto" by default: it prefers the isolated Internal (sandbox) environment when available. This does not guarantee every command runs in the sandbox; guardrails may reject commands that require isolation (ISOLATED_SANDBOX_REQUIRED) rather than silently running them on the Host. Choose execution_target="host" (External, the user\'s host machine) only when a host-native toolchain/dependency is needed or the sandbox is incompatible. For private GitHub clone/fetch, explicitly use host so Git can access the host Git Credential Manager; sign in to GCM separately. Public Git operations can use auto. Host commands remain subject to host policy, the allowlist, and approval; policy may still reject a command after approval. Allowlist groups (no approval): explore cat/type/head/tail/ls/dir/grep/rg/find/jq, build/test npm/node/npx/bun/python/pytest/dotnet/go/cargo/tsc/eslint/jest/vitest, git read/write subcommands, docker ps/images. For short dependent command chains, use `&&`; use `||` only for intentional fallback and `|` for bounded-output pipelines (exactly two allowlisted segments, no redirect/substitution, skips approval). Avoid unrelated command chains, shell grouping/subshells, and command substitution; complex shell syntax and commands outside the allowlist may require approval. Single cat/ls/sed/rg/rm calls are auto-emulated via Node.js I/O (<5ms); missing binaries fail fast with a fallback/install hint and auto-provision when a recipe exists. Output is sanitized, test-distilled, truncated (~8000 chars, stderr ~4000) with the full log offloaded to logFilePath: always check exitCode/success/commandOutcome plus logFilePath and verificationOutputComplete before concluding. Use `timeout_ms` for finite long-running commands; run servers/watchers/daemons with `WaitMsBeforeAsync` and monitor them with `manage_task` (explicit long timeouts auto-promote to background after ~10s soft-timeout). Shell cwd/env persists across calls (cd/export stick); repo .minus/hooks.json may add denials; secrets are scrubbed/redacted; idle background tasks emit a one-shot stall notice. Sensitive operations such as Git mutations must match the user\'s direct request; stage only explicit paths; pushes to main/master require approval and remain subject to Git policy. System-destructive commands are prohibited even with approval. Do not read, write, delete, move, or rename workspace files through the shell: use dedicated file tools (`list_files`, `search_text`, `search_codebase_fast`, `read_file`, `write_file`, `delete_file`, `move_file`). Use move_file with sourcePath and targetPath for moves. Never include secrets or tokens in commands.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Use for build, test, lint, script, and Git commands. Default to `auto` (prefers the isolated Internal/sandbox environment when available). For a private GitHub clone/fetch, choose `execution_target: "host"` (External) to use the host Git Credential Manager; public Git can use auto. Never put credentials in Git URLs or commands. Host commands remain subject to host policy, the allowlist, and approval. The runtime enforces the allowlist (explore/build/test/git/docker-read groups); this schema lists groups, not every binary. Commands outside the allowlist may require approval and can still be rejected by policy. Prefer dedicated tools (`list_files`, `search_text`, `search_codebase_fast`, `read_file`) to browse, search, and read files; do not use the shell to read, write, delete, move, or rename workspace files; never use shell `mv`, use move_file with sourcePath and targetPath. cat/ls/sed/rg/rm single calls are auto-emulated (<5ms) so they work cross-platform, but dedicated tools save tokens. Use one command or a short dependent chain with `&&`; use `||` only for intentional fallback and bounded-output `|` pipelines (two allowlisted segments only). Avoid unrelated chains, subshells/grouping, and `$()`; interactive REPL/vim and complex commands may require approval or are blocked by preflight. Large output is truncated with logFilePath: read it via read_file instead of re-running. Use `timeout_ms` for finite long-running builds/tests, and `WaitMsBeforeAsync` with `manage_task` for servers/watchers. Git mutations require direct user intent; stage only explicit paths (`git add -- <paths>`, never -A/./wildcards unless the request is an explicit commit); pushes to main/master require approval; system-destructive commands are prohibited.',
        },
        CommandLine: {
          type: Type.STRING,
          description: 'Standard Antigravity alias for the terminal command to execute. Equivalent to `command`; if both are set, `command` wins.',
        },
        WaitMsBeforeAsync: {
          type: Type.INTEGER,
          description: 'Wait time before moving the command to a background task (max 10000ms). Must use a value >0 (usually 5000) for long-running servers/watchers/daemons; then use `manage_task` to view logs or stop the task. May be auto-set (~10s) for explicit long jobs (timeout_ms=0|>120s) when omitted. Do not use this parameter as a timeout substitute for finite builds/tests. Background tasks run on the host process manager: they cannot preserve Docker isolation (BACKGROUND_ISOLATION_UNSUPPORTED) and network Git (fetch/pull/clone) cannot go background.',
        },
        timeout_ms: {
          type: Type.NUMBER,
          description: 'Timeout for synchronous commands in milliseconds (default 120000; min 1000, max 300000). Set timeout_ms=0 to DISABLE the timeout for commands needing more time (long Playwright/E2E); abort signal and output truncation still apply. Continuously running servers must use WaitMsBeforeAsync instead of disabling the timeout. Values are clamped to [1000, 300000] unless 0.',
        },
        execution_target: {
          type: Type.STRING,
          description: 'Execution target: "auto" (default; prefers the isolated Internal/sandbox environment when available, but does not guarantee the sandbox is available; guardrails may reject commands requiring isolation instead of silently running them on the Host) or "host" (External; the host operating system). Choose "host" only when a host-native toolchain/dependency is needed or the sandbox is incompatible. Host policy always applies: allowlisted commands may run without approval, commands outside the allowlist may require approval, and approval does not override policy prohibitions.',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext): Promise<Record<string, any>> {
      const rawCommand = String(args.command || args.CommandLine || args.commandLine || args.cmd || '').trim();
      let hasExplicitPermission = context?.permissionGranted === true;
      const effectivePermissionManager = context?.permissionManager || permissionManager;
      const executionTarget = String(args.execution_target || 'auto').trim().toLowerCase();
      const timeoutMs = resolveRunCommandTimeout(args.timeout_ms, process.env.RUN_COMMAND_TIMEOUT_MS || 120000);

      if (!rawCommand) {
        return { error: 'The "command" or "CommandLine" parameter is required.' };
      }
      if (!['auto', 'host'].includes(executionTarget)) {
        return {
          command: rawCommand,
          error: 'execution_target only accepts "auto" or "host".',
          errorCode: 'INVALID_EXECUTION_TARGET',
        };
      }

      // Reject credential-bearing GitHub URLs before any guard can echo the command to logs/results.
      for (const match of rawCommand.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        try {
          const url = new URL(match[0]);
          if (url.hostname.toLowerCase() === 'github.com' && (url.username || url.password || url.search || url.hash)) {
            return { error: 'GitHub URLs in commands must not include credentials or query parameters.', errorCode: 'GIT_CREDENTIAL_IN_URL' };
          }
        } catch { /* Other URL errors remain the responsibility of the command preflight. */ }
      }

      // Xử lý WaitMsBeforeAsync (Antigravity CLI Async Dispatch)
      const waitMsBeforeAsync = typeof args.WaitMsBeforeAsync === 'number'
        ? Math.min(10000, Math.max(0, args.WaitMsBeforeAsync))
        : (typeof args.wait_ms_before_async === 'number' ? Math.min(10000, Math.max(0, args.wait_ms_before_async)) : undefined);

      // Pre-flight Guardrail: Chặn lệnh interactive (REPL, vim), dev server thiếu wait, lặp test vô ích, chuẩn hóa Windows, và chặn binary không tồn tại
      const preflight = evaluateCommandPreflight(rawCommand, {
        waitMsBeforeAsync,
        lastExecution: (context as any)?.lastCommandExecution,
        workspaceRoot: workspace.rootDir,
      });

      if (!preflight.allowed) {
        return {
          command: rawCommand,
          message: preflight.reason || 'Command blocked by the Pre-flight Guardrail.',
          preflightCode: preflight.errorCode || 'PREFLIGHT_GUARD_REJECTED',
          suggestion: preflight.suggestion,
          commandOutcome: 'blocked_preflight',
          processStarted: false,
          success: false,
          durationMs: 1,
        };
      }

      const effectiveCommand = preflight.normalizedCommand || rawCommand;

      // Repo hooks (.minus/hooks.json): opt-in deny/warn rules, evaluated early.
      const hookVerdict = evaluateCommandHooks(effectiveCommand, workspace.rootDir);
      if (!hookVerdict.allowed) {
        return {
          command: effectiveCommand,
          message: hookVerdict.message || 'Blocked by repo hook.',
          preflightCode: hookVerdict.errorCode || 'HOOK_DENIED',
          suggestion: hookVerdict.suggestion,
          commandOutcome: 'blocked_preflight',
          processStarted: false,
          success: false,
          durationMs: 1,
        };
      }

      // Persistent shell: bare `cd <dir>` sticks for later calls (no spawn).
      const cdTarget = tryHandleCdCommand(effectiveCommand, workspace);
      if (cdTarget) {
        trackSessionEnv(workspace.rootDir, preflight.extractedEnv);
        return {
          command: effectiveCommand,
          stdout: cdTarget,
          stderr: '',
          exitCode: 0,
          durationMs: 1,
          success: true,
          commandOutcome: 'succeeded',
          processStarted: false,
          persistentCwd: workspace.toRelativePath
            ? workspace.toRelativePath(cdTarget)
            : cdTarget,
        };
      }

      // Persistent shell env: export/$env prefixes accumulate across calls.
      const sessionEnv = trackSessionEnv(workspace.rootDir, preflight.extractedEnv);
      const hookAdvisory = hookVerdict.advisory;
      const preflightAdvisories: string[] = [];
      if (hookAdvisory) preflightAdvisories.push(hookAdvisory);

      // Enforce non-bypassable host system-risk policy before emulation or any
      // other dispatch route, not only immediately before native host spawn.
      const hostPolicy = executionTarget === 'host'
        ? evaluateHostCommandPolicy(effectiveCommand, workspace.rootDir)
        : { allowed: true as const };
      if (!hostPolicy.allowed) {
        return {
          command: effectiveCommand,
          message: hostPolicy.reason,
          preflightCode: hostPolicy.errorCode,
          commandOutcome: 'blocked_preflight',
          processStarted: false,
          success: false,
          durationMs: 1,
        };
      }

      // Parse and authorize the entire command before any synchronous or background dispatch.
      const shellAnalysis = analyzeShellCommand(effectiveCommand);
      const networkGitCommand = shellAnalysis.segments.some((segment) => {
        const invocation = parseGitInvocation(segment);
        return Boolean(invocation && classifyGitCommand(invocation.subcommand, invocation.args).risk === 'network');
      });

      // Do not silently downgrade a mutating or otherwise non-read-only command
      // from Docker to the host. An explicit host target still goes through approval.
      if (executionTarget === 'auto' && sandboxManager) {
        const sandboxStatus = sandboxManager.getStatus();
        if (mustBlockUnisolatedAutoExecution(effectiveCommand, sandboxStatus)) {
          return {
            command: effectiveCommand,
            error: 'Docker isolation is unavailable; this command is not classified as read-only, so it requires an isolated execution environment and will not silently fall back to the host.',
            errorCode: 'ISOLATED_SANDBOX_REQUIRED',
            message: 'Docker isolation is unavailable; this command is not classified as read-only, so it requires an isolated execution environment and will not silently fall back to the host.',
            preflightCode: 'ISOLATED_SANDBOX_REQUIRED',
            suggestion: 'The command itself was not judged dangerous. Restore Docker, or explicitly retry with execution_target: "host" (host policy, the allowlist, and approval still apply).',
            commandOutcome: 'blocked_preflight',
            processStarted: false,
            success: false,
            durationMs: 1,
          };
        }
      }

      // Kiểm tra User Rule 2: Chặn tự động push lên main/master để bảo vệ CI/CD Railway
      const blockedPushToMain = isBlockedGitPushToMain(effectiveCommand);

      // Bounded allowlisted pipelines (e.g. `npm test | head -n 20`, `git log --oneline | head -n 5`)
      // skip interactive approval and are not rejected as complex grouping.
      const isBoundedPipeline = isBoundedAllowlistedPipeline(shellAnalysis);
      const isComplex = Boolean(shellAnalysis.complex && !isBoundedPipeline);

      const SAFE_CHAIN_OPERATORS = new Set(['&&', '||', ';']);
      const hasDisallowedOperators = isBoundedPipeline
        ? false
        : shellAnalysis.operators.some((operator) => !SAFE_CHAIN_OPERATORS.has(operator));

      // Kích hoạt Interactive Permission Approval nếu lệnh phức tạp, vi phạm push main, chứa toán tử không an toàn, hoặc chứa phân đoạn ngoài allowlist
      const needsApproval = Boolean(shellAnalysis.error)
        || isComplex
        || hasDisallowedOperators
        || blockedPushToMain
        || !shellAnalysis.segments.every(isAllowedCommand);

      const permArgs = { ...args, command: rawCommand, CommandLine: rawCommand };

      if (needsApproval && !hasExplicitPermission && effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
        const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
        if (permCheck.allowed) {
          hasExplicitPermission = true;
          if (context) context.permissionGranted = true;
        } else if (shouldReturnPermissionDenial(effectivePermissionManager, permCheck)) {
          return {
            command: rawCommand,
            error: permCheck.reason || `Command "${rawCommand}" was rejected or has not been granted execution permission (PERMISSION APPROVAL).`,
            errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
            permissionRequestId: permCheck.permissionRequestId,
            ...(permCheck.deniedByUser ? { deniedByUser: true } : {}),
          };
        }
        // else: no approval channel — fall through to the single denial below.
      }

      if (shellAnalysis.error || (isComplex && !hasExplicitPermission)) {
        return {
          command: rawCommand,
          error: shellAnalysis.error || 'Complex shell grouping/substitution requires explicit permission.',
          errorCode: 'COMMAND_PARSE_REJECTED',
        };
      }
      if (blockedPushToMain && !hasExplicitPermission) {
        return {
          command: rawCommand,
          error: 'OPERATION BLOCKED (User Rule 2): Never automatically git push to main/master to avoid triggering the automatic Railway CI/CD system. Requires a direct user request.',
          errorCode: 'PUSH_TO_MAIN_PROHIBITED',
          suggestion: hasApprovalChannel(effectivePermissionManager)
            ? 'Pushing to main requires a direct user request naming main explicitly — approval alone does not authorize it. Ask the user to approve permission (Permission Approval) only if pushing to main is truly intended.'
            : 'Pushing to main requires a direct user request, and no approval channel is available in this session: retarget the push to the user-requested branch instead.',
        };
      }
      // Pre-spawn missing-binary probe: fail fast without spawning a shell
      // (e.g. `ruff` absent from PATH cost ~2s per attempt before this gate).
      // Skipped when Docker isolation owns PATH, or via MINUS_BINARY_PROBE=off.
      const probeIsolated = executionTarget !== 'host' && sandboxManager
        ? Boolean(sandboxManager.getStatus?.()?.isIsolated)
        : false;
      const probeDisabled = process.env.MINUS_BINARY_PROBE?.toLowerCase() === 'off';
      // Item 11: missing binaries with a recovery path (provision recipe or
      // known fallback) only warn and let execution proceed (observe) instead
      // of hard-blocking. Binaries with no recovery path still fail fast below.
      const binaryAdvisories: string[] = [];
      if (!probeDisabled && !probeIsolated) {
        for (const segment of shellAnalysis.segments) {
          const missing = probeMissingBinary(segment, { workspaceRoot: workspace.rootDir });
          if (missing) {
            // Auto-provision hook: nếu binary này có recipe và MINUS_AUTO_PROVISION !== 'off'
            const autoProvisionEnabled = process.env.MINUS_AUTO_PROVISION?.toLowerCase() !== 'off';
            if (autoProvisionEnabled && (missing as any).canAutoProvision) {
              const provisionRes = await ToolchainProvisioner.ensureToolchain(missing.name);
              if (provisionRes?.success) {
                clearBinaryProbeCache();
                continue;
              }
            }

            const devSuggestion = getDevToolSuggestion(missing.name);
            const fallback = devSuggestion?.fallback;
            if (!fallback && !(missing as any).canAutoProvision) {
              return {
                command: rawCommand,
                message: `Binary "${missing.name}" was not found on PATH in the execution environment.`,
                preflightCode: 'DEV_BINARY_NOT_FOUND',
                suggestion: devSuggestion?.install
                  ? `Install it (${devSuggestion.install}). Do not retry the bare "${missing.name}" command unchanged.`
                  : `Install "${missing.name}" or use an equivalent tool/approach. Do not retry the same command unchanged.`,
                commandOutcome: 'blocked_preflight',
                processStarted: false,
                success: false,
                durationMs: 1,
              };
            }
            binaryAdvisories.push(
              fallback
                ? `Pre-flight note: binary "${missing.name}" is not on PATH; prefer "${fallback} ..." but execution continues and may fail.`
                : `Pre-flight note: binary "${missing.name}" is not on PATH and auto-provisioning failed; execution continues and may fail.`,
            );
          }
        }
      }
      const binaryAdvisory = binaryAdvisories.length > 0 ? binaryAdvisories.join('\n') : undefined;
      const mergedAdvisory = [...preflightAdvisories, ...(binaryAdvisory ? [binaryAdvisory] : [])].join('\n') || undefined;
      const advisoryExtra = mergedAdvisory ? { preflightAdvisory: mergedAdvisory } : undefined;
      // Session-aware dispatch context: persistent cwd + accumulated env.
      const sessionCwd = resolveSessionCwd(workspace);
      const dispatchEnv = { ...sessionEnv };

      if (!shellAnalysis.segments.every(isAllowedCommand) && !hasExplicitPermission) {
        const deniedSegments = shellAnalysis.segments.filter((segment) => !isAllowedCommand(segment));
        const misuse = detectFileCommandMisuse(rawCommand);
        return {
          command: rawCommand,
          error: `Command "${rawCommand}" requires EXECUTION PERMISSION CONFIRMATION (PERMISSION APPROVAL) from the user. Non-allowlist segments: ${deniedSegments.join(', ')}`,
          errorCode: 'COMMAND_NOT_ALLOWED',
          deniedSegments,
          suggestion: approvalSuggestion(effectivePermissionManager, misuse),
        };
      }

      // Single Git policy gate (thay thế các tool git_* đã gỡ đăng ký): mọi phân
      // đoạn `git ...` vượt qua được các chốt trên đều phải qua thêm kiểm tra
      // scope/intent/branch. Đặt sau PUSH_TO_MAIN_PROHIBITED và allowlist để giữ
      // nguyên mã lỗi cũ; từ chối cứng, không bypass bằng approval chung.
      const gitPolicyViolation = checkGitPolicyForShell(shellAnalysis.segments, workspace.rootDir, context?.userRequest, hasApprovalChannel(effectivePermissionManager));
      if (gitPolicyViolation) {
        return {
          ...(gitPolicyViolation.errorCode === 'GIT_CREDENTIAL_IN_URL' ? {} : { command: rawCommand }),
          ...gitPolicyViolation,
        };
      }

      // Xử lý WaitMsBeforeAsync (Antigravity CLI Async Dispatch)
      // + soft-timeout→background: explicit long jobs (timeout_ms=0|>120s)
      // auto-promote after ~10s instead of blocking the turn.
      const effectiveWaitMs = resolveAutoBackgroundWait(waitMsBeforeAsync, timeoutMs, taskManager);
      const autoPromoted = effectiveWaitMs !== undefined
        && (waitMsBeforeAsync === undefined || waitMsBeforeAsync <= 0);
      if (effectiveWaitMs !== undefined && effectiveWaitMs > 0 && taskManager) {
        // BackgroundTask uses host `spawn(shell: true)`, not SandboxManager.
        // Never let auto silently bypass an available Docker isolation boundary.
        if (executionTarget === 'auto' && sandboxManager?.getStatus?.()?.isIsolated) {
          return {
            command: effectiveCommand,
            message: 'Background execution currently uses the host process manager and cannot preserve the selected Docker isolation boundary.',
            preflightCode: 'BACKGROUND_ISOLATION_UNSUPPORTED',
            suggestion: 'Run this finite command synchronously in the sandbox, or explicitly choose execution_target="host" if host execution is intended.',
            commandOutcome: 'blocked_preflight',
            processStarted: false,
            success: false,
            durationMs: 1,
          };
        }
        if (networkGitCommand) {
          return {
            error: 'Network Git commands cannot run as background tasks because they bypass the selected execution target.',
            errorCode: 'BACKGROUND_GIT_NETWORK_UNSUPPORTED',
          };
        }
        const bgTask = taskManager.startTask(effectiveCommand, sessionCwd, dispatchEnv);
        const startTime = Date.now();
        const deadline = startTime + effectiveWaitMs;

        while (Date.now() < deadline) {
          if (bgTask.status !== 'running') break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (bgTask.status !== 'running') {
          const passed = bgTask.status === 'stopped' && bgTask.exitCode === 0 && !bgTask.stopRequested;
          const terminalStatus = passed ? 'completed' : bgTask.stopRequested ? 'cancelled' : 'failed';
          const commandOutcome = passed ? 'succeeded' : 'failed_unexpected';
          return {
            command: rawCommand,
            exitCode: bgTask.exitCode ?? (bgTask.status === 'stopped' ? 0 : 1),
            stdout: truncateOutput(redactSecretsFromText(
              bgTask.logs.join('\n'),
              collectSecretsFromEnv({ ...(process.env as Record<string, string>), ...dispatchEnv }),
            )),
            stderr: '',
            durationMs: Date.now() - startTime,
            success: passed,
            processStarted: true,
            commandOutcome,
            commandCompletion: {
              taskId: bgTask.id,
              command: effectiveCommand,
              completed: true,
              terminalStatus,
              commandOutcome,
              ...(typeof bgTask.exitCode === 'number' ? { exitCode: bgTask.exitCode } : {}),
            },
            sandboxType: 'local',
          };
        }

        return {
          command: rawCommand,
          isBackgroundTask: true,
          taskId: bgTask.id,
          pid: bgTask.pid,
          status: 'running',
          message: autoPromoted
            ? `Long sync job auto-promoted to background after ~${Math.round(effectiveWaitMs / 1000)}s (soft-timeout) with task id: ${bgTask.id}`
            : `Tool is running as a background task with task id: ${bgTask.id}`,
          ...(autoPromoted ? { autoPromoted: true, softTimeoutMs: effectiveWaitMs } : {}),
          recentLogs: bgTask.logs.slice(-10),
          instruction: `Use the manage_task tool with TaskId="${bgTask.id}" to view status, send stdin (send_input), or kill.`,
        };
      }
      // Tự động tối ưu hoá lệnh cat/type/head/tail đọc file bằng Node.js I/O (<2ms)
      const parsedCat = parseCatCommand(effectiveCommand);
      if (parsedCat) {
        const emulatedCat = await executeCatEmulation(parsedCat, workspace);
        return {
          command: effectiveCommand,
          ...emulatedCat,
          sandbox: 'local',
          executionTarget,
        };
      }

      // Tự động tối ưu hoá sed cắt dòng (sed -n 'start,endp' file) bằng bộ giả lập siêu tốc Node.js (<5ms)
      const parsedSed = parseSedSliceCommand(effectiveCommand);
      if (parsedSed) {
        const emulatedSed = await executeSedSliceEmulation(parsedSed, workspace);
        if (emulatedSed.success) {
          return {
            command: effectiveCommand,
            stdout: truncateOutput(emulatedSed.stdout),
            stderr: '',
            exitCode: emulatedSed.exitCode,
            durationMs: emulatedSed.durationMs,
            sandbox: 'local',
            executionTarget,
            success: true,
            emulated: true,
            suggestion: 'Tip: for speed and token efficiency, use the read_file tool directly with path, startLine, endLine or symbol.',
          };
        }
      }

      // Tự động tối ưu hoá / giả lập lệnh xóa file (rm / del) siêu tốc qua Node.js I/O (<5ms)
      const parsedRm = parseRmCommand(effectiveCommand);
      if (parsedRm) {
        const emulatedRm = await executeRmEmulation(parsedRm, workspace);
        return {
          command: rawCommand,
          stdout: truncateOutput(emulatedRm.stdout),
          stderr: truncateOutput(emulatedRm.stderr),
          exitCode: emulatedRm.exitCode,
          durationMs: emulatedRm.durationMs,
          sandbox: 'local',
          executionTarget,
          success: emulatedRm.success,
          emulated: true,
          suggestion: emulatedRm.suggestion,
        };
      }

      // Tự động tối ưu hoá / giả lập lệnh duyệt thư mục (ls / dir) siêu tốc qua Node.js I/O (<2ms)
      const parsedLs = parseLsCommand(effectiveCommand);
      if (parsedLs) {
        const emulatedLs = await executeLsEmulation(parsedLs, workspace);
        return {
          command: effectiveCommand,
          ...emulatedLs,
          sandbox: 'local',
          executionTarget,
        };
      }

      if (executionTarget === 'host') {
        const isAllowedOnHost = isAllowedShellCommand(effectiveCommand) || isAllowedShellCommand(rawCommand);
        if (!isAllowedOnHost && !hasExplicitPermission) {
          if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
            const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
            if (permCheck.allowed) {
              hasExplicitPermission = true;
              if (context) context.permissionGranted = true;
            } else if (shouldReturnPermissionDenial(effectivePermissionManager, permCheck)) {
              return {
                command: rawCommand,
                error: permCheck.reason || `Command "${rawCommand}" was rejected for execution on Host.`,
                errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
                permissionRequestId: permCheck.permissionRequestId,
                ...(permCheck.deniedByUser ? { deniedByUser: true } : {}),
              };
            }
            // else: no approval channel — fall through to the single denial below.
          }
        }
        if (!isAllowedOnHost && !hasExplicitPermission) {
          const misuse = detectFileCommandMisuse(rawCommand);
          return {
            command: rawCommand,
            error: `Command "${rawCommand}" requires EXECUTION PERMISSION CONFIRMATION (PERMISSION APPROVAL) to run on Host.`,
            errorCode: 'COMMAND_NOT_ALLOWED',
            suggestion: approvalSuggestion(effectivePermissionManager, misuse),
          };
        }
        const hostSandbox = new LocalProcessSandbox(workspace.rootDir);
        await hostSandbox.init();
        let hostResult = await hostSandbox.exec(effectiveCommand, {
          cwd: sessionCwd,
          timeoutMs,
          signal: context?.signal,
          env: { ...dispatchEnv, ...(networkGitCommand ? { GCM_INTERACTIVE: 'never' } : {}) },
        });

        // Tự động Auto-Provision nếu native command thất bại do thiếu binary
        const autoProvisionEnabled = process.env.MINUS_AUTO_PROVISION?.toLowerCase() !== 'off';
        const isMissingOnHost = hostResult.exitCode === 127
          || hostResult.stderr.includes('not found')
          || hostResult.stderr.includes('not recognized');

        if (autoProvisionEnabled && isMissingOnHost) {
          const missingExec = findMissingExecutable(`${hostResult.stderr}\n${hostResult.stdout}`, hostResult.exitCode);
          if (missingExec && findRecipeForBinary(missingExec)) {
            const provisionRes = await ToolchainProvisioner.ensureToolchain(missingExec);
            if (provisionRes?.success) {
              clearBinaryProbeCache();
              // Thử lại lệnh sau khi nạp PATH
              const retryResult = await hostSandbox.exec(effectiveCommand, {
                cwd: sessionCwd,
                timeoutMs,
                signal: context?.signal,
                env: {
                  ...dispatchEnv,
                  ...(networkGitCommand ? { GCM_INTERACTIVE: 'never' } : {}),
                  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
                },
              });
              if (retryResult.exitCode === 0 || retryResult.success) {
                return annotateCommandResult(rawCommand, {
                  command: rawCommand,
                  ...retryResult,
                  autoProvisioned: {
                    toolchain: provisionRes.toolchain,
                    binDir: provisionRes.binDir,
                    version: provisionRes.version,
                  },
                  message: `[Auto-Provision]: Automatically downloaded and configured "${provisionRes.toolchain}" (${provisionRes.version || 'ready'}); the command was re-executed successfully.`,
                  sandbox: 'local',
                  executionTarget: 'host',
                });
              }
              hostResult = retryResult;
            }
          }
        }

        // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu binary không có sẵn trên Host
        const parsedSearch = parseRipgrepCommand(rawCommand);
        if (parsedSearch && hostResult.exitCode !== 0) {
          const emulated = await executeRipgrepEmulation(parsedSearch, workspace);
          const nativeCommandMissing = hostResult.exitCode === 127
            || hostResult.stderr.includes('not found')
            || hostResult.stderr.includes('not recognized');
          // Recover both a missing binary and shell-quoting differences when
          // the deterministic emulator can satisfy the search.
          if (emulated.success || nativeCommandMissing) {
            return annotateCommandResult(rawCommand, {
              command: rawCommand,
              stdout: truncateOutput(emulated.stdout),
              stderr: '',
              exitCode: emulated.exitCode,
              durationMs: emulated.durationMs,
              sandbox: 'local',
              executionTarget: 'host',
              success: emulated.success,
              emulated: true,
            });
          }
        }

        // Tự động kích hoạt Built-in Rm Emulator nếu native command thất bại trên Host
        if (parsedRm && hostResult.exitCode !== 0) {
          const emulatedRm = await executeRmEmulation(parsedRm, workspace);
          const nativeCommandMissing = hostResult.exitCode === 127
            || hostResult.stderr.includes('not found')
            || hostResult.stderr.includes('not recognized');
          if (emulatedRm.success || nativeCommandMissing) {
            return annotateCommandResult(rawCommand, {
              command: rawCommand,
              stdout: truncateOutput(emulatedRm.stdout),
              stderr: truncateOutput(emulatedRm.stderr),
              exitCode: emulatedRm.exitCode,
              durationMs: emulatedRm.durationMs,
              sandbox: 'local',
              executionTarget: 'host',
              success: emulatedRm.success,
              emulated: true,
              suggestion: emulatedRm.suggestion,
            });
          }
        }

        const hostDiagnosis = diagnoseCommandFailure(effectiveCommand, hostResult, hostSandbox.getStatus());
        return finalizeCommandResult({
          command: effectiveCommand,
          ...hostResult,
          ...hostDiagnosis,
          sandbox: hostResult.sandboxType,
          executionTarget: 'host',
          envForRedaction: dispatchEnv,
        }, workspace, advisoryExtra);
      }

      // Nếu có SandboxManager đang chạy
      if (sandboxManager) {
        const status = sandboxManager.getStatus();
        
        // Nếu không ở trong môi trường Docker Container cô lập, kiểm tra cấp quyền
        const isAllowedOnSandbox = isAllowedShellCommand(effectiveCommand) || isAllowedShellCommand(rawCommand);
        if (!status.isIsolated && !isAllowedOnSandbox && !hasExplicitPermission) {
          if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
            const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
            if (permCheck.allowed) {
              hasExplicitPermission = true;
              if (context) context.permissionGranted = true;
            } else if (shouldReturnPermissionDenial(effectivePermissionManager, permCheck)) {
              return {
                command: rawCommand,
                error: permCheck.reason || `Command "${rawCommand}" was rejected for execution on Host.`,
                errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
                permissionRequestId: permCheck.permissionRequestId,
                ...(permCheck.deniedByUser ? { deniedByUser: true } : {}),
              };
            }
            // else: no approval channel — fall through to the single denial below.
          }
        }

        if (!status.isIsolated && !isAllowedOnSandbox && !hasExplicitPermission) {
          const misuse = detectFileCommandMisuse(rawCommand);
          return {
            command: rawCommand,
            error: `Command "${rawCommand}" requires EXECUTION PERMISSION CONFIRMATION (PERMISSION APPROVAL) to run on Host. (Or enable the Docker Sandbox to run commands without limits).`,
            errorCode: 'COMMAND_NOT_ALLOWED',
            suggestion: approvalSuggestion(effectivePermissionManager, misuse),
          };
        }

        const res = await sandboxManager.exec(effectiveCommand, {
          cwd: sessionCwd,
          timeoutMs,
          signal: context?.signal,
          env: dispatchEnv,
        });

        // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu Docker Container thiếu binary hoặc gặp lỗi 127
        if (res.exitCode === 127 || res.stderr.includes('not found') || res.stderr.includes('not recognized')) {
          const isRg = parseRipgrepCommand(rawCommand);
          if (isRg) {
            const emulated = await executeRipgrepEmulation(isRg, workspace);
            return annotateCommandResult(rawCommand, {
              command: rawCommand,
              stdout: truncateOutput(emulated.stdout),
              stderr: '',
              exitCode: emulated.exitCode,
              durationMs: emulated.durationMs,
              sandbox: res.sandboxType,
              executionTarget: 'auto',
              success: emulated.success,
              emulated: true,
            });
          }
        }

        const diagnosis = res.errorCode
          ? undefined
          : diagnoseCommandFailure(effectiveCommand, res, sandboxManager.getStatus());
        const hostRecoveryRecommended = process.platform === 'win32'
          && res.sandboxType === 'docker'
          && ['NATIVE_DEPENDENCY_MISSING', 'COMMAND_NOT_EXECUTABLE'].includes(diagnosis?.errorCode || '');
        const recoverySuggestion = hostRecoveryRecommended
          ? `${diagnosis!.suggestion} This host is Windows; if the project intentionally uses Windows-native packages, retry run_command with execution_target: "host".`
          : diagnosis?.suggestion;

        return finalizeCommandResult({
          command: effectiveCommand,
          ...res,
          ...diagnosis,
          ...(recoverySuggestion ? { suggestion: recoverySuggestion } : {}),
          ...(hostRecoveryRecommended ? { recommendedExecutionTarget: 'host' } : {}),
          sandbox: res.sandboxType,
          executionTarget: 'auto',
          envForRedaction: dispatchEnv,
        }, workspace, advisoryExtra);
      }

      // Fallback mặc định
      const isAllowedFallback = isAllowedShellCommand(effectiveCommand) || isAllowedShellCommand(rawCommand);
      if (!isAllowedFallback && !hasExplicitPermission) {
        if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
          const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
          if (permCheck.allowed) {
            hasExplicitPermission = true;
            if (context) context.permissionGranted = true;
          } else if (shouldReturnPermissionDenial(effectivePermissionManager, permCheck)) {
            return {
              command: rawCommand,
              error: permCheck.reason || `Command "${rawCommand}" was rejected for execution.`,
              errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
              permissionRequestId: permCheck.permissionRequestId,
              ...(permCheck.deniedByUser ? { deniedByUser: true } : {}),
            };
          }
          // else: no approval channel — fall through to the single denial below.
        }
      }

      if (!isAllowedFallback && !hasExplicitPermission) {
        const misuse = detectFileCommandMisuse(rawCommand);
        return {
          command: rawCommand,
          error: `Command "${rawCommand}" requires EXECUTION PERMISSION CONFIRMATION (PERMISSION APPROVAL) before execution.`,
          errorCode: 'COMMAND_NOT_ALLOWED',
          suggestion: approvalSuggestion(effectivePermissionManager, misuse),
        };
      }

      // Fallback has no sandbox boundary: never inherit the full host env.
      const fallbackEnv = buildSafeChildEnv(dispatchEnv);
      const finalizeWithSecrets = (r: Record<string, any>) =>
        finalizeCommandResult({ ...r, envForRedaction: dispatchEnv }, workspace, advisoryExtra);
      return new Promise((resolve) => {
        exec(
          effectiveCommand,
          {
            cwd: sessionCwd,
            timeout: timeoutMs,
            signal: context?.signal,
            maxBuffer: MAX_COMMAND_BUFFER_BYTES,
            env: fallbackEnv,
          },
          (error, stdout, stderr) => {
            const timedOut = error?.killed && error.signal === 'SIGTERM';
            const exitCode = error ? (error.code ?? 1) : 0;

            const rawResult = {
              command: effectiveCommand,
              exitCode,
              stdout,
              stderr,
              timedOut: Boolean(timedOut),
              durationMs: 0,
              sandboxType: 'local' as const,
              success: exitCode === 0,
            };

            // Tự động Auto-Provision nếu gặp lỗi 127 hoặc not recognized
            const isMissingInFallback = exitCode === 127 || stderr.includes('not found') || stderr.includes('not recognized');
            const autoProvOn = process.env.MINUS_AUTO_PROVISION?.toLowerCase() !== 'off';
            if (autoProvOn && isMissingInFallback) {
              const missingExec = findMissingExecutable(`${stderr}\n${stdout}`, exitCode);
              if (missingExec && findRecipeForBinary(missingExec)) {
                ToolchainProvisioner.ensureToolchain(missingExec).then((provRes) => {
                  if (provRes?.success) {
                    clearBinaryProbeCache();
                    exec(
                      effectiveCommand,
                      {
                        cwd: sessionCwd,
                        timeout: timeoutMs,
                        signal: context?.signal,
                        maxBuffer: MAX_COMMAND_BUFFER_BYTES,
                        env: buildSafeChildEnv(dispatchEnv),
                      },
                      (retryErr, retryStdout, retryStderr) => {
                        const retryExit = retryErr ? (retryErr.code ?? 1) : 0;
                        const retryRes = {
                          command: effectiveCommand,
                          exitCode: retryExit,
                          stdout: retryStdout,
                          stderr: retryStderr,
                          timedOut: Boolean(retryErr?.killed),
                          durationMs: 0,
                          sandboxType: 'local' as const,
                          success: retryExit === 0,
                          autoProvisioned: {
                            toolchain: provRes.toolchain,
                            binDir: provRes.binDir,
                            version: provRes.version,
                          },
                        };
                        finalizeWithSecrets(retryRes).then(resolve).catch(() => resolve(retryRes));
                      }
                    );
                    return;
                  }
                  // Nếu provision fail, tiếp tục quy trình chuẩn đoán bình thường
                  const diagnosed = {
                    ...rawResult,
                    ...diagnoseCommandFailure(effectiveCommand, rawResult),
                  };
                  finalizeWithSecrets(diagnosed).then(resolve).catch(() => resolve(diagnosed));
                });
                return;
              }
            }

            // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu gặp lỗi 127
            if (exitCode === 127 || stderr.includes('not found') || stderr.includes('not recognized')) {
              const isRg = parseRipgrepCommand(effectiveCommand);
              if (isRg) {
                executeRipgrepEmulation(isRg, workspace).then((emulated) => {
                  resolve(annotateCommandResult(effectiveCommand, {
                    command: effectiveCommand,
                    stdout: truncateOutput(emulated.stdout),
                    stderr: '',
                    exitCode: emulated.exitCode,
                    durationMs: emulated.durationMs,
                    sandboxType: 'local' as const,
                    sandbox: 'local',
                    success: emulated.success,
                    emulated: true,
                  }));
                });
                return;
              }

              const isRm = parseRmCommand(effectiveCommand);
              if (isRm) {
                executeRmEmulation(isRm, workspace).then((emulatedRm) => {
                  resolve({
                    command: effectiveCommand,
                    stdout: truncateOutput(emulatedRm.stdout),
                    stderr: truncateOutput(emulatedRm.stderr),
                    exitCode: emulatedRm.exitCode,
                    durationMs: emulatedRm.durationMs,
                    sandboxType: 'local' as const,
                    sandbox: 'local',
                    success: emulatedRm.success,
                    emulated: true,
                    suggestion: emulatedRm.suggestion,
                  });
                });
                return;
              }
            }

            const diagnosed = {
              ...rawResult,
              ...diagnoseCommandFailure(effectiveCommand, rawResult),
              ...(timedOut
                ? { suggestion: 'Command hit its synchronous timeout. Re-run with a larger timeout_ms, or run it as a background task with WaitMsBeforeAsync (e.g. 5000) and poll via manage_task.' }
                : {}),
            };
            finalizeWithSecrets(diagnosed).then(resolve).catch(() => resolve(diagnosed));
          }
        );
      });
    },
  };
}

export const runCommandTool: ToolDefinition = createRunCommandTool();
