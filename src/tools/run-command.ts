import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

// Danh sách các tiền tố lệnh an toàn được phép chạy trong môi trường học tập
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
  'git status',
  'git diff',
  'git log',
  'git branch',
  'git show',
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
 * Kiểm tra xem lệnh có nằm trong danh sách an toàn hay không.
 */
export function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_COMMAND_PREFIXES.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

/**
 * Tool 6: run_command
 * Thực thi một lệnh CLI/Terminal trong workspace để chạy kiểm thử, build, lint hoặc xem git diff.
 */
export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Thực thi một lệnh terminal trong workspace (ví dụ: "npm test", "npm run build", "git status", "git diff").',
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

    // Kiểm tra chính sách an toàn của lệnh
    if (!isAllowedCommand(rawCommand)) {
      return {
        command: rawCommand,
        error: `Lệnh "${rawCommand}" không nằm trong danh sách lệnh an toàn được cấp phép. Các lệnh được hỗ trợ: npm test, npm run <script>, npx tsx, git status, git diff,...`,
        errorCode: 'COMMAND_NOT_ALLOWED',
      };
    }

    const timeoutMs = 30000; // Giới hạn 30 giây

    return new Promise((resolve) => {
      exec(
        rawCommand,
        {
          cwd: workspace.rootDir,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB buffer
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
