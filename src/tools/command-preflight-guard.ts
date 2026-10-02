import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { nativeScanPathForBinaries } from '../native/index.js';

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
    reason: 'The "python" command without arguments opens an interactive interpreter (REPL) and hangs the process.',
    suggestion: 'Run a script with "python <file.py>" or execute 1-shot code with "python -c \"<code>\"".',
  },
  {
    pattern: /^(?:node|nodejs)(?:\.exe)?\s*$/i,
    reason: 'The "node" command without arguments opens the Node.js REPL and hangs the process.',
    suggestion: 'Run a script with "node <file.js>" or execute 1-shot with "node -e \"<code>\"".',
  },
  {
    pattern: /^(?:powershell|powershell\.exe|pwsh|cmd|cmd\.exe)\s*$/i,
    reason: 'Launching a sub-shell without a command hangs the process waiting for stdin.',
    suggestion: 'Pass a concrete command to the shell, e.g. "powershell -Command <command>" or "cmd /c <command>".',
  },
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+init\s*$/i,
    reason: 'Interactive "npm init" waits for the user to enter a package name and options via stdin.',
    suggestion: 'Use the auto-approve flag: "npm init -y" or "pnpm init".',
  },
  {
    pattern: /^(?:git\s+commit)\s*$/i,
    reason: 'The "git commit" command without a message opens a text editor and hangs the process.',
    suggestion: 'Pass the commit message directly with "git commit -m \"<message>\"".',
  },
  {
    pattern: /^(?:vim|vi|nano|pico|emacs|less|more|man)\b/i,
    reason: 'Text editors or pagers require an interactive TTY.',
    suggestion: 'Use the dedicated "read_file" tool to read files or "replace_text" to edit files.',
  },
  {
    pattern: /^(?:ssh|telnet|ftp|sftp)\b/i,
    reason: 'Remote interactive protocols require authentication or an interactive TTY session.',
    suggestion: 'Use a non-interactive API or automation tool with a preconfigured key.',
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

  // 1. Chuẩn hóa môi trường Windows cmd.exe:
  // - Bóc tách toán tử gọi của PowerShell '& <cmd>' (ví dụ: & .\bin\Release\GitKeyTests.exe)
  // - Chuyển 'which <tool>' thành 'where <tool>'
  // - Chuẩn hóa 'ls' thành 'dir'
  if (process.platform === 'win32') {
    // 1.0. Chuẩn hóa toán tử gọi của PowerShell "& <cmd>" trên Windows cmd.exe
    // Ví dụ: & .\bin\Release\GitKeyTests.exe -> .\bin\Release\GitKeyTests.exe
    const psCallMatch = normalized.match(/^&\s+((?:["'][^"']+["'])|(?:\S+.*))$/);
    if (psCallMatch) {
      normalized = psCallMatch[1].trim();
      modified = true;
    }

    const whichMatch = normalized.match(/^which\s+([a-zA-Z0-9_-]+)$/i);
    if (whichMatch) {
      normalized = `where ${whichMatch[1]}`;
      modified = true;
    }

    const lsMatch = normalized.match(/^ls\b(.*)$/i);
    if (lsMatch && !/[;&|]/.test(normalized)) {
      const rest = lsMatch[1].trim();
      if (!rest) {
        normalized = 'dir';
        modified = true;
      } else {
        const tokens = (rest.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.trim());
        let hasA = false;
        let hasS = false;
        const paths: string[] = [];
        for (const token of tokens) {
          if (token.startsWith('-') || token.startsWith('/')) {
            const lower = token.toLowerCase();
            if (lower.includes('a')) hasA = true;
            if (lower.includes('r') || lower === '/s') hasS = true;
          } else {
            paths.push(token);
          }
        }
        const flags = [hasA ? '/a' : '', hasS ? '/s' : ''].filter(Boolean).join(' ');
        const pathPart = paths.join(' ');
        normalized = `dir${flags ? ' ' + flags : ''}${pathPart ? ' ' + pathPart : ''}`;
        modified = true;
      }
    }
  }

  // 2. Bóc tách lặp các tiền tố gán biến môi trường (PowerShell, CMD, POSIX export, inline)
  // Xử lý hoàn hảo các chuỗi biến môi trường phức tạp:
  // Ví dụ: $env:NODE_OPTIONS='--max-old-space-size=512'; $env:UV_THREADPOOL_SIZE='1'; npm run build
  let matchedEnvInLoop = true;
  while (matchedEnvInLoop && normalized.length > 0) {
    matchedEnvInLoop = false;

    // 2.1. PowerShell: $env:VAR_NAME = 'value'; hoặc "value"; hoặc value; (dấu ; là tuỳ chọn)
    const psMatch = normalized.match(/^\$env:([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;]+))\s*;?\s*([\s\S]*)$/i);
    if (psMatch) {
      const varName = psMatch[1];
      const varVal = psMatch[2] ?? psMatch[3] ?? psMatch[4] ?? '';
      extractedEnv[varName] = varVal;
      normalized = (psMatch[5] || '').trim();
      modified = true;
      matchedEnvInLoop = true;
      continue;
    }

    // 2.2. CMD: set "VAR_NAME=value" && hoặc set VAR_NAME=value && (hoặc &)
    const cmdMatch = normalized.match(/^set\s+(?:"([a-zA-Z_][a-zA-Z0-9_]*)=([^"]*)"|([a-zA-Z_][a-zA-Z0-9_]*)=([^\s&]+))\s*(?:&&|&)\s*([\s\S]*)$/i);
    if (cmdMatch) {
      const varName = cmdMatch[1] || cmdMatch[3];
      const varVal = cmdMatch[2] ?? cmdMatch[4] ?? '';
      extractedEnv[varName] = varVal;
      normalized = (cmdMatch[5] || '').trim();
      modified = true;
      matchedEnvInLoop = true;
      continue;
    }

    // 2.3. POSIX Export: export VAR_NAME='value' && hoặc ;
    const exportMatch = normalized.match(/^export\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))\s*(?:&&|;)\s*([\s\S]*)$/i);
    if (exportMatch) {
      const varName = exportMatch[1];
      const varVal = exportMatch[2] ?? exportMatch[3] ?? exportMatch[4] ?? '';
      extractedEnv[varName] = varVal;
      normalized = (exportMatch[5] || '').trim();
      modified = true;
      matchedEnvInLoop = true;
      continue;
    }

    // 2.4. POSIX Inline: VAR_NAME=value <cmd> (không match nếu là lệnh git hoặc từ khóa shell)
    const inlineMatch = normalized.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))\s+([\s\S]+)$/i);
    if (inlineMatch && !inlineMatch[1].toLowerCase().startsWith('git') && !/^(?:if|then|else|for|while|do|case)\b/i.test(inlineMatch[1])) {
      const varName = inlineMatch[1];
      const varVal = inlineMatch[2] ?? inlineMatch[3] ?? inlineMatch[4] ?? '';
      extractedEnv[varName] = varVal;
      normalized = (inlineMatch[5] || '').trim();
      modified = true;
      matchedEnvInLoop = true;
      continue;
    }
  }

  return {
    normalizedCommand: normalized,
    extractedEnv: Object.keys(extractedEnv).length > 0 ? extractedEnv : undefined,
    modified,
  };
}

