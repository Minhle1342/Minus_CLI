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
