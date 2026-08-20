export type SandboxMode = 'local' | 'docker' | 'microvm' | 'auto';

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  sandboxType: 'docker' | 'local' | 'microvm';
}

export interface SandboxOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
  networkDisabled?: boolean;
}

export interface SandboxStatus {
  mode: SandboxMode;
  activeProvider: string;
  isIsolated: boolean;
  dockerAvailable: boolean;
  containerId?: string;
  image?: string;
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