export interface EvaluateCommandPreflightOptions {
  waitMsBeforeAsync?: number;
  lastExecution?: LastCommandExecutionState;
  mode?: 'enforce' | 'observe' | 'off';
  workspaceRoot?: string;
}

/**
 * Đánh giá Pre-flight Guardrail trước khi spawn subprocess thực thi terminal.
 */
export function evaluateCommandPreflight(
  command: string,
  options?: EvaluateCommandPreflightOptions
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
          reason: `[OBSERVE] Detected interactive command: ${item.reason}`,
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
        reason: '[OBSERVE] Detected long-running dev server command.',
      };
    }
    return {
      allowed: false,
      errorCode: 'LONG_RUNNING_SERVER_REQUIRES_ASYNC',
      reason: `Command "${normalizedCommand}" starts a server or continuous watch process that hangs the agent if run synchronously.`,
      suggestion: 'Add the WaitMsBeforeAsync parameter (e.g. 3000ms) to automatically move the command to a Background Task.',
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
          reason: '[OBSERVE] Detected duplicate test re-run with no source modifications.',
        };
      }
      return {
        allowed: false,
        errorCode: 'IDEMPOTENT_TEST_EXECUTION_BLOCKED',
        reason: `Test command "${normalizedCommand}" just failed in the previous step and no source files have been modified since.`,
        suggestion: 'Analyze the failure cause, read the source with "read_file" and fix the bug with "replace_text" before re-running tests.',
      };
    }
  }

  // 4. Chặn 'git clone <url> .' vào thư mục hiện tại vì chắc chắn thất bại khi workspace đã có mã nguồn
  // và tránh rủi ro ghi đè / xung đột với kho lưu trữ git hiện tại của dự án.
  const gitCloneDotMatch = normalizedCommand.match(/^git(?:\.exe)?\s+clone(?:\s+[^\s]+)*\s+([^\s]+)\s+(?:\.|\.\/|\\|\.\\)\s*$/i);
  if (gitCloneDotMatch) {
    const repoUrl = gitCloneDotMatch[1];
    const repoName = repoUrl.replace(/\.git$/i, '').split(/[/:\\]/).pop() || 'external-repo';
    if (mode === 'observe') {
      return {
        allowed: true,
        normalizedCommand,
        extractedEnv,
        reason: '[OBSERVE] Detected git clone directly into the workspace root directory.',
      };
    }
    return {
      allowed: false,
      errorCode: 'GIT_CLONE_CURRENT_DIRECTORY_FORBIDDEN',
      reason: `Cloning with "git clone" directly into the current directory (".") is blocked because the current workspace contains project source and Git reports "fatal: destination path '.' already exists and is not an empty directory".`,
      suggestion: `Specify a separate subdirectory to clone into, e.g. "git clone ${repoUrl} ${repoName}" or create a temp directory under "scratch/${repoName}".`,
    };
  }

  // 5. Chặn gọi file thực thi nội bộ ảo (hallucinated local binary/script) khi không tồn tại trên đĩa
  if (options?.workspaceRoot) {
    const candidatePath = extractLocalCandidatePath(normalizedCommand);
    if (candidatePath) {
      const fullCandidate = path.isAbsolute(candidatePath)
        ? candidatePath
        : path.resolve(options.workspaceRoot, candidatePath);

      if (!fs.existsSync(fullCandidate)) {
        // Tìm kiếm các file nhị phân tương tự trong thư mục lân cận (ví dụ: Debug thay vì Release)
        let siblingSuggestion = '';
        try {
          const dirName = path.dirname(fullCandidate);
          const parentDir = path.dirname(dirName);
          if (fs.existsSync(parentDir)) {
            const subEntries = fs.readdirSync(parentDir, { withFileTypes: true });
            const found: string[] = [];
            for (const sub of subEntries) {
              if (sub.isDirectory()) {
                const subPath = path.join(parentDir, sub.name);
                const subFiles = fs.readdirSync(subPath);
                const exes = subFiles.filter((f) => /tests?\.exe$/i.test(f) || f.endsWith('.exe'));
                for (const exe of exes) {
                  found.push(path.relative(options.workspaceRoot, path.join(subPath, exe)));
                }
              }
            }
            if (found.length > 0) {
              siblingSuggestion = ` Found existing executables in the output directory: ${found.join(', ')}.`;
            }
          }
        } catch {}

        if (mode === 'observe') {
          return {
            allowed: true,
            normalizedCommand,
            extractedEnv,
            reason: `[OBSERVE] Executable "${candidatePath}" does not exist on disk.`,
          };
        }

        return {
          allowed: false,
          errorCode: 'LOCAL_EXECUTABLE_NOT_FOUND',
          reason: `Executable "${candidatePath}" does not exist on disk in the workspace directory.${siblingSuggestion}`,
          suggestion: siblingSuggestion
            ? `Check the actual executable or build configuration (e.g. run the Debug build instead of Release, or rebuild before running). Use the "list_files" tool to inspect the output directory.`
            : `Binary or script "${candidatePath}" has not been built or does not exist. Build the project first or use "list_files" to verify the exact path.`,
        };
      }
    }
  }

  // 6. Chặn workspace hoặc package script không tồn tại trong package.json
  if (options?.workspaceRoot) {
    const pkgCmd = extractPackageCommand(normalizedCommand);
    if (pkgCmd) {
      const rootPkgPath = path.join(options.workspaceRoot, 'package.json');
      let rootPkg: any = undefined;
      try {
        if (fs.existsSync(rootPkgPath)) {
          rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
        }
      } catch {}

      // 6.1. Xác thực workspace nếu có chỉ định (--workspace, -w, --filter)
      if (pkgCmd.workspaceName) {
        const wsName = pkgCmd.workspaceName;
        const directPath = path.resolve(options.workspaceRoot, wsName);
        const directPkgPath = path.join(directPath, 'package.json');
        const directPkgExists = fs.existsSync(directPkgPath);

        const declaredWorkspaces = rootPkg?.workspaces;
        const hasWorkspacesConfig = Array.isArray(declaredWorkspaces)
          ? declaredWorkspaces.length > 0
          : Boolean(declaredWorkspaces && Array.isArray(declaredWorkspaces.packages));

        let matchingWorkspaceFound = directPkgExists;
        if (!matchingWorkspaceFound) {
          const candidateDirs = ['apps', 'packages', 'modules', 'services', 'projects', 'crates'];
          for (const parentDir of candidateDirs) {
            const parentPath = path.join(options.workspaceRoot, parentDir);
            if (fs.existsSync(parentPath)) {
              try {
                const subEntries = fs.readdirSync(parentPath, { withFileTypes: true });
                for (const sub of subEntries) {
                  if (sub.isDirectory()) {
                    const subPkgFile = path.join(parentPath, sub.name, 'package.json');
                    if (fs.existsSync(subPkgFile)) {
                      try {
                        const subPkg = JSON.parse(fs.readFileSync(subPkgFile, 'utf8'));
                        if (subPkg.name === wsName || `${parentDir}/${sub.name}` === wsName || sub.name === wsName) {
                          matchingWorkspaceFound = true;
                          break;
                        }
                      } catch {}
                    }
                  }
                }
              } catch {}
            }
            if (matchingWorkspaceFound) break;
          }
        }

        if (!matchingWorkspaceFound) {
          if (mode === 'observe') {
            return {
              allowed: true,
              normalizedCommand,
              extractedEnv,
              reason: `[OBSERVE] Workspace "${wsName}" does not exist on disk or in the package.json configuration.`,
            };
          }
          return {
            allowed: false,
            errorCode: 'WORKSPACE_NOT_FOUND',
            reason: hasWorkspacesConfig
              ? `Workspace "${wsName}" does not exist in the Monorepo configuration and no matching package directory was found on disk.`
              : `The current project is single-package (package.json has no "workspaces" config) and no "${wsName}" directory exists.`,
            suggestion: hasWorkspacesConfig
              ? `Use the "list_files" tool to inspect the monorepo directories (e.g. apps/ or packages/) to find the correct workspace name.`
              : `Drop the --workspace flag and run the command directly (e.g. "${pkgCmd.manager} ${pkgCmd.isRun ? 'run ' : ''}${pkgCmd.scriptName || 'test'}").`,
          };
        }
      }

      // 6.2. Xác thực script khi chạy `npm run <script>` (hoặc pnpm run, bun run)
      if (pkgCmd.isRun && pkgCmd.scriptName && rootPkg) {
        let targetPkg = rootPkg;
        if (pkgCmd.workspaceName) {
          const directSubPkg = path.join(options.workspaceRoot, pkgCmd.workspaceName, 'package.json');
          if (fs.existsSync(directSubPkg)) {
            try { targetPkg = JSON.parse(fs.readFileSync(directSubPkg, 'utf8')); } catch {}
          }
        }

        const scripts = targetPkg.scripts || {};
        if (!scripts[pkgCmd.scriptName]) {
          const available = Object.keys(scripts);
          if (mode === 'observe') {
            return {
              allowed: true,
              normalizedCommand,
              extractedEnv,
              reason: `[OBSERVE] Script "${pkgCmd.scriptName}" is missing from package.json.`,
            };
          }
          return {
            allowed: false,
            errorCode: 'PACKAGE_SCRIPT_NOT_FOUND',
            reason: `Script "${pkgCmd.scriptName}" is not defined in ${pkgCmd.workspaceName ? `workspace "${pkgCmd.workspaceName}" ` : ''}package.json.`,
            suggestion: available.length > 0
              ? `Available scripts in package.json: ${available.slice(0, 10).join(', ')}. Pick a suitable script or check package.json again.`
              : `package.json defines no scripts. Check package.json again.`,
          };
        }
      }
    }
  }

  return {
    allowed: true,
    normalizedCommand,
    extractedEnv,
  };
}

