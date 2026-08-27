export type SandboxMode = 'local' | 'docker' | 'microvm' | 'auto';

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxType: 'docker' | 'local' | 'microvm';
  success?: boolean;
  errorCode?: string;
  diagnostic?: string;
  suggestion?: string;
  missingExecutable?: string;
  missingDependency?: string;
  timedOut?: boolean;
  runtime?: string;
  image?: string;
}

export interface SandboxOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
  networkDisabled?: boolean;
  signal?: AbortSignal;
}

export interface SandboxStatus {
  mode: SandboxMode;
  activeProvider: string;
  isIsolated: boolean;
  dockerAvailable: boolean;
  containerId?: string;
  image?: string;
  runtime?: string;
  detectedFrom?: string;
}

export interface ISandboxProvider {
  readonly name: string;
  readonly type: 'docker' | 'local' | 'microvm';
  isAvailable(): Promise<boolean>;
  init(): Promise<void>;
  exec(command: string, options?: SandboxOptions): Promise<SandboxExecutionResult>;
  getStatus(): SandboxStatus;
  dispose(): Promise<void>;
}
