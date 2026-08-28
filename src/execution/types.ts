/**
 * Execution Substrate Types - Codex CLI Standard Runtime Substrate
 * 
 * Cung cấp tầng trừu tượng hóa cho Compute Plane (Execution Substrate),
 * tách biệt hoàn toàn Control Plane (Agent Loop, Planning) khỏi tầng thực thi hệ điều hành.
 */

export type SubstrateType = 'local' | 'sandboxed' | 'docker' | 'ephemeral';

export interface SubstrateCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBufferBytes?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
  signal?: AbortSignal;
  /** Chạy lệnh ở chế độ ngầm / không block */
  isBackground?: boolean;
  /** Ghi đè biến môi trường thay vì merge */
  isolatedEnv?: boolean;
}

export interface SubstrateExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  substrateType: SubstrateType;
  success: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  killed?: boolean;
  pid?: number;
  peakMemoryBytes?: number;
  diagnostic?: string;
  suggestion?: string;
}

export interface SubstrateTelemetry {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  timedOutExecutions: number;
  totalDurationMs: number;
  avgDurationMs: number;
  activeProcesses: number;
}

export interface IExecutionSubstrate {
  readonly name: string;
  readonly type: SubstrateType;

  /**
   * Khởi tạo runtime substrate
   */
  init(): Promise<void>;

  /**
   * Thực thi lệnh shell trên substrate với timeout và lifecycle management
   */
  exec(command: string, options?: SubstrateCommandOptions): Promise<SubstrateExecutionResult>;

  /**
   * Lấy telemetry vận hành của Substrate
   */
  getTelemetry(): SubstrateTelemetry;

  /**
   * Kiểm tra substrate có khả dụng trên host hiện tại không
   */
  isAvailable(): Promise<boolean>;

  /**
   * Dọn dẹp tài nguyên và tiến trình con đang chạy
   */
  dispose(): Promise<void>;
}
