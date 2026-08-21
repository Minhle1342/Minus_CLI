import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { diagnoseCommandFailure } from '../sandbox/command-diagnostics.js';
import { LocalProcessSandbox } from '../sandbox/local-sandbox.js';

// Danh sách các tiền tố lệnh an toàn khi chạy ở chế độ Host / Unsandboxed
const ALLOWED_COMMAND_PREFIXES = [
  'npm test',
  'npm run',
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
  'git ',
  'git',
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

/** Git mutations must pass the per-turn authorization enforced by dedicated tools. */
export function findRestrictedGitMutation(command: string): string | undefined {
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
      return ['add', 'commit', 'push'].includes(token) ? token : undefined;
    }
  }
  return undefined;
}

/**
 * Tạo Tool run_command có tích hợp SandboxManager (Phase 6 - True Execution Sandbox)
 */
export function createRunCommandTool(sandboxManager?: SandboxManager): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Thực thi lệnh terminal trong Sandbox cô lập. Docker Sandbox tự nhận diện và chuyển runtime phù hợp cho Node.js, .NET, Python, Java, Go và Rust. Chỉ dùng Git dạng đọc; git add/commit/push phải gọi các tool Git chuyên dụng để áp dụng quyền theo yêu cầu người dùng.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Lệnh terminal cần thực thi (ví dụ: "npm test" hoặc "git diff")',
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

      const restrictedGitMutation = findRestrictedGitMutation(rawCommand);
      if (restrictedGitMutation) {
        return {
          command: rawCommand,
          error: `Git ${restrictedGitMutation} phải được thực thi bằng tool git_${restrictedGitMutation} chuyên dụng.`,
          errorCode: 'GIT_OPERATION_REQUIRES_DEDICATED_TOOL',
          suggestion: `Use git_${restrictedGitMutation} so the explicit per-turn user authorization can be verified.`,
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
