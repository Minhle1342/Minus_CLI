import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { diagnoseCommandFailure } from '../sandbox/command-diagnostics.js';
import { LocalProcessSandbox } from '../sandbox/local-sandbox.js';

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
];

/**
 * Cắt ngắn output nếu quá dài để bảo vệ context window của LLM.
 */
function truncateOutput(text: string, maxLength: number = 50000): string {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  const half = Math.floor(maxLength / 2);
  return `${text.slice(0, half)}\n\n[... Đã cắt bớt ${text.length - maxLength} ký tự output ...]\n\n${text.slice(-half)}`;
}

/**
 * Kiểm tra xem lệnh có nằm trong danh sách an toàn hay không (cho Host mode).
 */
export function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_COMMAND_PREFIXES.some((prefix) => {
    const exact = prefix.trim();
    return trimmed === exact || (prefix.endsWith(' ') && trimmed.startsWith(prefix));
  });
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

  // 1. Đọc file qua shell (cat, type, Get-Content, gc, head, tail, more, less)
  const readMatch = trimmed.match(/^(?:cat|type|Get-Content|gc|head|tail|more|less)\s+([^\s;&|]+)/i);
  if (readMatch) {
    const filePath = readMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Đọc nội dung file với hashing và an toàn token',
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

  return undefined;
}

/**
 * Tạo Tool run_command có tích hợp SandboxManager (Codex CLI Terminal-First Execution)
 */
export function createRunCommandTool(sandboxManager?: SandboxManager): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Thực thi lệnh terminal (build, test, lint, explore, inspect, scripts) trong Sandbox cô lập theo chuẩn Terminal-First của Codex CLI. Hỗ trợ chạy các lệnh tìm kiếm (rg, grep, find), duyệt file (ls, dir, tree), đọc log, kiểm thử (npm test, pytest), biên dịch (tsc, npm run build), và thực thi script.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Lệnh terminal cần thực thi (ví dụ: "npm test", "rg \'my_function\' src/", "ls -la", "node -v")',
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
      required: ['command'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const rawCommand = String(args.command || '').trim();
      const executionTarget = String(args.execution_target || 'auto').trim().toLowerCase();
      const configuredTimeout = Number(process.env.RUN_COMMAND_TIMEOUT_MS || 120000);
      const requestedTimeout = Number(args.timeout_ms);
      const defaultTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
      const timeoutMs = Math.min(
        300000,
        Math.max(1000, Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : defaultTimeout),
      );

      if (!rawCommand) {
        return { error: 'Tham số "command" là bắt buộc.' };
      }
      if (!['auto', 'host'].includes(executionTarget)) {
        return {
          command: rawCommand,
          error: 'execution_target chỉ chấp nhận "auto" hoặc "host".',
          errorCode: 'INVALID_EXECUTION_TARGET',
        };
      }

      const gitSubcommand = findGitSubcommand(rawCommand);
      if (gitSubcommand) {
        return {
          command: rawCommand,
          error: `Git ${gitSubcommand} phải được thực thi bằng git_command hoặc tool Git chuyên dụng.`,
          errorCode: 'GIT_COMMAND_REQUIRES_GIT_TOOL',
          suggestion: `Use git_command with subcommand "${gitSubcommand}" and a separate args array so workspace scope and per-turn authorization can be verified.`,
        };
      }

      if (executionTarget === 'host') {
        if (!isAllowedCommand(rawCommand)) {
          return {
            command: rawCommand,
            error: `Lệnh "${rawCommand}" không nằm trong allowlist để thực thi trên Host.`,
            errorCode: 'COMMAND_NOT_ALLOWED',
          };
        }
        const hostSandbox = new LocalProcessSandbox(workspace.rootDir);
        await hostSandbox.init();
        const hostResult = await hostSandbox.exec(rawCommand, { cwd: workspace.rootDir, timeoutMs });
        const hostDiagnosis = diagnoseCommandFailure(rawCommand, hostResult, hostSandbox.getStatus());
        return {
          command: rawCommand,
          ...hostResult,
          ...hostDiagnosis,
          stdout: truncateOutput(hostResult.stdout),
          stderr: truncateOutput(hostResult.stderr),
          sandbox: hostResult.sandboxType,
          executionTarget: 'host',
        };
      }

      // Nếu có SandboxManager đang chạy
      if (sandboxManager) {
        const status = sandboxManager.getStatus();
        
        // Nếu không ở trong môi trường Docker Container cô lập, vẫn áp dụng allowlist bảo vệ máy chủ
        if (!status.isIsolated && !isAllowedCommand(rawCommand)) {
          return {
            command: rawCommand,
            error: `Lệnh "${rawCommand}" không nằm trong danh sách lệnh an toàn được cấp phép trên Host. (Bật Docker Sandbox để chạy lệnh không giới hạn).`,
            errorCode: 'COMMAND_NOT_ALLOWED',
          };
        }

        const res = await sandboxManager.exec(rawCommand, {
          cwd: workspace.rootDir,
          timeoutMs,
        });
        const diagnosis = res.errorCode
          ? undefined
          : diagnoseCommandFailure(rawCommand, res, sandboxManager.getStatus());
        const hostRecoveryRecommended = process.platform === 'win32'
          && res.sandboxType === 'docker'
          && ['NATIVE_DEPENDENCY_MISSING', 'COMMAND_NOT_EXECUTABLE'].includes(diagnosis?.errorCode || '');
        const recoverySuggestion = hostRecoveryRecommended
          ? `${diagnosis!.suggestion} This host is Windows; if the project intentionally uses Windows-native packages, retry run_command with execution_target: "host".`
          : diagnosis?.suggestion;

        return {
          command: rawCommand,
          ...res,
          ...diagnosis,
          ...(recoverySuggestion ? { suggestion: recoverySuggestion } : {}),
          ...(hostRecoveryRecommended ? { recommendedExecutionTarget: 'host' } : {}),
          stdout: truncateOutput(res.stdout),
          stderr: truncateOutput(res.stderr),
          sandbox: res.sandboxType,
          executionTarget: 'auto',
        };
      }

      // Fallback mặc định
      if (!isAllowedCommand(rawCommand)) {
        return {
          command: rawCommand,
          error: `Lệnh "${rawCommand}" không nằm trong danh sách lệnh an toàn được cấp phép.`,
          errorCode: 'COMMAND_NOT_ALLOWED',
        };
      }

      return new Promise((resolve) => {
        exec(
          rawCommand,
          {
            cwd: workspace.rootDir,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const timedOut = error?.killed && error.signal === 'SIGTERM';
            const exitCode = error ? (error.code ?? 1) : 0;

            const rawResult = {
              command: rawCommand,
              exitCode,
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(stderr),
              timedOut: Boolean(timedOut),
              durationMs: 0,
              sandboxType: 'local' as const,
              success: exitCode === 0,
            };
            resolve({
              ...rawResult,
              ...diagnoseCommandFailure(rawCommand, rawResult),
            });
          }
        );
      });
    },
  };
}

export const runCommandTool: ToolDefinition = createRunCommandTool();
