import fs from 'node:fs';
import path from 'node:path';

export type SandboxRuntime = 'node' | 'dotnet' | 'python' | 'java' | 'go' | 'rust' | 'generic' | 'custom';

export interface SandboxRuntimeProfile {
  runtime: SandboxRuntime;
  image: string;
  detectedFrom: string;
  primaryExecutable?: string;
}

export interface CommandRuntimeInference {
  runtime?: SandboxRuntime;
  executable?: string;
  runtimes: SandboxRuntime[];
  executables: string[];
  mixed: boolean;
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.codingagent',
  '.idea',
  '.vs',
  '.vscode',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'target',
  'vendor',
]);

const EXECUTABLE_RUNTIMES: Record<string, SandboxRuntime> = {
  node: 'node',
  npm: 'node',
  npx: 'node',
  pnpm: 'node',
  yarn: 'node',
  corepack: 'node',
  dotnet: 'dotnet',
  python: 'python',
  python3: 'python',
  pip: 'python',
  pip3: 'python',
  pytest: 'python',
  poetry: 'python',
  java: 'java',
  javac: 'java',
  mvn: 'java',
  mvnw: 'java',
  gradle: 'java',
  gradlew: 'java',
  go: 'go',
  cargo: 'rust',
  rustc: 'rust',
  rustup: 'rust',
};

export function createCustomRuntimeProfile(image: string): SandboxRuntimeProfile {
  return {
    runtime: 'custom',
    image,
    detectedFrom: 'SANDBOX_DOCKER_IMAGE',
  };
}

export function getRuntimeProfile(
  runtime: SandboxRuntime,
  workspacePath: string,
  executable?: string,
): SandboxRuntimeProfile {
  switch (runtime) {
    case 'dotnet': {
      const version = detectDotnetVersion(workspacePath) || '8.0';
      return { runtime, image: `mcr.microsoft.com/dotnet/sdk:${version}`, detectedFrom: `target framework net${version}`, primaryExecutable: 'dotnet' };
    }
    case 'python': {
      const version = detectVersionFile(workspacePath, '.python-version') || '3.12';
      return { runtime, image: `python:${normalizeMajorMinor(version)}-slim`, detectedFrom: '.python-version or Python project files', primaryExecutable: 'python' };
    }
    case 'java': {
      const usesGradle = executable?.includes('gradle') || projectFiles(workspacePath).some((file) => /(?:^|\/)(?:build\.gradle(?:\.kts)?|gradlew)$/i.test(file));
      return usesGradle
        ? { runtime, image: 'gradle:8-jdk21', detectedFrom: 'Gradle project or command', primaryExecutable: 'gradle' }
        : { runtime, image: 'maven:3.9-eclipse-temurin-21', detectedFrom: 'Maven/Java project or command', primaryExecutable: 'mvn' };
    }
    case 'go': {
      const version = detectGoVersion(workspacePath) || '1.24';
      return { runtime, image: `golang:${normalizeMajorMinor(version)}-alpine`, detectedFrom: 'go.mod', primaryExecutable: 'go' };
    }
    case 'rust':
      return { runtime, image: 'rust:1-slim', detectedFrom: 'Cargo.toml or Rust command', primaryExecutable: 'cargo' };
    case 'node':
      return { runtime, image: `node:${detectNodeMajor(workspacePath) || '20'}-alpine`, detectedFrom: 'package.json/.nvmrc or Node command', primaryExecutable: 'node' };
    default:
      return { runtime: 'generic', image: 'node:20-alpine', detectedFrom: 'fallback profile', primaryExecutable: 'node' };
  }
}

