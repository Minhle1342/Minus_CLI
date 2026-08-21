import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';

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
  return ALLOWED_COMMAND_PREFIXES.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

/**
 * Tạo Tool run_command có tích hợp SandboxManager (Phase 6 - True Execution Sandbox)
 */
export function createRunCommandTool(sandboxManager?: SandboxManager): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Thực thi một lệnh terminal trong môi trường Sandbox cô lập (ví dụ: "npm test", "npm run build", "git status", "git diff").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Lệnh terminal cần thực thi (ví dụ: "npm test" hoặc "git diff")',
        },
      },
      required: ['command'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const rawCommand = String(args.command || '').trim();

      if (!rawCommand) {
        return { error: 'Tham số "command" là bắt buộc.' };
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
          timeoutMs: 30000,
        });

        return {
          command: rawCommand,
          exitCode: res.exitCode,
          stdout: truncateOutput(res.stdout),
          stderr: truncateOutput(res.stderr),
          sandbox: res.sandboxType,
          durationMs: res.durationMs,
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

      const timeoutMs = 30000;

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

            resolve({
              command: rawCommand,
              exitCode,
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(stderr),
              timedOut: Boolean(timedOut),
            });
          }
        );
      });
    },
  };
}

export const runCommandTool: ToolDefinition = createRunCommandTool();
