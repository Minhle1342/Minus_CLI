import { isVerificationCommand } from '../agent/completion-evidence.js';
import { VerificationBaselineManager, type BaselineSnapshot } from './verification-baseline.js';
import type { ControlRisk } from '../control/classification-types.js';

export type VerificationLadderTier =
  | 'structural'
  | 'diff'
  | 'diagnostics'
  | 'typecheck'
  | 'targeted_test'
  | 'full_test'
  | 'build';

export interface VerificationRecord {
  command: string;
  success: boolean;
  timestamp: string;
  exitCode?: number;
  digest?: string;
  diffHash?: string;
  tier?: VerificationLadderTier;
  hasNewFailures?: boolean;
}

export class VerificationPolicy {
  private hasUnverifiedModifications: boolean = false;
  private lastVerification?: VerificationRecord;
  private verificationHistory: VerificationRecord[] = [];
  private repairCycles: number = 0;
  private readonly maxRepairCycles: number = 3;
  private baselineManager: VerificationBaselineManager = new VerificationBaselineManager();
  private requiredRisk: ControlRisk = 'R0';

  private requiredSkills: Set<string> = new Set([
    'test-driven-development',
    'verification-before-completion',
    'finishing-a-development-branch',
  ]);

  getBaselineManager(): VerificationBaselineManager {
    return this.baselineManager;
  }

  getRepairCycles(): number {
    return this.repairCycles;
  }

  isRepairExhausted(): boolean {
    return this.repairCycles >= this.maxRepairCycles;
  }

  incrementRepairCycle(): number {
    this.repairCycles++;
    return this.repairCycles;
  }

  private pendingTargetedTests: Set<string> = new Set();

  /**
   * Đánh dấu đã có thay đổi code trên workspace (write_file, replace_text, apply_patch, create_file, delete_file, move_file)
   */
  recordModification(filePath?: string, options?: { impactedTestSuites?: string[]; risk?: string }): void {
    this.hasUnverifiedModifications = true;
    if (options?.impactedTestSuites) {
      for (const t of options.impactedTestSuites) {
        this.pendingTargetedTests.add(t);
      }
    }
  }

  getPendingTargetedTests(): string[] {
    return Array.from(this.pendingTargetedTests);
  }

  clearPendingTargetedTests(): void {
    this.pendingTargetedTests.clear();
  }

  hasPendingModifications(): boolean {
    return this.hasUnverifiedModifications;
  }

