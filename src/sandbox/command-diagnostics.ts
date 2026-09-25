import { SandboxExecutionResult, SandboxStatus } from './types.js';
import { extractExecutableCandidates } from './runtime-profiles.js';

export interface CommandFailureDiagnostic {
  success: false;
  errorCode: string;
  diagnostic: string;
  suggestion: string;
  missingExecutable?: string;
  missingDependency?: string;
  /** Drop-in replacement command when a known dev tool binary is missing. */
  fallbackCommand?: string;
}

export const POSIX_TO_TOOL_SUGGESTIONS: Record<string, { tool: string; suggestion: string }> = {
  rm: {
    tool: 'delete_file',
    suggestion: 'Lệnh POSIX "rm" không khả dụng trên Windows shell. Hãy sử dụng tool chuyên dụng "delete_file" (cross-platform, an toàn hash, <2ms) để xóa file hoặc thư mục.',
  },
  cat: {
    tool: 'read_file',
    suggestion: 'Lệnh POSIX "cat" không khả dụng trên Windows shell. Hãy sử dụng tool chuyên dụng "read_file" với "startLine"/"endLine" hoặc "symbol".',
  },
  ls: {
    tool: 'list_files',
    suggestion: 'Lệnh POSIX "ls" không khả dụng trên Windows shell. Hãy sử dụng tool chuyên dụng "list_files" để liệt kê thư mục.',
  },
  touch: {
    tool: 'create_file',
    suggestion: 'Lệnh POSIX "touch" không khả dụng trên Windows shell. Hãy sử dụng tool chuyên dụng "create_file" hoặc "write_file" để tạo file.',
  },
  cp: {
    tool: 'create_file',
    suggestion: 'Lệnh POSIX "cp" không khả dụng trên Windows shell. Hãy sử dụng "read_file" kết hợp "create_file" để sao chép file an toàn trong workspace.',
  },
  mv: {
    tool: 'move_file',
    suggestion: 'Lệnh POSIX "mv" không khả dụng trên Windows shell. Hãy sử dụng tool chuyên dụng "move_file" để di chuyển hoặc đổi tên file.',
  },
};

export interface DevToolSuggestion {
  /** Drop-in replacement, e.g. 'python -m ruff' (append the original args). */
  fallback?: string;
  /** Install command, e.g. 'pip install ruff'. */
  install?: string;
  /** Extra context, e.g. toolchain requirement. */
  note?: string;
}

/**
 * Known dev-tool binaries mapped to actionable fallbacks. Checked
 * case-insensitively by getDevToolSuggestion(); covers the ecosystem tools
 * that POSIX_TO_TOOL_SUGGESTIONS does not (linters, formatters, test
 * runners, toolchain shims). Keep entries to tools with a stable,
 * well-known fallback or install command.
 */
export const DEV_TOOL_SUGGESTIONS: Record<string, DevToolSuggestion> = {
  // Python lint/format/test (all runnable as modules of the interpreter)
  ruff: { fallback: 'python -m ruff', install: 'pip install ruff' },
  black: { fallback: 'python -m black', install: 'pip install black' },
  isort: { fallback: 'python -m isort', install: 'pip install isort' },
  flake8: { fallback: 'python -m flake8', install: 'pip install flake8' },
  mypy: { fallback: 'python -m mypy', install: 'pip install mypy' },
  pylint: { fallback: 'python -m pylint', install: 'pip install pylint' },
  pytest: { fallback: 'python -m pytest', install: 'pip install pytest' },
  bandit: { fallback: 'python -m bandit', install: 'pip install bandit' },
  // JS/TS via npx (no global install required)
  eslint: { fallback: 'npx eslint', install: 'npm install -D eslint' },
  prettier: { fallback: 'npx prettier', install: 'npm install -D prettier' },
  tsc: { fallback: 'npx tsc', install: 'npm install -D typescript' },
  jest: { fallback: 'npx jest', install: 'npm install -D jest' },
  vitest: { fallback: 'npx vitest', install: 'npm install -D vitest' },
  tsx: { fallback: 'npx tsx', install: 'npm install -D tsx' },
  // Go / Rust / .NET / JVM (toolchain components, no module fallback)
  'golangci-lint': { fallback: 'go vet ./...', install: 'go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest', note: 'Requires the Go toolchain on PATH.' },
  gofmt: { note: 'gofmt ships with the Go toolchain.', install: 'Install Go (https://go.dev/dl/) and ensure it is on PATH.' },
  rustfmt: { install: 'rustup component add rustfmt', note: 'Ships with the Rust toolchain.' },
  clippy: { fallback: 'cargo clippy', install: 'rustup component add clippy', note: 'Invoked via cargo; ships with the Rust toolchain.' },
  gradle: { fallback: './gradlew', note: 'Prefer the project wrapper; a bare gradle install is often the wrong version.' },
  'dotnet-ef': { install: 'dotnet tool install --global dotnet-ef' },
};

