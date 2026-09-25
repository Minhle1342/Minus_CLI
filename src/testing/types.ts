/**
 * Test Engineering Types - Codex Standard Automated Test Harness
 */

export type TestFrameworkType =
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'pytest'
  | 'gotest'
  | 'cargotest'
  | 'npm'
  | 'custom'
  | 'unknown';

export type TestCaseStatus = 'passed' | 'failed' | 'skipped' | 'errored';

export interface TestCaseDetail {
  name: string;
  suite?: string;
  status: TestCaseStatus;
  durationMs?: number;
  failureMessage?: string;
  stackTrace?: string;
}

export interface StructuredTestReport {
  framework: TestFrameworkType;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  exitCode: number;
  rawOutput: string;
  testCases: TestCaseDetail[];
  isPassed: boolean;
  summaryText: string;
  timestamp: string;
  commandExecuted: string;
}

export interface TestHarnessOptions {
  testCommand?: string;
  testFiles?: string[];
  grepPattern?: string;
  timeoutMs?: number;
  /** Chạy kiểm thử trên Ephemeral Scratch Workspace để bảo vệ codebase gốc */
  useScratchWorkspace?: boolean;
  /** Tự động đồng bộ bằng chứng xác minh (Evidence Binding) vào CompletionEvidenceGate & CriticGate */
  bindEvidenceToGates?: boolean;
  /** Gắn kết với giả thuyết đang được kiểm tra (Hypothesis ID) */
  hypothesisId?: string;
  signal?: AbortSignal;
}