/**
 * Trích xuất đường dẫn file thực thi nội bộ cục bộ từ chuỗi lệnh.
 */
export function extractLocalCandidatePath(command: string): string | undefined {
  const trimmed = command.trim();
  const quotedMatch = trimmed.match(/^["']([^"']+)["'](?:\s+.*)?$/);
  if (quotedMatch) {
    const p = quotedMatch[1];
    if (/[\\/]/.test(p) || /\.(?:exe|bat|cmd|sh|ps1|com)$/i.test(p)) {
      return p;
    }
  }

  const tokenMatch = trimmed.match(/^(\S+)(?:\s+.*)?$/);
  if (tokenMatch) {
    const firstToken = tokenMatch[1].replace(/^["']|["']$/g, '');
    if (
      firstToken.startsWith('.\\')
      || firstToken.startsWith('./')
      || /^(?:\.?[\/\\])?(?:bin|target|build|dist|scripts|out|x64|x86)[\/\\]/i.test(firstToken)
    ) {
      return firstToken;
    }
  }

  return undefined;
}

export interface ExtractedPackageCommand {
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  scriptName?: string;
  workspaceName?: string;
  isRun: boolean;
}

/**
 * Phân tích cú pháp lệnh package manager (npm/pnpm/yarn/bun) để bóc tách workspace và script name.
 */
export function extractPackageCommand(command: string): ExtractedPackageCommand | undefined {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:npm(?:\.cmd|\.exe)?|pnpm(?:\.cmd|\.exe)?|yarn(?:\.cmd|\.exe)?|bun(?:\.cmd|\.exe)?)\b(.*)$/i);
  if (!match) return undefined;

  const firstToken = (trimmed.match(/^\S+/)?.[0] || '').toLowerCase();
  const manager: 'npm' | 'pnpm' | 'yarn' | 'bun' = firstToken.includes('pnpm')
    ? 'pnpm'
    : firstToken.includes('yarn')
      ? 'yarn'
      : firstToken.includes('bun')
        ? 'bun'
        : 'npm';

  const argsStr = match[1].trim();

  // Trích xuất workspace: --workspace=<ws>, --workspace <ws>, -w=<ws>, -w <ws>, --filter=<ws>, --filter <ws>, workspace <ws>
  let workspaceName: string | undefined;
  const wsMatch = argsStr.match(/(?:--workspace[=\s]+|-w[=\s]+|--filter[=\s]+)(['"]?)([^'"\s]+)\1/i)
    || (manager === 'yarn' ? argsStr.match(/\bworkspace\s+(['"]?)([^'"\s]+)\1/i) : null);
  if (wsMatch) {
    workspaceName = wsMatch[2].trim();
  }

  // Trích xuất script name:
  // Ví dụ: `npm run lint`, `pnpm run build`, `npm test`
  let scriptName: string | undefined;
  let isRun = false;
  const runMatch = argsStr.match(/\brun\s+(['"]?)([a-zA-Z0-9_:.-]+)\1/i);
  if (runMatch) {
    isRun = true;
    scriptName = runMatch[2].trim();
  } else {
    // Các lệnh script thông dụng gọi không cần "run"
    const directMatch = argsStr.match(/^(?:test|start)\b/i);
    if (directMatch) {
      scriptName = directMatch[0].toLowerCase();
    }
  }

  return {
    manager,
    scriptName,
    workspaceName,
    isRun,
  };
}

/**
 * Shell builtins/internal commands that never resolve via PATH.
 * Probing them would false-positive, so the missing-binary probe skips them.
 */
const SHELL_BUILTIN_COMMANDS = new Set([
  // cmd.exe internals
  'echo', 'cd', 'chdir', 'dir', 'del', 'erase', 'copy', 'move', 'ren', 'rename',
  'type', 'cls', 'set', 'path', 'ver', 'vol', 'date', 'time', 'mkdir', 'md',
  'rmdir', 'rd', 'start', 'call', 'exit', 'pushd', 'popd', 'title', 'pause', 'rem',
  // POSIX / sh builtins
  'pwd', 'export', 'test', 'true', 'false', 'alias', 'unalias', 'source',
]);

/** Project-local bin dirs checked before PATH (venv, node_modules). */
const WORKSPACE_BIN_DIRS = [
  'node_modules/.bin',
  'node_modules\\.bin',
  '.venv/Scripts',
  '.venv/bin',
  'venv/Scripts',
  'venv/bin',
];

/**
 * First tokens owned by built-in emulators (cat/ls/sed/rm/rg in
 * run-command.ts) or shell internals. The probe must not block them:
 * the emulator or the local-executable guard handles those paths.
 */
const EMULATED_FIRST_TOKENS = new Set([
  'cat', 'type', 'head', 'tail', 'more', 'less',
  'sed', 'ls', 'dir',
  'rm', 'del', 'erase', 'rmdir', 'rd',
  'rg', 'ripgrep', 'grep', 'findstr', 'select-string', 'sls',
]);

interface BinaryProbeCacheEntry {
  found: boolean;
  at: number;
}

const BINARY_PROBE_CACHE = new Map<string, BinaryProbeCacheEntry>();
const BINARY_PROBE_CACHE_TTL_MS = 30_000;

function pathextCandidates(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  const pathext = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const candidates = [name];
  for (const ext of pathext) {
    if (name.toLowerCase().endsWith(ext)) return [name];
    candidates.push(`${name}${ext}`);
  }
  return [...new Set(candidates)];
}

/** Synchronous PATH (+ workspace bin dirs) lookup; cached briefly per process. */
export function isBareBinaryAvailable(name: string, workspaceRoot?: string): boolean {
  const key = `${workspaceRoot || ''}\0${name.toLowerCase()}`;
  const cached = BINARY_PROBE_CACHE.get(key);
  if (cached && Date.now() - cached.at < BINARY_PROBE_CACHE_TTL_MS) return cached.found;

  let found = false;
  const searchDirs: string[] = [];
  if (workspaceRoot) {
    for (const binDir of WORKSPACE_BIN_DIRS) {
      searchDirs.push(path.join(workspaceRoot, binDir));
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir.trim()) searchDirs.push(dir.trim());
  }

  // Include installed toolchains directory if recipe exists
  const recipe = findRecipeForBinary(name);
  if (recipe) {
    const installRoot = process.env.MINUS_TOOLCHAINS_DIR
      || (process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs')
        : path.join(os.homedir(), '.minus', 'toolchains'));
    const targetDir = path.join(installRoot, recipe.targetDirName);
    const binDir = recipe.binSubDir ? path.join(targetDir, recipe.binSubDir) : targetDir;
    searchDirs.push(binDir);
  }

  // Fast path: one native readdir pass over all dirs instead of N×M existsSync calls.
  const candidates = pathextCandidates(name);
  const nativeHits = nativeScanDirsForBinary(searchDirs, candidates);
  if (nativeHits) {
    found = nativeHits.length > 0;
  } else {
    outer: for (const dir of searchDirs) {
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(path.join(dir, candidate))) {
            found = true;
            break outer;
          }
        } catch {
          // Unreadable PATH entry: ignore and keep scanning.
        }
      }
    }
  }
  BINARY_PROBE_CACHE.set(key, { found, at: Date.now() });
  return found;
}

/**
 * Fast path used by provision flows: resolve a bare binary name across
 * workspace bin dirs + PATH (+ installed toolchains dir) in one native call.
 * Returns the first absolute hit, or undefined. Falls back to
 * isBareBinaryAvailable when native is unavailable.
 */
export function findBinaryOnPath(name: string, workspaceRoot?: string): string | undefined {
  const searchDirs: string[] = [];
  if (workspaceRoot) {
    for (const binDir of WORKSPACE_BIN_DIRS) {
      searchDirs.push(path.join(workspaceRoot, binDir));
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir.trim()) searchDirs.push(dir.trim());
  }
  const recipe = findRecipeForBinary(name);
  if (recipe) {
    const installRoot = process.env.MINUS_TOOLCHAINS_DIR
      || (process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs')
        : path.join(os.homedir(), '.minus', 'toolchains'));
    const targetDir = path.join(installRoot, recipe.targetDirName);
    searchDirs.push(recipe.binSubDir ? path.join(targetDir, recipe.binSubDir) : targetDir);
  }
  const candidates = pathextCandidates(name);
  const hits = nativeScanDirsForBinary(searchDirs, candidates);
  if (hits && hits.length > 0) return hits[0];
  return isBareBinaryAvailable(name, workspaceRoot) ? name : undefined;
}

/** Bulk native variant: one Rust readdir pass over all dirs. Null when native unavailable. */
export function nativeScanDirsForBinary(searchDirs: string[], candidates: string[]): string[] | null {
  try {
    return nativeScanPathForBinaries(searchDirs, candidates);
  } catch {
    return null;
  }
}

/** Clears the missing-binary probe cache (tests, or after a fresh install). */
export function clearBinaryProbeCache(): void {
  BINARY_PROBE_CACHE.clear();
}

import { findRecipeForBinary } from '../toolchains/toolchain-recipes.js';

export interface MissingBinaryProbe {
  name: string;
  canAutoProvision?: boolean;
}

/**
 * Detects a bare binary name that resolves nowhere (PATH + project bin dirs).
 * Returns undefined when the first token is a path (owned by the
 * LOCAL_EXECUTABLE_NOT_FOUND guard), a shell builtin, or resolvable.
 * Never spawns a process.
 */
export function probeMissingBinary(
  command: string,
  options?: { workspaceRoot?: string },
): MissingBinaryProbe | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const tokenMatch = trimmed.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const firstToken = (tokenMatch?.slice(1).find(Boolean) || '').replace(/^["']|["']$/g, '');
  if (!firstToken) return undefined;
  // Local paths (./bin/app, C:\...) belong to the local-executable guard.
  if (firstToken.includes('/') || firstToken.includes('\\')) return undefined;
  // Env assignments and flags are not binaries.
  if (/^[$-]/.test(firstToken) || firstToken.includes('=')) return undefined;
  const base = firstToken.replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
  if (!base || SHELL_BUILTIN_COMMANDS.has(base.toLowerCase())) return undefined;
  if (EMULATED_FIRST_TOKENS.has(base.toLowerCase())) return undefined;
  if (isBareBinaryAvailable(base, options?.workspaceRoot)) return undefined;
  const canAutoProvision = Boolean(findRecipeForBinary(base));
  return { name: base, ...(canAutoProvision ? { canAutoProvision: true } : {}) };
}
