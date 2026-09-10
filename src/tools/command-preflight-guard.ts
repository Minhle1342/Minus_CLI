import path from 'node:path';

export interface PreflightGuardResult {
  allowed: boolean;
  errorCode?: string;
  reason?: string;
  suggestion?: string;
  normalizedCommand?: string;
  extractedEnv?: Record<string, string>;
  redirectTool?: {
    tool: string;
    reason: string;
    suggestedArgs?: Record<string, any>;
  };
}

export interface LastCommandExecutionState {
  command?: string;
  success?: boolean;
  exitCode?: number;
  filesModifiedSince?: number;
}

/**
 * Các mẫu lệnh tương tác (REPL, text editor, terminal prompt) gây treo tiến trình terminal local.
 */
const INTERACTIVE_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
  suggestion: string;
}> = [
  {
    pattern: /^(?:python|python3|py)(?:\.exe)?\s*$/i,
    reason: 'Lệnh "python" không có tham số sẽ mở trình thông dịch tương tác (REPL) và làm treo tiến trình.',
    suggestion: 'Chạy script bằng "python <file.py>" hoặc thực thi code 1-shot bằng "python -c \"<code>\"".',
  },
  {
    pattern: /^(?:node|nodejs)(?:\.exe)?\s*$/i,
    reason: 'Lệnh "node" không có tham số sẽ mở Node.js REPL và làm treo tiến trình.',
    suggestion: 'Chạy script bằng "node <file.js>" hoặc thực thi 1-shot bằng "node -e \"<code>\"".',
  },
  {
    pattern: /^(?:powershell|powershell\.exe|pwsh|cmd|cmd\.exe)\s*$/i,
    reason: 'Khởi chạy sub-shell mà không truyền lệnh sẽ làm treo tiến trình chờ stdin.',
    suggestion: 'Truyền lệnh cụ thể vào shell, ví dụ: "powershell -Command <command>" hoặc "cmd /c <command>".',
  },
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+init\s*$/i,
    reason: 'Lệnh "npm init" tương tác sẽ chờ người dùng nhập package name và options qua stdin.',
    suggestion: 'Sử dụng cờ tự động phê duyệt: "npm init -y" hoặc "pnpm init".',
  },
  {
    pattern: /^(?:git\s+commit)\s*$/i,
    reason: 'Lệnh "git commit" không có thông điệp sẽ mở trình soạn thảo văn bản và làm treo tiến trình.',
    suggestion: 'Truyền thông điệp commit trực tiếp bằng "git commit -m \"thông điệp\"".',
  },
  {
    pattern: /^(?:vim|vi|nano|pico|emacs|less|more|man)\b/i,
    reason: 'Trình biên tập văn bản hoặc phân trang (pager) đòi hỏi giao diện tương tác TTY.',
    suggestion: 'Sử dụng tool chuyên dụng "read_file" để đọc file hoặc "replace_text" để sửa file.',
  },
  {
    pattern: /^(?:ssh|telnet|ftp|sftp)\b/i,
    reason: 'Giao thức tương tác từ xa yêu cầu xác thực hoặc phiên tương tác TTY.',
    suggestion: 'Sử dụng API hoặc công cụ tự động hóa không tương tác với key cấu hình sẵn.',
  },
];

/**
 * Các mẫu lệnh dev server hoặc watch process chạy vô hạn.
 */
const DEV_SERVER_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|watch)\b/i,
  /\b(?:vite|next\s+dev|webpack\s+serve|nodemon|uvicorn|flask\s+run)\b/i,
];

/**
 * Kiểm tra xem lệnh có phải là lệnh kiểm thử hay không.
 */
export function isTestCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return /\b(?:npm\s+test|npx\s+(?:jest|vitest|mocha)|pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(trimmed);
}

/**
 * Chuẩn hóa lệnh trên môi trường Windows native:
 * - Chuyển 'which <cmd>' thành 'where <cmd>'
 * - Bóc tách biến môi trường dạng POSIX 'export FOO=bar && <cmd>' hoặc 'FOO=bar <cmd>'
 */