/** Case-insensitive lookup that also tolerates Windows executable suffixes. */
export function getDevToolSuggestion(name: string): DevToolSuggestion | undefined {
  const key = name.trim().toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
  return DEV_TOOL_SUGGESTIONS[key];
}

export function diagnoseCommandFailure(
  command: string,
  result: SandboxExecutionResult,
  status?: SandboxStatus,
): CommandFailureDiagnostic | undefined {
  if (result.exitCode === 0 && !result.timedOut) return undefined;

  const combinedOutput = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const missingExecutable = findMissingExecutable(combinedOutput, result.exitCode)
    || (result.exitCode === 127 ? extractExecutableCandidates(command)[0] : undefined);

  if (missingExecutable) {
    const isWindows = process.platform === 'win32';
    const lowerExec = missingExecutable.toLowerCase();
    const posixMapping = isWindows && !status?.isIsolated ? POSIX_TO_TOOL_SUGGESTIONS[lowerExec] : undefined;
    const environment = status?.isIsolated
      ? `Docker sandbox image ${status.image || 'unknown'}`
      : 'local host environment';

    if (posixMapping) {
      return {
        success: false,
        errorCode: 'POSIX_COMMAND_ON_WINDOWS',
        missingExecutable,
        diagnostic: `Lệnh POSIX "${missingExecutable}" không khả dụng trên môi trường Windows shell (cmd.exe).`,
        suggestion: posixMapping.suggestion,
      };
    }

    const devSuggestion = getDevToolSuggestion(missingExecutable);
    if (devSuggestion) {
      const fallbackHint = devSuggestion.fallback
        ? ` Run the same operation via "${devSuggestion.fallback} ..." instead`
        : '';
      const installHint = devSuggestion.install ? `, or install it (${devSuggestion.install})` : '';
      const noteHint = devSuggestion.note ? ` ${devSuggestion.note}` : '';
      return {
        success: false,
        errorCode: 'DEV_TOOL_NOT_FOUND',
        missingExecutable,
        ...(devSuggestion.fallback ? { fallbackCommand: devSuggestion.fallback } : {}),
        diagnostic: `Dev-tool binary "${missingExecutable}" is not available in the ${environment}. The requested command did not start.${noteHint}`,
        suggestion: `Binary "${missingExecutable}" is missing.${fallbackHint}${installHint}. Do not retry the bare "${missingExecutable}" command unchanged.`,
      };
    }

    return {
      success: false,
      errorCode: 'COMMAND_NOT_FOUND',
      missingExecutable,
      diagnostic: `Executable "${missingExecutable}" is not available in the ${environment}. The requested command did not start.`,
      suggestion: status?.isIsolated
        ? `Use a matching runtime profile/image or install "${missingExecutable}" in the sandbox. Do not retry the same command unchanged.`
        : `Install "${missingExecutable}" on the host or switch to a matching Docker runtime profile. Do not retry the same command unchanged.`,
    };
  }

  if (result.timedOut) {
    return {
      success: false,
      errorCode: 'COMMAND_TIMEOUT',
      diagnostic: 'The command exceeded its execution timeout and was terminated.',
      suggestion: 'Inspect partial output, split the operation, or use a longer task/background workflow instead of retrying unchanged.',
    };
  }

  const nativeDependency = findNativeDependency(combinedOutput);
  if (nativeDependency) {
    return {
      success: false,
      errorCode: 'NATIVE_DEPENDENCY_MISSING',
      missingDependency: nativeDependency,
      diagnostic: `Native library "${nativeDependency}" is unavailable or incompatible with the sandbox operating system/architecture.`,
      suggestion: 'Use a runtime package and Docker image compatible with the sandbox platform, or explicitly run the project on its supported host platform. Do not retry unchanged.',
    };
  }

  const scriptFailure = findPackageScriptFailure(command, combinedOutput);
  if (scriptFailure) {
    if (scriptFailure.isMissingWorkspace) {
      return {
        success: false,
        errorCode: 'WORKSPACE_NOT_FOUND',
        diagnostic: `Workspace "${scriptFailure.workspaceName || 'chỉ định'}" không tồn tại trong dự án hoặc không được cấu hình trong package.json.`,
        suggestion: 'Dự án có thể là single-package (không phải Monorepo). Hãy bỏ cờ --workspace và kiểm tra scripts trực tiếp trong package.json.',
      };
    }
    if (scriptFailure.isMissingPackageJson) {
      return {
        success: false,
        errorCode: 'PACKAGE_JSON_NOT_FOUND',
        diagnostic: 'No package.json file found in the execution directory.',
        suggestion: 'If this project is a monorepo or multi-package repository, config files and scripts reside in subfolders (e.g. apps/<name>/package.json). Use "list_files" to inspect project structure, or run commands with workspace flags (e.g. "npm test --workspace=<app>").',
      };
    }
    return {
      success: false,
      errorCode: 'PACKAGE_SCRIPT_MISSING',
      diagnostic: `Script "${scriptFailure.scriptName || 'specified'}" is not defined in package.json.`,
      suggestion: 'Inspect "package.json" with "read_file" to verify defined scripts, or check if the target script resides in a monorepo workspace (e.g. "npm test -w <workspace>"). Do not retry non-existent scripts.',
    };
  }

  const packageDependency = findPackageDependency(combinedOutput);
  if (packageDependency) {
    return {
      success: false,
      errorCode: 'PACKAGE_DEPENDENCY_MISSING',
      missingDependency: packageDependency,
      diagnostic: `Required package/module "${packageDependency}" could not be resolved by the selected runtime.`,
      suggestion: 'Restore/install the dependency with the project package manager and verify lockfile/runtime compatibility before retrying.',
    };
  }

  if (result.exitCode === 126 || /permission denied|not executable/i.test(combinedOutput)) {
    return {
      success: false,
      errorCode: 'COMMAND_NOT_EXECUTABLE',
      diagnostic: 'The command was found but could not be executed because of permissions or file format.',
      suggestion: 'Check executable permissions, shebang, line endings, architecture, and the command path before retrying.',
    };
  }

  if (result.exitCode === 137 || /out of memory|oomkilled/i.test(combinedOutput)) {
    return {
      success: false,
      errorCode: 'COMMAND_RESOURCE_LIMIT',
      diagnostic: 'The command was terminated, likely because the sandbox exceeded its memory/resource limit.',
      suggestion: 'Reduce workload size or increase the sandbox resource limits before retrying.',
    };
  }

  if (/VirtualAlloc.*errno=1455|errno=1455|ERROR_COMMITMENT_LIMIT|paging file is too small/i.test(combinedOutput)) {
    return {
      success: false,
      errorCode: 'HOST_MEMORY_COMMIT_EXHAUSTED',
      diagnostic: 'Windows virtual memory (Commitment Limit) is exhausted. The OS paging file cannot expand or physical RAM is saturated.',
      suggestion: 'Free up disk space on drive C: (clean Docker build cache/containers with "docker system prune -f"), limit WSL2 RAM in .wslconfig, or expand the Windows Paging File.',
    };
  }

  if (/& was unexpected at this time/i.test(combinedOutput)) {
    return {
      success: false,
      errorCode: 'POWERSHELL_SYNTAX_ON_CMD',
      diagnostic: 'Cú pháp toán tử gọi PowerShell ("& <lệnh>") không tương thích với shell Windows cmd.exe.',
      suggestion: 'Bỏ ký tự "&" ở đầu lệnh (ví dụ: "path\\to\\app.exe" thay vì "& .\\path\\to\\app.exe") hoặc chạy qua PowerShell: powershell -NoProfile -Command "...".',
    };
  }

  if (/MSB1003|does not contain a project or solution file/i.test(combinedOutput)) {
    return {
      success: false,
      errorCode: 'DOTNET_PROJECT_OR_SOLUTION_NOT_FOUND',
      diagnostic: 'Lệnh .NET (dotnet test/build/run) không tìm thấy file .csproj hoặc .sln trong thư mục hiện tại.',
      suggestion: 'Kiểm tra đường dẫn file .csproj hoặc .sln trong các thư mục con (ví dụ: "dotnet test path/to/project.csproj" hoặc "dotnet test src/MySolution.sln"), hoặc xác minh xem dự án hiện tại có phải là dự án .NET hay không.',
    };
  }

  if (/NETSDK1004|project\.assets\.json.*not found.*Run a NuGet package restore/i.test(combinedOutput)) {
    return {
      success: false,
      errorCode: 'DOTNET_RESTORE_REQUIRED',
      diagnostic: 'File cấu hình dependency của .NET (project.assets.json) chưa được khởi tạo.',
      suggestion: 'Chạy "dotnet restore" để tải các gói NuGet cần thiết trước khi chạy build hoặc test.',
    };
  }

  return {
    success: false,
    errorCode: 'COMMAND_FAILED',
    diagnostic: `The command completed with exit code ${result.exitCode}.`,
    suggestion: 'Use stderr/stdout as the source of truth, fix the reported cause, and do not repeat the same command unchanged.',
  };
}

