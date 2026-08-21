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
    this.lastVerification = {
      command,
      success,
      timestamp: new Date().toISOString(),
      exitCode,
      digest,
    };

    if (success) {
      this.hasUnverifiedModifications = false;
    }
  }

  /**
   * Kiểm tra xem Agent có được phép kết thúc nhiệm vụ (Final Answer) hay chưa
   */
  canComplete(activeSkillIds: string[] = []): { allowed: boolean; reason?: string } {
    const mandatesVerification = activeSkillIds.some((id) => this.requiredSkills.has(id));

    if (mandatesVerification && this.hasUnverifiedModifications) {
      return {
        allowed: false,
        reason: 'VERIFICATION_REQUIRED: Code was modified under a verification-mandating skill (TDD/Superpowers) but has not passed verification (test/build) yet.',
      };
    }

    if (this.lastVerification && !this.lastVerification.success && mandatesVerification) {
      return {
        allowed: false,
        reason: `VERIFICATION_FAILED: The last verification command '${this.lastVerification.command}' failed. Fix the issues before completing.`,
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