export function normalizeWindowsCommand(command: string): {
  normalizedCommand: string;
  extractedEnv?: Record<string, string>;
  modified: boolean;
} {
  let normalized = command.trim();
  let modified = false;
  const extractedEnv: Record<string, string> = {};

  // 1. Chuyển 'which <tool>' thành 'where <tool>' trên Windows
  if (process.platform === 'win32') {
    const whichMatch = normalized.match(/^which\s+([a-zA-Z0-9_-]+)$/i);
    if (whichMatch) {
      normalized = `where ${whichMatch[1]}`;
      modified = true;
    }
  }

  // 2. Bóc tách 'export FOO=bar && cmd' dạng POSIX
  const exportMatch = normalized.match(/^export\s+([a-zA-Z_][a-zA-Z0-9_]*)=['"]?([^'";\n&]+)['"]?\s*&&\s*(.+)$/i);
  if (exportMatch) {
    const varName = exportMatch[1];
    const varVal = exportMatch[2].trim();
    extractedEnv[varName] = varVal;
    normalized = exportMatch[3].trim();
    modified = true;
  }

  // 3. Bóc tách 'FOO=bar <cmd>' dạng inline POSIX (ví dụ: NODE_ENV=test npm test)
  const inlineEnvMatch = normalized.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=([^\s;&|]+)\s+(.+)$/i);
  if (inlineEnvMatch && !inlineEnvMatch[1].toLowerCase().startsWith('git')) {
    const varName = inlineEnvMatch[1];
    const varVal = inlineEnvMatch[2].trim();
    extractedEnv[varName] = varVal;
    normalized = inlineEnvMatch[3].trim();
    modified = true;
  }

  return {
    normalizedCommand: normalized,
    extractedEnv: Object.keys(extractedEnv).length > 0 ? extractedEnv : undefined,
    modified,
  };
}

/**
 * Đánh giá Pre-flight Guardrail trước khi spawn subprocess thực thi terminal.
 */
export function evaluateCommandPreflight(
  command: string,
  options?: {
    waitMsBeforeAsync?: number;
    lastExecution?: LastCommandExecutionState;
    mode?: 'enforce' | 'observe' | 'off';
  }
): PreflightGuardResult {
  const mode = options?.mode || (process.env.MINUS_COMMAND_PREFLIGHT_GUARD?.toLowerCase() === 'off' ? 'off' : 'enforce');
  if (mode === 'off') {
    return { allowed: true };
  }

  const raw = command.trim();
  const { normalizedCommand, extractedEnv } = normalizeWindowsCommand(raw);

  // 1. Chặn lệnh tương tác treo (REPL, vim, nano, npm init)
  for (const item of INTERACTIVE_COMMAND_PATTERNS) {
    if (item.pattern.test(normalizedCommand)) {
      if (mode === 'observe') {
        return {
          allowed: true,
          normalizedCommand,
          extractedEnv,
          reason: `[OBSERVE] Phát hiện lệnh tương tác: ${item.reason}`,
        };
      }
      return {
        allowed: false,
        errorCode: 'INTERACTIVE_COMMAND_PROHIBITED',
        reason: item.reason,
        suggestion: item.suggestion,
      };
    }
  }

  // 2. Chặn server dài hạn nếu không cấu hình WaitMsBeforeAsync
  const isDevServer = DEV_SERVER_PATTERNS.some((p) => p.test(normalizedCommand));
  const hasWaitMs = typeof options?.waitMsBeforeAsync === 'number' && options.waitMsBeforeAsync > 0;
  if (isDevServer && !hasWaitMs) {
    if (mode === 'observe') {
      return {
        allowed: true,
        normalizedCommand,
        extractedEnv,
        reason: '[OBSERVE] Phát hiện lệnh dev server dài hạn.',
      };
    }
    return {
      allowed: false,
      errorCode: 'LONG_RUNNING_SERVER_REQUIRES_ASYNC',
      reason: `Lệnh "${normalizedCommand}" khởi động máy chủ hoặc tiến trình theo dõi liên tục, sẽ làm treo agent nếu chạy đồng bộ.`,
      suggestion: 'Thêm tham số WaitMsBeforeAsync (ví dụ 3000ms) để tự động chuyển lệnh sang Background Task.',
    };
  }

  // 3. Chặn vòng lặp chạy lại test vô ích khi chưa sửa code
  if (isTestCommand(normalizedCommand) && options?.lastExecution) {
    const last = options.lastExecution;
    const sameCmd = last.command && last.command.trim().toLowerCase() === normalizedCommand.toLowerCase();
    const wasFailed = last.success === false || (typeof last.exitCode === 'number' && last.exitCode !== 0);
    const noModifications = options.lastExecution.filesModifiedSince === 0;

    if (sameCmd && wasFailed && noModifications) {
      if (mode === 'observe') {
        return {
          allowed: true,
          normalizedCommand,
          extractedEnv,
          reason: '[OBSERVE] Phát hiện chạy lại test trùng lặp khi chưa có sửa đổi mã nguồn.',
        };
      }
      return {
        allowed: false,
        errorCode: 'IDEMPOTENT_TEST_EXECUTION_BLOCKED',
        reason: `Lệnh kiểm thử "${normalizedCommand}" vừa thất bại ở bước trước và chưa có bất kỳ tệp mã nguồn nào được chỉnh sửa kể từ đó.`,
        suggestion: 'Hãy phân tích nguyên nhân lỗi, đọc mã nguồn bằng "read_file" và thực hiện sửa lỗi bằng "replace_text" trước khi chạy lại test.',
      };
    }
  }

  return {
    allowed: true,
    normalizedCommand,
    extractedEnv,
  };
}
