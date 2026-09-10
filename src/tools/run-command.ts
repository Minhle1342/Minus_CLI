import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition, type ToolExecutionContext } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { diagnoseCommandFailure } from '../sandbox/command-diagnostics.js';
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
} from './command-preflight-guard.js';

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
  'less ',
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
  'jq ',
  'sed ',
  'awk ',
  // Build, Test & Package Management
  'npm test',
  'npm run ',
  'npm start',
  'npm --version',
  'npm list',
  'npx tsx',
  'npx tsc',
  'npx eslint',
  'npx prettier',
  'npx jest',
  'npx vitest',
  'node ',
  'node -v',
  'node --version',
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
  workspace: Workspace
): Promise<Record<string, any>> {
  const exitCode = typeof baseResult.exitCode === 'number' ? baseResult.exitCode : 0;
  const cleanStdout = sanitizeTerminalOutput(baseResult.stdout || '');
  const cleanStderr = sanitizeTerminalOutput(baseResult.stderr || '');
  const distilledStdout = distillTestOutput(cleanStdout, exitCode);

  const configuredMax = Number(process.env.MINUS_TERMINAL_MAX_OUTPUT_CHARS);
  const maxLength = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 8000;

  let logFilePath: string | undefined;
  const combinedLength = distilledStdout.length + cleanStderr.length;
  if (combinedLength > maxLength) {
    const fullLog = `=== COMMAND ===\n${baseResult.command}\n\n=== STDOUT ===\n${baseResult.stdout || ''}\n\n=== STDERR ===\n${baseResult.stderr || ''}`;
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
    ...baseResult,
    stdout: truncatedStdout.text,
    stderr: truncatedStderr.text,
    exitCode,
    durationMs: typeof baseResult.durationMs === 'number' ? baseResult.durationMs : 0,
    success: typeof baseResult.success === 'boolean' ? baseResult.success : (exitCode === 0),
    ...(logFilePath ? { logFilePath } : {}),
    ...(truncatedStdout.savedChars > 0 ? { savedTokensEstimate: truncatedStdout.savedTokensEstimate } : {}),
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
  return !analysis.error && !analysis.complex && analysis.segments.every(isAllowedCommand);
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
      reason: 'Đọc file theo khoảng dòng chính xác (không tốn lượt cấp quyền, cung cấp contentHash) thay vì chia nhỏ bằng sed',
      suggestedArgs: { path: filePath, startLine, endLine },
    };
  }

  // 1.2. Đọc file qua shell (cat, type, Get-Content, gc, head, tail, more, less, sed)
  const readMatch = trimmed.match(/^(?:cat|type|Get-Content|gc|head|tail|more|less)\s+([^\s;&|]+)/i);
  if (readMatch) {
    const filePath = readMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Đọc nội dung file với hashing và an toàn token',
      suggestedArgs: { path: filePath },
    };
  }

  // 1.3. Trích xuất text hoặc code qua awk
  const awkMatch = trimmed.match(/^awk\s+.*?((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (awkMatch && !trimmed.includes('|')) {
    const filePath = awkMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Đọc nội dung file hoặc trích xuất symbol với read_file (symbol) / inspect_symbol',
      suggestedArgs: { path: filePath },
    };
  }

  // 2. Duyệt file/thư mục qua shell (ls, dir, tree, Get-ChildItem, gci)
  const listMatch = trimmed.match(/^(?:ls|dir|tree|Get-ChildItem|gci)(?:\s+([^\s;&|]+))?$/i);
  if (listMatch) {
    const dirPath = (listMatch[1] || '').replace(/^["']|["']$/g, '') || undefined;
    return {
      tool: 'list_files',
      reason: 'Liệt kê cấu trúc thư mục với bộ lọc tự động bỏ qua node_modules/.git',
      suggestedArgs: dirPath ? { dirPath } : {},
    };
  }

  // 3. Tìm kiếm chuỗi qua shell (grep, findstr, Select-String, sls)
  const grepMatch = trimmed.match(/^(?:grep|findstr|Select-String|sls)\s+(?:-[a-zA-Z0-9-]+\s+)*['"]?([^'"]+)['"]?/i);
  if (grepMatch) {
    const query = grepMatch[1];
    return {
      tool: 'search_codebase_fast',
      reason: 'Tìm kiếm BM25 nhanh trên toàn bộ codebase không tốn token',
      suggestedArgs: { query },
    };
  }

  // 4. Xóa file / thư mục qua shell (rm, del, erase, rmdir, rd, Remove-Item, ri)
  if (/^(?:rm|del|erase|rmdir|rd|Remove-Item|ri)\b/i.test(trimmed) && !/[;&|]/.test(trimmed)) {
    const parsed = parseRmCommand(trimmed);
    const targetPath = parsed?.targetPaths?.[0];
    return {
      tool: 'delete_file',
      reason: 'Xóa file/thư mục an toàn qua Node.js I/O (kiểm tra hash, isProtectedFile, cross-platform) thay vì dùng lệnh shell không tồn tại trên Windows hoặc tốn quyền',
      suggestedArgs: targetPath ? { path: targetPath, reason: 'Dọn dẹp tệp tin qua tool chuyên dụng' } : undefined,
    };
  }

  // 5. Di chuyển / đổi tên file qua shell (mv, move, Move-Item, mi)
  const mvMatch = trimmed.match(/^(?:mv|move|Move-Item|mi)\s+(?:-[a-zA-Z0-9-]+\s+)*((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (mvMatch && !/[;&|]/.test(trimmed)) {
    const sourcePath = mvMatch[1].replace(/^["']|["']$/g, '');
    const targetPath = mvMatch[2].replace(/^["']|["']$/g, '');
    return {
      tool: 'move_file',
      reason: 'Di chuyển hoặc đổi tên file an toàn trong workspace (chống ghi đè vô ý)',
      suggestedArgs: { sourcePath, targetPath },
    };
  }

  // 6. Tạo file rỗng qua shell (touch, New-Item, ni)
  const touchMatch = trimmed.match(/^(?:touch|New-Item|ni)\s+(?:-[a-zA-Z0-9-]+\s+)*((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (touchMatch && !/[;&|]/.test(trimmed)) {
    const filePath = touchMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'create_file',
      reason: 'Tạo file mới an toàn trong workspace không cần phụ thuộc POSIX shell binary',
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
      suggestion: 'Mẹo: Để tối ưu tốc độ và token, hãy dùng trực tiếp tool read_file với path, startLine, endLine hoặc symbol.',
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: `cat: cannot read file '${parsed.filePath}': ${err.message}`,
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
      emulated: true,
      suggestion: 'Kiểm tra lại đường dẫn file hoặc sử dụng tool chuyên dụng "read_file".',
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
          stdout: deletedPaths.length > 0 ? `Đã xóa: ${deletedPaths.join(', ')}` : '',
          stderr: `Security violation: Không được phép xóa file cấu hình nhạy cảm hoặc file được bảo vệ "${targetPath}".`,
          success: false,
          durationMs: Date.now() - startTime,
          exitCode: 1,
          suggestion: 'File này thuộc danh sách bảo vệ hệ thống của workspace và không thể xóa.',
        };
      }

      try {
        await fs.access(safePath);
      } catch {
        if (!parsed.force) {
          return {
            stdout: deletedPaths.length > 0 ? `Đã xóa: ${deletedPaths.join(', ')}` : '',
            stderr: `rm: cannot remove '${targetPath}': No such file or directory`,
            success: false,
            durationMs: Date.now() - startTime,
            exitCode: 1,
            suggestion: 'Kiểm tra lại đường dẫn tệp tin hoặc sử dụng tool chuyên dụng "delete_file".',
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
        ? `Đã xóa ${count} mục (${deletedPaths.join(', ')}) an toàn qua RmEmulation (${Date.now() - startTime}ms).`
        : '',
      stderr: '',
      success: true,
      durationMs: Date.now() - startTime,
      exitCode: 0,
      suggestion: 'Mẹo: Hãy dùng trực tiếp tool chuyên dụng "delete_file" (cross-platform, an toàn hash, <2ms) để tối ưu hóa.',
    };
  } catch (err: any) {
    return {
      stdout: deletedPaths.length > 0 ? `Đã xóa: ${deletedPaths.join(', ')}` : '',
      stderr: `rm: failed to remove: ${err.message}`,
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
    };
  }
}

/**
 * Tạo Tool run_command có tích hợp SandboxManager và TaskManager (Chuẩn Antigravity CLI Unified Command Execution)
 */
export function createRunCommandTool(sandboxManager?: SandboxManager, taskManager?: TaskManager, permissionManager?: any): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Thực thi lệnh terminal (build, test, lint, script, git) trong Sandbox cô lập hoặc Host. Hỗ trợ tham số WaitMsBeforeAsync để tự động chuyển lệnh chạy lâu sang background task. LƯU Ý QUAN TRỌNG: Để đọc hoặc kiểm tra mã nguồn, BẮT BUỘC dùng tool "read_file" (hỗ trợ trích xuất toàn bộ hàm qua "symbol" trong 1-shot hoặc dải dòng 150-300 dòng). Để xóa file hoặc thư mục, BẮT BUỘC dùng tool "delete_file" (an toàn hash, cross-platform). Để di chuyển hoặc đổi tên file, dùng "move_file". KHÔNG dùng run_command với sed/cat để đọc file, hoặc rm/del để xóa file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Lệnh terminal cần thực thi (ví dụ: "npm test", "rg \'my_function\' src/", "ls -la", "node -v"). Không dùng để đọc file (dùng read_file) hoặc xóa file (dùng delete_file).',
        },
        CommandLine: {
          type: Type.STRING,
          description: 'Bí danh chuẩn Antigravity của lệnh terminal cần thực thi.',
        },
        WaitMsBeforeAsync: {
          type: Type.INTEGER,
          description: 'Số milliseconds chờ đợi sau khi bắt đầu lệnh trước khi gửi xuống chạy nền (background task). Tối đa 10000ms. Nếu lệnh kết thúc trong khoảng này, trả về kết quả đồng bộ; nếu chưa, chuyển thành Background Task.',
        },
        timeout_ms: {
          type: Type.NUMBER,
          description: 'Timeout theo mili-giây (mặc định 120000, tối thiểu 1000, tối đa 300000). Tăng cho restore/build/test lớn.',
        },
        execution_target: {
          type: Type.STRING,
          description: 'Nơi thực thi: "auto" (mặc định, ưu tiên sandbox) hoặc "host" (host OS, chỉ dành cho lệnh allowlist khi dependency native không tương thích container).',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext): Promise<Record<string, any>> {
      const rawCommand = String(args.command || args.CommandLine || args.commandLine || args.cmd || '').trim();
      let hasExplicitPermission = context?.permissionGranted === true;
      const effectivePermissionManager = context?.permissionManager || permissionManager;
      const executionTarget = String(args.execution_target || 'auto').trim().toLowerCase();
      const configuredTimeout = Number(process.env.RUN_COMMAND_TIMEOUT_MS || 120000);
      const requestedTimeout = Number(args.timeout_ms);
      const defaultTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
      const timeoutMs = Math.min(
        300000,
        Math.max(1000, Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : defaultTimeout),
      );

      if (!rawCommand) {
        return { error: 'Tham số "command" hoặc "CommandLine" là bắt buộc.' };
      }

      // Xử lý WaitMsBeforeAsync (Antigravity CLI Async Dispatch)
      const waitMsBeforeAsync = typeof args.WaitMsBeforeAsync === 'number'
        ? Math.min(10000, Math.max(0, args.WaitMsBeforeAsync))
        : (typeof args.wait_ms_before_async === 'number' ? Math.min(10000, Math.max(0, args.wait_ms_before_async)) : undefined);

      // Pre-flight Guardrail: Chặn lệnh interactive (REPL, vim), dev server thiếu wait, lặp test vô ích, và chuẩn hóa Windows
      const preflight = evaluateCommandPreflight(rawCommand, {
        waitMsBeforeAsync,
        lastExecution: (context as any)?.lastCommandExecution,
      });

      if (!preflight.allowed) {
        return {
          command: rawCommand,
          error: preflight.reason || 'Lệnh bị chặn bởi Pre-flight Guardrail.',
          errorCode: preflight.errorCode || 'PREFLIGHT_GUARD_REJECTED',
          suggestion: preflight.suggestion,
          success: false,
          exitCode: 1,
          durationMs: 1,
        };
      }

      const effectiveCommand = preflight.normalizedCommand || rawCommand;

      // Parse and authorize the entire command before any synchronous or background dispatch.
      const shellAnalysis = analyzeShellCommand(effectiveCommand);

      // Kiểm tra User Rule 2: Chặn tự động push lên main/master để bảo vệ CI/CD Railway
      const blockedPushToMain = isBlockedGitPushToMain(effectiveCommand);

      // Kích hoạt Interactive Permission Approval nếu lệnh phức tạp, vi phạm push main, hoặc chứa phân đoạn ngoài allowlist
      const needsApproval = Boolean(shellAnalysis.error)
        || shellAnalysis.complex
        || blockedPushToMain
        || !shellAnalysis.segments.every(isAllowedCommand);

      const permArgs = { ...args, command: rawCommand, CommandLine: rawCommand };

      if (needsApproval && !hasExplicitPermission && effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
        const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
        if (permCheck.allowed) {
          hasExplicitPermission = true;
          if (context) context.permissionGranted = true;
        } else {
          return {
            command: rawCommand,
            error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi hoặc chưa được cấp quyền (PERMISSION APPROVAL).`,
            errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
            permissionRequestId: permCheck.permissionRequestId,
          };
        }
      }

      if (shellAnalysis.error || (shellAnalysis.complex && !hasExplicitPermission)) {
        return {
          command: rawCommand,
          error: shellAnalysis.error || 'Complex shell grouping/substitution requires explicit permission.',
          errorCode: 'COMMAND_PARSE_REJECTED',
        };
      }
      if (blockedPushToMain && !hasExplicitPermission) {
        return {
          command: rawCommand,
          error: 'THAO TÁC BỊ CHẶN (User Rule 2): Tuyệt đối không tự động thực hiện git push lên nhánh main/master để tránh kích hoạt hệ thống CI/CD Railway tự động. Cần có yêu cầu trực tiếp từ người dùng.',
          errorCode: 'PUSH_TO_MAIN_PROHIBITED',
          suggestion: 'Yêu cầu người dùng phê duyệt quyền (Permission Approval) nếu thực sự có chủ đích push lên main.',
        };
      }
      if (!shellAnalysis.segments.every(isAllowedCommand) && !hasExplicitPermission) {
        const deniedSegments = shellAnalysis.segments.filter((segment) => !isAllowedCommand(segment));
        const misuse = detectFileCommandMisuse(rawCommand);
        return {
          command: rawCommand,
          error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) từ người dùng. Các phân đoạn ngoài allowlist: ${deniedSegments.join(', ')}`,
          errorCode: 'COMMAND_NOT_ALLOWED',
          deniedSegments,
          suggestion: misuse
            ? `Khuyến nghị chuyển sang tool chuyên dụng "${misuse.tool}": ${misuse.reason}`
            : 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
        };
      }

      // Xử lý WaitMsBeforeAsync (Antigravity CLI Async Dispatch)
      if (waitMsBeforeAsync !== undefined && waitMsBeforeAsync > 0 && taskManager) {
        const bgTask = taskManager.startTask(rawCommand, workspace.rootDir);
        const startTime = Date.now();
        const deadline = startTime + waitMsBeforeAsync;

        while (Date.now() < deadline) {
          if (bgTask.status !== 'running') break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (bgTask.status !== 'running') {
          return {
            command: rawCommand,
            exitCode: bgTask.exitCode ?? (bgTask.status === 'stopped' ? 0 : 1),
            stdout: truncateOutput(bgTask.logs.join('\n')),
            stderr: '',
            durationMs: Date.now() - startTime,
            success: bgTask.exitCode === 0 || bgTask.status === 'stopped',
            sandboxType: 'local',
          };
        }

        return {
          command: rawCommand,
          isBackgroundTask: true,
          taskId: bgTask.id,
          pid: bgTask.pid,
          status: 'running',
          message: `Tool is running as a background task with task id: ${bgTask.id}`,
          recentLogs: bgTask.logs.slice(-10),
          instruction: `Sử dụng tool manage_task với TaskId="${bgTask.id}" để xem status, gửi stdin (send_input), hoặc kill.`,
        };
      }
      if (!['auto', 'host'].includes(executionTarget)) {
        return {
          command: effectiveCommand,
          error: 'execution_target chỉ chấp nhận "auto" hoặc "host".',
          errorCode: 'INVALID_EXECUTION_TARGET',
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
            suggestion: 'Mẹo: Để tối ưu tốc độ và token, hãy dùng trực tiếp tool read_file với path, startLine, endLine hoặc symbol.',
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

      if (executionTarget === 'host') {
        if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
            const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
            if (permCheck.allowed) {
              hasExplicitPermission = true;
              if (context) context.permissionGranted = true;
            } else {
              return {
                command: rawCommand,
                error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi trên Host.`,
                errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
                permissionRequestId: permCheck.permissionRequestId,
              };
            }
          }
        }
        if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          const misuse = detectFileCommandMisuse(rawCommand);
          return {
            command: rawCommand,
            error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) để thực thi trên Host.`,
            errorCode: 'COMMAND_NOT_ALLOWED',
            suggestion: misuse
              ? `Khuyến nghị chuyển sang tool chuyên dụng "${misuse.tool}": ${misuse.reason}`
              : 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
          };
        }
        const hostSandbox = new LocalProcessSandbox(workspace.rootDir);
        await hostSandbox.init();
        const hostResult = await hostSandbox.exec(rawCommand, { cwd: workspace.rootDir, timeoutMs, signal: context?.signal });

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
            return {
              command: rawCommand,
              stdout: truncateOutput(emulated.stdout),
              stderr: '',
              exitCode: emulated.exitCode,
              durationMs: emulated.durationMs,
              sandbox: 'local',
              executionTarget: 'host',
              success: emulated.success,
              emulated: true,
            };
          }
        }

        // Tự động kích hoạt Built-in Rm Emulator nếu native command thất bại trên Host
        if (parsedRm && hostResult.exitCode !== 0) {
          const emulatedRm = await executeRmEmulation(parsedRm, workspace);
          const nativeCommandMissing = hostResult.exitCode === 127
            || hostResult.stderr.includes('not found')
            || hostResult.stderr.includes('not recognized');
          if (emulatedRm.success || nativeCommandMissing) {
            return {
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
            };
          }
        }

        const hostDiagnosis = diagnoseCommandFailure(effectiveCommand, hostResult, hostSandbox.getStatus());
        return finalizeCommandResult({
          command: effectiveCommand,
          ...hostResult,
          ...hostDiagnosis,
          sandbox: hostResult.sandboxType,
          executionTarget: 'host',
        }, workspace);
      }

      // Nếu có SandboxManager đang chạy
      if (sandboxManager) {
        const status = sandboxManager.getStatus();
        
        // Nếu không ở trong môi trường Docker Container cô lập, kiểm tra cấp quyền
        if (!status.isIsolated && !isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
            const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
            if (permCheck.allowed) {
              hasExplicitPermission = true;
              if (context) context.permissionGranted = true;
            } else {
              return {
                command: rawCommand,
                error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi trên Host.`,
                errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
                permissionRequestId: permCheck.permissionRequestId,
              };
            }
          }
        }

        if (!status.isIsolated && !isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          const misuse = detectFileCommandMisuse(rawCommand);
          return {
            command: rawCommand,
            error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) để thực thi trên Host. (Hoặc bật Docker Sandbox để chạy lệnh không giới hạn).`,
            errorCode: 'COMMAND_NOT_ALLOWED',
            suggestion: misuse
              ? `Khuyến nghị chuyển sang tool chuyên dụng "${misuse.tool}": ${misuse.reason}`
              : 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
          };
        }

        const res = await sandboxManager.exec(rawCommand, {
          cwd: workspace.rootDir,
          timeoutMs,
          signal: context?.signal,
        });

        // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu Docker Container thiếu binary hoặc gặp lỗi 127
        if (res.exitCode === 127 || res.stderr.includes('not found') || res.stderr.includes('not recognized')) {
          const isRg = parseRipgrepCommand(rawCommand);
          if (isRg) {
            const emulated = await executeRipgrepEmulation(isRg, workspace);
            return {
              command: rawCommand,
              stdout: truncateOutput(emulated.stdout),
              stderr: '',
              exitCode: emulated.exitCode,
              durationMs: emulated.durationMs,
              sandbox: res.sandboxType,
              executionTarget: 'auto',
              success: emulated.success,
              emulated: true,
            };
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
        }, workspace);
      }

      // Fallback mặc định
      if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
        if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
          const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
          if (permCheck.allowed) {
            hasExplicitPermission = true;
            if (context) context.permissionGranted = true;
          } else {
            return {
              command: rawCommand,
              error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi.`,
              errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
              permissionRequestId: permCheck.permissionRequestId,
            };
          }
        }
      }

      if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
        const misuse = detectFileCommandMisuse(rawCommand);
        return {
          command: rawCommand,
          error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) trước khi thực thi.`,
          errorCode: 'COMMAND_NOT_ALLOWED',
          suggestion: misuse
            ? `Khuyến nghị chuyển sang tool chuyên dụng "${misuse.tool}": ${misuse.reason}`
            : 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
        };
      }

      return new Promise((resolve) => {
        exec(
          effectiveCommand,
          {
            cwd: workspace.rootDir,
            timeout: timeoutMs,
            signal: context?.signal,
            maxBuffer: 1024 * 1024,
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

            // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu gặp lỗi 127
            if (exitCode === 127 || stderr.includes('not found') || stderr.includes('not recognized')) {
              const isRg = parseRipgrepCommand(effectiveCommand);
              if (isRg) {
                executeRipgrepEmulation(isRg, workspace).then((emulated) => {
                  resolve({
                    command: effectiveCommand,
                    stdout: truncateOutput(emulated.stdout),
                    stderr: '',
                    exitCode: emulated.exitCode,
                    durationMs: emulated.durationMs,
                    sandboxType: 'local' as const,
                    sandbox: 'local',
                    success: emulated.success,
                    emulated: true,
                  });
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
            };
            finalizeCommandResult(diagnosed, workspace).then(resolve).catch(() => resolve(diagnosed));
          }
        );
      });
    },
  };
}

export const runCommandTool: ToolDefinition = createRunCommandTool();