export function findMissingExecutable(output: string, exitCode?: number): string | undefined {
  const patterns = [
    /(?:^|\n)(?:\/bin\/)?(?:ba|z|k)?sh:\s*(?:\d+:\s*)?([^:\s]+):\s*(?:not found|command not found)/i,
    /(?:^|\n)([^:\s]+):\s*command not found/i,
    /(?:^|\n)'?([^'\s]+)'? is not recognized as an internal or external command/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

export function findNativeDependency(output: string): string | undefined {
  return output.match(/Unable to load shared library ['"]([^'"]+)['"]/i)?.[1]
    || output.match(/(?:^|\s)([^\s/:]+\.(?:so(?:\.\d+)*|dll|dylib)):\s*(?:cannot open shared object file|not found)/i)?.[1];
}

export function findPackageDependency(output: string): string | undefined {
  const patterns = [
    /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/i,
    /Cannot find module ['"]([^'"]+)['"]/i,
    /Could not resolve (?:package|module) ['"]?([^'"\s]+)['"]?/i,
    /ClassNotFoundException:\s*([^\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export interface PackageScriptFailure {
  isMissingPackageJson: boolean;
  isMissingScript: boolean;
  isMissingWorkspace?: boolean;
  scriptName?: string;
  workspaceName?: string;
}

export function findPackageScriptFailure(command: string, output: string): PackageScriptFailure | undefined {
  // 1. Nhận diện lỗi workspace không tồn tại (npm error No workspaces found hoặc code ENOENT khi có --workspace)
  const isNoWorkspacesFound = /No workspaces found/i.test(output);
  const cmdWsMatch = command.match(/(?:--workspace[=\s]+|-w[=\s]+|--filter[=\s]+)(['"]?)([^'"\s]+)\1/i);
  const outputWsMatch = output.match(/--workspace=([^\s\r\n]+)/i);

  if (isNoWorkspacesFound || (/(?:ENOENT|code ENOENT)/i.test(output) && cmdWsMatch)) {
    const wsName = (cmdWsMatch?.[2] || outputWsMatch?.[1] || '').trim();
    return {
      isMissingPackageJson: false,
      isMissingScript: false,
      isMissingWorkspace: true,
      workspaceName: wsName || undefined,
    };
  }

  const isMissingPackageJson = /ENOENT.*package\.json|no such file or directory.*package\.json/i.test(output);
  const scriptMatch = output.match(/(?:npm\s+error\s+Missing\s+script|npm\s+ERR!\s+missing\s+script|Missing\s+script):\s*["']?([^"'\r\n]+)["']?|error\s+Command\s*["']([^"'\r\n]+)["']\s*not\s+found|script\s*["']([^"'\r\n]+)["']\s*not\s+found|ERR_PNPM_NO_SCRIPT/i);

  if (isMissingPackageJson) {
    return { isMissingPackageJson: true, isMissingScript: false };
  }
  if (scriptMatch) {
    const scriptName = (scriptMatch[1] || scriptMatch[2] || scriptMatch[3] || '').trim();
    return { isMissingPackageJson: false, isMissingScript: true, scriptName: scriptName || undefined };
  }
  return undefined;
}