  setRequiredRisk(risk: ControlRisk): void {
    const rank: ControlRisk[] = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];
    if (rank.indexOf(risk) > rank.indexOf(this.requiredRisk)) this.requiredRisk = risk;
  }

  /**
   * Ghi nhận kết quả chạy lệnh kiểm thử / verify (run_command)
   */
  recordVerification(
    command: string,
    success: boolean,
    digest?: string,
    exitCode?: number,
    options?: { diffHash?: string; tier?: VerificationLadderTier; hasNewFailures?: boolean },
  ): void {
    const isVerification = isVerificationCommand(command)
      || Boolean(options?.tier)
      || /\b(?:get_diagnostics|submit_solution)\b/i.test(command);
    const effectiveSuccess = success && isVerification && options?.hasNewFailures !== true;

    this.lastVerification = {
      command,
      success: effectiveSuccess,
      timestamp: new Date().toISOString(),
      exitCode,
      digest,
      diffHash: options?.diffHash,
      tier: options?.tier || this.inferTier(command),
      hasNewFailures: options?.hasNewFailures,
    };

    this.verificationHistory.push(this.lastVerification);

    if (effectiveSuccess) {
      if (this.pendingTargetedTests.size > 0) {
        const tier = options?.tier || this.inferTier(command);
        if (tier === 'full_test' || tier === 'build') {
          this.pendingTargetedTests.clear();
          this.hasUnverifiedModifications = false;
        } else {
          for (const t of Array.from(this.pendingTargetedTests)) {
            if (command.includes(t) || t.includes(command)) {
              this.pendingTargetedTests.delete(t);
            }
          }
          if (this.pendingTargetedTests.size === 0) {
            this.hasUnverifiedModifications = false;
          }
        }
      } else {
        this.hasUnverifiedModifications = false;
      }
    }
  }

  /**
   * Kiểm tra xem Agent có được phép kết thúc nhiệm vụ (Final Answer) hay chưa
   */
  canComplete(activeSkillIds: string[] = []): { allowed: boolean; reason?: string; errorCode?: string } {
    const mandatesVerification = this.hasUnverifiedModifications
      || this.pendingTargetedTests.size > 0
      || activeSkillIds.some((id) => this.requiredSkills.has(id));

    if (mandatesVerification && !this.lastVerification) {
      return {
        allowed: false,
        reason: 'VERIFICATION_REQUIRED: This workflow requires a successful test/build/lint/typecheck observation before completion.',
        errorCode: 'VERIFICATION_REQUIRED',
      };
    }

    if (mandatesVerification && !this.lastVerification?.success) {
      return {
        allowed: false,
        reason: `VERIFICATION_FAILED: The last command '${this.lastVerification?.command || 'unknown'}' was not a successful verification command. Run a real test/build/lint/typecheck before completing.`,
        errorCode: 'VERIFICATION_FAILED',
      };
    }


    if (mandatesVerification && this.lastVerification) {
      const tierRank: VerificationLadderTier[] = ['structural', 'diff', 'diagnostics', 'typecheck', 'targeted_test', 'full_test', 'build'];
      const minimum = this.requiredRisk === 'R0' ? 'structural'
        : this.requiredRisk === 'R1' ? 'diagnostics'
          : this.requiredRisk === 'R2' ? 'typecheck'
            : 'full_test';
      if (tierRank.indexOf(this.lastVerification.tier || 'structural') < tierRank.indexOf(minimum)) {
        return {
          allowed: false,
          reason: `VERIFICATION_TIER_REQUIRED: Risk ${this.requiredRisk} requires ${minimum} or stronger evidence.`,
          errorCode: 'VERIFICATION_TIER_REQUIRED',
        };
      }
    }

    if (mandatesVerification && this.pendingTargetedTests.size > 0) {
      const pendingList = Array.from(this.pendingTargetedTests);
      const hasMatchingTest = this.verificationHistory.some((v) => {
        if (!v.success) return false;
        if (v.tier === 'full_test' || v.tier === 'build') return true;
        return pendingList.some((t) => v.command.includes(t) || t.includes(v.command));
      });
      if (!hasMatchingTest) {
        return {
          allowed: false,
          reason: `IMPACTED_TESTS_REQUIRED: Blast radius identified impacted test suite(s): ${pendingList.slice(0, 3).join(', ')}. Execute the impacted tests or full test suite before completion.`,
          errorCode: 'IMPACTED_TESTS_REQUIRED',
        };
      }
    }

    return { allowed: true };
  }

  getLastVerification(): VerificationRecord | undefined {
    return this.lastVerification ? { ...this.lastVerification } : undefined;
  }

  getVerificationHistory(): readonly VerificationRecord[] {
    return [...this.verificationHistory];
  }

  reset(): void {
    this.hasUnverifiedModifications = false;
    this.lastVerification = undefined;
    this.verificationHistory = [];
    this.repairCycles = 0;
    this.baselineManager.reset();
    this.requiredRisk = 'R0';
  }

  private inferTier(command: string): VerificationLadderTier {
    if (/\b(?:build|compile)\b/i.test(command)) return 'build';
    if (/\b(?:run_test_suite|vitest|jest|mocha|ava|test|pytest|cargo\s+test|dotnet\s+test|go\s+test)\b/i.test(command)) {
      return /(?:--runInBand|--filter|--testNamePattern|\btest\s+[^\s-]|\bvitest\s+run\s+[^\s-]|\bjest\s+[^\s-]|\b(?:run\s+)?[a-zA-Z0-9_./-]+\.(?:spec|test)\.[cm]?[jt]sx?)/i.test(command) ? 'targeted_test' : 'full_test';
    }
    if (/\b(?:tsc|typecheck|get_diagnostics)\b/i.test(command)) return 'typecheck';
    if (/\b(?:lint|diagnostic)\b/i.test(command)) return 'diagnostics';
    return 'structural';
  }
}