export function detectWorkspaceRuntimeProfile(workspacePath: string): SandboxRuntimeProfile {
  const files = projectFiles(workspacePath);
  const has = (pattern: RegExp) => files.some((file) => pattern.test(file));

  if (has(/(?:\.sln|\.slnx|\.csproj|global\.json)$/i)) return getRuntimeProfile('dotnet', workspacePath);
  if (has(/(?:^|\/)package\.json$/i)) return getRuntimeProfile('node', workspacePath);
  if (has(/(?:^|\/)(?:pyproject\.toml|requirements[^/]*\.txt|Pipfile|setup\.py)$/i)) return getRuntimeProfile('python', workspacePath);
  if (has(/(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|gradlew)$/i)) return getRuntimeProfile('java', workspacePath);
  if (has(/(?:^|\/)go\.mod$/i)) return getRuntimeProfile('go', workspacePath);
  if (has(/(?:^|\/)Cargo\.toml$/i)) return getRuntimeProfile('rust', workspacePath);

  return getRuntimeProfile('generic', workspacePath);
}

export function inferCommandRuntime(command: string): CommandRuntimeInference {
  const executables = extractExecutableCandidates(command);
  const runtimeEntries = executables
    .map((executable) => ({ executable, runtime: EXECUTABLE_RUNTIMES[executable.toLowerCase()] }))
    .filter((entry): entry is { executable: string; runtime: SandboxRuntime } => Boolean(entry.runtime));
  const runtimes = [...new Set(runtimeEntries.map((entry) => entry.runtime))];

  return {
    runtime: runtimes.length === 1 ? runtimes[0] : undefined,
    executable: runtimeEntries[0]?.executable,
    runtimes,
    executables,
    mixed: runtimes.length > 1,
  };
}

export function extractExecutableCandidates(command: string): string[] {
  const segments = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.flatMap((segment) => {
    let candidate = segment
      .replace(/^\(+\s*/, '')
      .replace(/^(?:sudo\s+|command\s+|exec\s+)+/i, '')
      .replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '');
    const match = candidate.match(/^(?:["'])([^"']+)(?:["'])|^([^\s]+)/);
    candidate = match?.[1] || match?.[2] || '';
    const executable = path.posix.basename(candidate.replace(/\\/g, '/')).replace(/\.(?:cmd|exe|bat)$/i, '');
    return executable ? [executable] : [];
  });
}

function projectFiles(workspacePath: string, maxDepth: number = 2): string[] {
  const collected: string[] = [];

  function visit(currentPath: string, relativePath: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(currentPath, entry.name), relative, depth + 1);
      } else {
        collected.push(relative);
      }
    }
  }

  visit(workspacePath, '', 0);
  return collected;
}

function detectDotnetVersion(workspacePath: string): string | undefined {
  const globalJsonPath = path.join(workspacePath, 'global.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(globalJsonPath, 'utf8'));
    if (typeof parsed?.sdk?.version === 'string') return normalizeMajorMinor(parsed.sdk.version);
  } catch {}

  const versions: number[] = [];
  for (const relativePath of projectFiles(workspacePath).filter((file) => file.endsWith('.csproj'))) {
    try {
      const content = fs.readFileSync(path.join(workspacePath, relativePath), 'utf8');
      for (const match of content.matchAll(/<TargetFrameworks?>\s*([^<]+)\s*<\/TargetFrameworks?>/gi)) {
        for (const framework of match[1].split(';')) {
          const version = framework.trim().match(/^net(\d+)\.(\d+)/i);
          if (version) versions.push(Number(`${version[1]}.${version[2]}`));
        }
      }
    } catch {}
  }
  if (!versions.length) return undefined;
  return Math.max(...versions).toFixed(1);
}

function detectNodeMajor(workspacePath: string): string | undefined {
  const fromNvm = detectVersionFile(workspacePath, '.nvmrc');
  if (fromNvm) return fromNvm.match(/\d+/)?.[0];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf8'));
    return String(pkg?.engines?.node || '').match(/\d+/)?.[0];
  } catch {
    return undefined;
  }
}

function detectGoVersion(workspacePath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspacePath, 'go.mod'), 'utf8').match(/^go\s+(\d+\.\d+)/m)?.[1];
  } catch {
    return undefined;
  }
}

function detectVersionFile(workspacePath: string, fileName: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspacePath, fileName), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function normalizeMajorMinor(version: string): string {
  const match = version.match(/(\d+)(?:\.(\d+))?/);
  return match ? `${match[1]}.${match[2] || '0'}` : version;
}
