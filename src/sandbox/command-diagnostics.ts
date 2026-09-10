import { SandboxExecutionResult, SandboxStatus } from './types.js';
import { extractExecutableCandidates } from './runtime-profiles.js';

export interface CommandFailureDiagnostic {
  success: false;
  errorCode: string;
  diagnostic: string;
  suggestion: string;
  missingExecutable?: string;
  missingDependency?: string;
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

    if (posixMapping) {
      return {
        success: false,
        errorCode: 'POSIX_COMMAND_ON_WINDOWS',
        missingExecutable,
        diagnostic: `Lệnh POSIX "${missingExecutable}" không khả dụng trên môi trường Windows shell (cmd.exe).`,
        suggestion: posixMapping.suggestion,
      };
    }

    const environment = status?.isIsolated
      ? `Docker sandbox image ${status.image || 'unknown'}`
      : 'local host environment';
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
  scriptName?: string;
}

export function findPackageScriptFailure(command: string, output: string): PackageScriptFailure | undefined {
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
