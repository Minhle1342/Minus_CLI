import { isVerificationCommand } from '../agent/completion-evidence.js';

export interface VerificationRecord {
  command: string;
  success: boolean;
  timestamp: string;
  exitCode?: number;
  digest?: string;
}

export class VerificationPolicy {
  private hasUnverifiedModifications: boolean = false;
  private lastVerification?: VerificationRecord;
  private requiredSkills: Set<string> = new Set([
    'test-driven-development',
    'verification-before-completion',
    'finishing-a-development-branch',
  ]);

  /**
   * Đánh dấu đã có thay đổi code trên workspace (write_file, replace_text)
   */
  recordModification(filePath?: string): void {
    this.hasUnverifiedModifications = true;
  }

  /**
   * Ghi nhận kết quả chạy lệnh kiểm thử / verify (run_command)
   */
  recordVerification(command: string, success: boolean, digest?: string, exitCode?: number): void {
    const isVerification = isVerificationCommand(command);
    this.lastVerification = {
      command,
      success: success && isVerification,
      timestamp: new Date().toISOString(),
      exitCode,
      digest,
    };

    if (success && isVerification) {
      this.hasUnverifiedModifications = false;
    }
  }

  /**
   * Kiểm tra xem Agent có được phép kết thúc nhiệm vụ (Final Answer) hay chưa
   */
  canComplete(activeSkillIds: string[] = []): { allowed: boolean; reason?: string } {
    const mandatesVerification = this.hasUnverifiedModifications
      || activeSkillIds.some((id) => this.requiredSkills.has(id));

    if (mandatesVerification && !this.lastVerification) {
      return {
        allowed: false,
        reason: 'VERIFICATION_REQUIRED: This workflow requires a successful test/build/lint/typecheck observation before completion.',
      };
    }

    if (mandatesVerification && !this.lastVerification?.success) {
      return {
        allowed: false,
        reason: `VERIFICATION_FAILED: The last command '${this.lastVerification?.command || 'unknown'}' was not a successful verification command. Run a real test/build/lint/typecheck before completing.`,
      };
    }

    return { allowed: true };
  }

  getLastVerification(): VerificationRecord | undefined {
    return this.lastVerification ? { ...this.lastVerification } : undefined;
  }

  reset(): void {
    this.hasUnverifiedModifications = false;
    this.lastVerification = undefined;
  }
}
