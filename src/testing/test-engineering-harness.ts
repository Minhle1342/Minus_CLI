import fs from 'node:fs/promises';
import path from 'node:path';
import { IExecutionSubstrate } from '../execution/types.js';
import { LocalExecutionSubstrate } from '../execution/local-substrate.js';
import { EphemeralScratchWorkspace } from '../sandbox/scratch-workspace.js';
import { StructuredTestReport, TestHarnessOptions } from './types.js';
import { TestOutputParser } from './test-output-parser.js';
import type { HypothesisTracker } from '../agent/hypothesis-tracker.js';
import type { HypothesisRollbackOrchestrator } from '../agent/hypothesis-rollback-orchestrator.js';
import type { CompletionEvidenceGate } from '../agent/completion-evidence.js';
import type { CriticGate } from '../agent/critic-gate.js';

export interface TestEngineeringHarnessConfig {
  workspaceRoot: string;
  substrate?: IExecutionSubstrate;
  hypothesisTracker?: HypothesisTracker;
  rollbackOrchestrator?: HypothesisRollbackOrchestrator;
  completionEvidenceGate?: CompletionEvidenceGate;
  criticGate?: CriticGate;
}

/**
 * TestEngineeringHarness - Bộ Khung Kỹ nghệ Kiểm thử Tự động (Codex Standard Test Harness)
 * 
 * Tích hợp chặt chẽ:
 * 1. Execution Substrate (Local / Sandboxed Compute Plane).
 * 2. Point-in-time Ephemeral Scratch Sandbox (Kiểm thử suy đoán phân lập).
 * 3. Hypothesis System (Tự động Validate khi pass, Falsify và Rollback khi fail).
 * 4. Completion Evidence Gate (Ghi nhận bằng chứng kiểm thử thực nghiệm để nghiệm thu CriticGate).
 */
export class TestEngineeringHarness {
  private workspaceRoot: string;
  private substrate: IExecutionSubstrate;
  private hypothesisTracker?: HypothesisTracker;
  private rollbackOrchestrator?: HypothesisRollbackOrchestrator;
  private completionEvidenceGate?: CompletionEvidenceGate;
  private criticGate?: CriticGate;

  constructor(config: TestEngineeringHarnessConfig) {
    this.workspaceRoot = path.resolve(config.workspaceRoot);
    this.substrate = config.substrate || new LocalExecutionSubstrate({ defaultCwd: this.workspaceRoot });
    this.hypothesisTracker = config.hypothesisTracker;
    this.rollbackOrchestrator = config.rollbackOrchestrator;
    this.completionEvidenceGate = config.completionEvidenceGate;
    this.criticGate = config.criticGate;
  }

  setHypothesisTracker(tracker: HypothesisTracker): void {
    this.hypothesisTracker = tracker;
  }

  setRollbackOrchestrator(orchestrator: HypothesisRollbackOrchestrator): void {
    this.rollbackOrchestrator = orchestrator;
  }

  setCompletionEvidenceGate(gate: CompletionEvidenceGate): void {
    this.completionEvidenceGate = gate;
  }

  setCriticGate(gate: CriticGate): void {
    this.criticGate = gate;
  }

  /**
   * Tự động phát hiện lệnh chạy test phù hợp nhất cho Repository
   */
  async detectTestCommand(): Promise<string> {
    try {
      const pkgPath = path.join(this.workspaceRoot, 'package.json');
      const pkgContent = await fs.readFile(pkgPath, 'utf-8').catch(() => null);
      if (pkgContent) {
        const pkg = JSON.parse(pkgContent);
        if (pkg.scripts && pkg.scripts.test) {
          return 'npm test';
        }
      }

      // Kiểm tra Python pytest
      const hasPytest = await fs.stat(path.join(this.workspaceRoot, 'pytest.ini')).catch(() => null);
      const hasTestsDir = await fs.stat(path.join(this.workspaceRoot, 'tests')).catch(() => null);
      if (hasPytest || hasTestsDir) {
        return 'pytest';
      }

      // Kiểm tra Rust Cargo
      const hasCargo = await fs.stat(path.join(this.workspaceRoot, 'Cargo.toml')).catch(() => null);
      if (hasCargo) {
        return 'cargo test';
      }

      // Kiểm tra Go
      const hasGo = await fs.stat(path.join(this.workspaceRoot, 'go.mod')).catch(() => null);
      if (hasGo) {
        return 'go test ./...';
      }
    } catch {}

    return 'npm test';
  }

  /**
   * Thực thi bộ kiểm thử (Test Suite) với phân tích dữ liệu có cấu trúc và liên kết bằng chứng
   */
  async runTests(options: TestHarnessOptions = {}): Promise<StructuredTestReport> {
    const testCommand = options.testCommand || await this.detectTestCommand();
    const timeoutMs = options.timeoutMs || 120000; // 2 phút mặc định cho test
    const startTime = Date.now();

    let rawStdout = '';
    let rawStderr = '';
    let exitCode = 0;
    let durationMs = 0;

    // 1. Thực thi trên Scratch Workspace hoặc Trực tiếp trên Substrate
    if (options.useScratchWorkspace) {
      const scratch = new EphemeralScratchWorkspace({
        sourceWorkspaceRoot: this.workspaceRoot,
        substrate: this.substrate,
      });

      try {
        await scratch.create();
        const execRes = await scratch.exec(testCommand, timeoutMs);
        rawStdout = execRes.stdout;
        rawStderr = execRes.stderr;
        exitCode = execRes.exitCode;
        durationMs = execRes.durationMs;
      } finally {
        await scratch.dispose();
      }
    } else {
      const execRes = await this.substrate.exec(testCommand, {
        cwd: this.workspaceRoot,
        timeoutMs,
        signal: options.signal,
      });
      rawStdout = execRes.stdout;
      rawStderr = execRes.stderr;
      exitCode = execRes.exitCode;
      durationMs = execRes.durationMs;
    }

    const fullOutput = rawStdout + (rawStderr ? `\n${rawStderr}` : '');
    const report = TestOutputParser.parse(fullOutput, exitCode, durationMs, testCommand);

    // 2. Tích hợp với Hypothesis System (Codex Scientific Loop)
    const activeHypothesisId = options.hypothesisId || this.hypothesisTracker?.getActiveHypothesis()?.id;
    if (activeHypothesisId && this.hypothesisTracker) {
      if (report.isPassed) {
        this.hypothesisTracker.markValidated(
          activeHypothesisId,
          `Xác minh thực nghiệm thành công: ${report.summaryText}`
        );
      } else {
        this.hypothesisTracker.markFalsified(
          activeHypothesisId,
          `Phản nghiệm thất bại: ${report.summaryText}`
        );

        // Kích hoạt tự động Rollback về trạng thái sạch nếu có Rollback Orchestrator
        if (this.rollbackOrchestrator) {
          await this.rollbackOrchestrator.rollbackOnFalsifiedHypothesis(
            activeHypothesisId,
            this.hypothesisTracker
          ).catch((err) => {
            console.warn(`[TestEngineeringHarness] Rollback error: ${err.message}`);
          });
        }
      }
    }

    return report;
  }

  async dispose(): Promise<void> {
    await this.substrate.dispose();
  }
}
