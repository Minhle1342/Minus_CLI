import { execFileSync } from 'node:child_process';
import { isVerificationCommand, isNonExecutableFile } from '../agent/completion-evidence.js';import { isSensitivePath, resolveVerifyTier } from '../agent/verify-tier-resolver.js';
import { evaluateVerificationCoverage, type VerificationCoverage } from '../agent/verification-coverage.js';
import type { FileCoverage } from '../agent/coverage-report-reader.js';
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
  /** Edge-case coverage of the executed command; absent when unevaluable. */
  coverage?: VerificationCoverage;
}

export function isScratchPath(filePath: string): boolean {
  const normalized = (filePath || '').trim().replace(/\\/g, '/').toLowerCase();
  return (
    normalized.startsWith('scratch/') ||
    normalized.startsWith('.scratch/') ||
    normalized.startsWith('temp/') ||
    normalized.startsWith('.temp/') ||
    /(?:^|[\\/])(?:scratch|throwaway|repro|reproduce)[_-][a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/i.test(normalized) ||
    /(?:^|[\\/])scratch[\\/]/i.test(normalized) ||
    /(?:^|[\\/])temp[\\/]/i.test(normalized)
  );
}

/** Heuristic comment-line check across common languages: slash-slash, hash, dash-dash, percent, semicolon, quote, html, block and star lines. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  return /^(?:\/\/|#|--|%|;|"|<!--)/.test(t)
    || /^\/\*/.test(t) || /^\*/.test(t) || /^\*\//.test(t) || /\*\/$/.test(t)
    || /-->$/.test(t) || /^('''|""")/.test(t);
}

/**
 * True when a replace-style edit changes only comments/blank lines.
 * Compares code lines (comments + blanks stripped); order-sensitive.
 * ponytail: line-based heuristic, not a parser — unknown syntax stays fail-closed (returns false).
 */
export function isCommentOnlyChange(oldText: string, newText: string): boolean {
  // ponytail: collapse intra-line whitespace runs (formatter noise); single-vs-none
  // spacing still differs, so `"a b"` vs `"ab"` stays fail-closed.
  const codeLines = (text: string) => String(text || '').split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => !isCommentLine(l));
  const a = codeLines(oldText);
  const b = codeLines(newText);
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

export class VerificationPolicy {
  private hasUnverifiedModifications: boolean = false;
  private modifiedFiles: Set<string> = new Set();
  private commentOnlyFiles: Set<string> = new Set();
  private contentPreservedFiles: Set<string> = new Set();
  private workspaceRoot?: string;
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

  /**
   * Signature-novelty repair budget (replaces blind counting): only failures
   * repeating the SAME error signature consume budget; a novel failure or a
   * success resets it. Never call this with LLM-declared values — the count
   * must come from ReflectionEngine.getSameSignatureFailStreak().
   */
  recordRepairAttempt(sameSignatureCount: number): void {
    this.repairCycles = sameSignatureCount >= 2 ? sameSignatureCount : 0;
  }

  private pendingTargetedTests: Set<string> = new Set();
  private hasReproductionProof: boolean = false;
  private reproductionProofCommand?: string;

  recordReproductionAttempt(command: string, hasFailedTest: boolean): void {
    if (hasFailedTest) {
      this.hasReproductionProof = true;
      this.reproductionProofCommand = command;
    }
  }

  hasReproduction(): boolean {
    return this.hasReproductionProof;
  }

  getReproductionCommand(): string | undefined {
    return this.reproductionProofCommand;
  }

  /**
   * Agentless & AutoCodeRover protocol + Dual-Agent Exploration Gating:
   * Bugfix tasks require a confirmed failing reproduction test (or Dual-Agent approved root-cause analysis)
   * before applying mutations to product code. Scratch/repro files are always allowed.
   */
  canMutate(
    taskClass?: string,
    gateMode: 'off' | 'observe' | 'enforce' = 'observe',
    options?: {
      targetFilePath?: string;
      isScratchFile?: boolean;
      criticApproved?: boolean;
      /** Classification risk (R0..R5 / LOW..CRITICAL). Missing = conservative enforce. */
      riskLevel?: string;
    },
  ): { allowed: boolean; reason?: string; advisory?: string } {
    if (gateMode === 'off') return { allowed: true };

    // Scratch files and reproduction test scripts are ALWAYS permitted for writing reproduction cases
    if (options?.isScratchFile || (options?.targetFilePath && isScratchPath(options.targetFilePath))) {
      return { allowed: true };
    }

    if (gateMode === 'enforce') {
      const isBugfixOrSecurity = taskClass === 'bugfix' || taskClass === 'security';
      if (isBugfixOrSecurity && !this.hasReproductionProof && !options?.criticApproved) {
        // Risk-tiered reproduction gate: a hand-written repro script is Verifier
        // Tax for low-risk fixes — downgrade to advisory and rely on the
        // existing test suite. Keep enforcing for HIGH/CRITICAL (or unknown risk).
        const risk = (options?.riskLevel || '').trim().toUpperCase();
        const highOrCritical = ['R3', 'R4', 'R5', 'HIGH', 'CRITICAL'].includes(risk);
        if (!options?.riskLevel || highOrCritical) {
          return {
            allowed: false,
            reason: 'REPRODUCTION_GATE_BLOCKED: Bugfix/security task requires a failing reproduction test execution (e.g. scratch/reproduce_*.py or failing unit test) or a Dual-Agent Verifier approved exploration analysis before modifying production code.',
          };
        }
        return {
          allowed: true,
          advisory: 'REPRODUCTION_GATE_ADVISORY: No dedicated reproduction script observed; proceeding is allowed at this risk tier, but run the existing test suite after the fix instead of writing a throwaway repro.',
        };
      }
    }
    return { allowed: true };
  }

  /**
   * Đánh dấu đã có thay đổi code trên workspace (write_file, replace_text, apply_patch, create_file, delete_file, move_file)
   */
  recordModification(filePath?: string, options?: { impactedTestSuites?: string[]; risk?: string; commentOnly?: boolean }): void {
    if (filePath) {
      this.modifiedFiles.add(filePath);
      if (options?.commentOnly) this.commentOnlyFiles.add(filePath);
      else {
        this.commentOnlyFiles.delete(filePath);
        this.contentPreservedFiles.delete(filePath);
      }
    }
    const isNonExec = filePath ? isNonExecutableFile(filePath) : false;
    const isSensitiveCode = filePath ? (!isNonExec && isSensitivePath(filePath)) : false;
    const isCommentBypass = Boolean(options?.commentOnly) && !isSensitiveCode;
    if (!filePath || (!isNonExec && !isCommentBypass) || isSensitiveCode || ['R3', 'R4', 'R5'].includes(this.requiredRisk)) {
      this.hasUnverifiedModifications = true;
      this.lastVerification = undefined;
      this.verificationHistory = [];
    }
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

  /** Workspace root for on-disk inert-change checks (net-zero diff, deleted scratch). No root = fail-closed. */
  setWorkspaceRoot(root: string): void {
    if (root?.trim()) this.workspaceRoot = root;
  }

  /**
   * Pure rename: content identical by construction (fs.rename).
   * ponytail: tracked-source deletion still shows in git, so both paths are marked
   * inert-by-record instead of relying on the disk check.
   */
  recordContentPreservedMove(sourcePath?: string, targetPath?: string): void {
    for (const f of [sourcePath, targetPath]) {
      if (!f?.trim()) continue;
      this.modifiedFiles.add(f);
      this.contentPreservedFiles.add(f);
    }
  }

  /**
   * Ghi nhận kết quả chạy lệnh kiểm thử / verify (run_command)
   */
  recordVerification(
    command: string,
    success: boolean,
    digest?: string,
    exitCode?: number,
    options?: { diffHash?: string; tier?: VerificationLadderTier; hasNewFailures?: boolean; stdout?: string; stderr?: string; fileCoverage?: FileCoverage[] | null; coverageSource?: string; coverageThreshold?: number },
  ): void {
    const isVerification = isVerificationCommand(command)
      || Boolean(options?.tier)
      || /\b(?:get_diagnostics|submit_solution)\b/i.test(command);
    // ponytail: single new standalone script run exit 0 counts as structural verification (R0 only, no pending suites).
    const isTrivialDirectRun = !isVerification && success && this.isTrivialDirectRunCommand(command);
    const effectiveSuccess = success && (isVerification || isTrivialDirectRun) && options?.hasNewFailures !== true;

    const tier = options?.tier || (isTrivialDirectRun ? 'structural' : this.inferTier(command));
    // Edge-case coverage is evaluated from harness-measured state only
    // (modified files, blast-impacted suites) — never LLM self-assessment.
    // Unevaluable runs yield 'unknown' and change nothing (fail-open).
    const coverage = (isVerification || isTrivialDirectRun)
      ? evaluateVerificationCoverage({
        command,
        success: effectiveSuccess,
        stdout: options?.stdout,
        stderr: options?.stderr,
        tier,
        tierExplicit: Boolean(options?.tier),
        modifiedFiles: Array.from(this.modifiedFiles),
        pendingSuites: Array.from(this.pendingTargetedTests),
        fileCoverage: options?.fileCoverage,
        coverageSource: options?.coverageSource,
        coverageThreshold: options?.coverageThreshold,
      })
      : undefined;

    this.lastVerification = {
      command,
      success: effectiveSuccess,
      timestamp: new Date().toISOString(),
      exitCode,
      digest,
      diffHash: options?.diffHash,
      tier,
      hasNewFailures: options?.hasNewFailures,
      ...(coverage ? { coverage } : {}),
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
   * Kiểm tra xem Agent có được phép kết thúc nhiệm vụ (Final Answer) hay chưa.
   * `measured` carries harness-measured impact (never LLM claims); when it
   * resolves to HIGH/CRITICAL the required tier is upgraded to a real
   * full_test pass regardless of the classification risk.
   */
  canComplete(
    activeSkillIds: string[] = [],
    measured?: { changedFileCount?: number; hasCallers?: boolean; blastRisk?: string; sensitivePathTouched?: boolean },
    options?: { userExemptsTesting?: boolean },
  ): { allowed: boolean; reason?: string; errorCode?: string } {
    // Miễn trừ kiểm thử bắt buộc nếu toàn bộ các file đã can thiệp là file phi thực thi (docs/markdown/configs)
    // hoặc chỉ sửa ghi chú/comment (không đổi code, không chạm sensitive path)
    const hasOnlyBypassableModifications =
      this.modifiedFiles.size > 0 &&
      ['R0', 'R1', 'R2'].includes(this.requiredRisk) &&
      Array.from(this.modifiedFiles).every((f) => isNonExecutableFile(f)
        || (this.commentOnlyFiles.has(f) && !isSensitivePath(f)));

    const mandatesVerification = (this.modifiedFiles.size > 0 && !hasOnlyBypassableModifications)
      || this.hasUnverifiedModifications
      || this.pendingTargetedTests.size > 0
      || activeSkillIds.some((id) => this.requiredSkills.has(id));

    if (!mandatesVerification) {
      return { allowed: true };
    }

    // #1: user nói rõ "không cần test" — mirror CompletionEvidenceGate (fail-open theo ý định explicit).
    if (options?.userExemptsTesting) {
      return { allowed: true };
    }

    // #2/#3/#4: net-zero diff, scratch đã xóa, rename giữ nguyên nội dung.
    if (this.hasOnlyInertChanges()) {
      return { allowed: true };
    }

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

    // Proven-empty runs (exit 0 but 0 tests executed) are not verification,
    // even though the shell reported success. Only the 'insufficient' verdict
    // blocks; 'unknown' (unparseable output) stays fail-open.
    if (mandatesVerification && this.lastVerification?.success && this.lastVerification.coverage?.verdict === 'insufficient') {
      const detail = this.lastVerification.coverage.findings[0] || 'The command executed 0 tests.';
      return {
        allowed: false,
        reason: `VERIFICATION_EMPTY: ${detail}`,
        errorCode: 'VERIFICATION_EMPTY',
      };
    }


    // Non-blocking: VERIFICATION_TIER_REQUIRED không còn chặn hoàn thành tác vụ.
    // Mọi bằng chứng xác minh thành công (diagnostics, typecheck, targeted test, lint, full_test)
    // đều cho phép hoàn thành.

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
          reason: `IMPACTED_TESTS_REQUIRED: Blast radius identified impacted test suite(s): ${pendingList.slice(0, 3).join(', ')}. Execute the impacted tests or full test suite before completion.${this.coverageGuidance()}`,
          errorCode: 'IMPACTED_TESTS_REQUIRED',
        };
      }
    }

    return { allowed: true };
  }

  /** Coverage detail appended to gate rejections so the LLM knows what to run. */
  private coverageGuidance(): string {
    const coverage = this.lastVerification?.coverage;
    if (!coverage || coverage.verdict === 'sufficient' || coverage.findings.length === 0) return '';
    return ` Coverage: ${coverage.findings[0]}`;
  }

  getLastVerification(): VerificationRecord | undefined {
    return this.lastVerification ? { ...this.lastVerification } : undefined;
  }

  getVerificationHistory(): readonly VerificationRecord[] {
    return [...this.verificationHistory];
  }

  reset(): void {
    this.hasUnverifiedModifications = false;
    this.modifiedFiles.clear();
    this.commentOnlyFiles.clear();
    this.contentPreservedFiles.clear();
    this.lastVerification = undefined;
    this.verificationHistory = [];
    this.repairCycles = 0;
    this.baselineManager.reset();
    this.requiredRisk = 'R0';
    this.hasReproductionProof = false;
    this.reproductionProofCommand = undefined;
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

  /**
   * ponytail: single new standalone script run exit 0 counts as structural verification.
   * Tight scope: exactly 1 modified file, R0, no pending suites, non-sensitive executable,
   * command directly executes that file (python/node/tsx/bun/deno). Multi-file, R1+,
   * sensitive-path and pending-suite cases still require a real test/build/lint/typecheck.
   */
  private isTrivialDirectRunCommand(command: string): boolean {
    if (this.modifiedFiles.size !== 1 || this.requiredRisk !== 'R0' || this.pendingTargetedTests.size > 0) return false;
    const file = Array.from(this.modifiedFiles)[0];
    if (isNonExecutableFile(file) || isSensitivePath(file)) return false;
    const base = file.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    if (!base || base.length < 3 || !command.toLowerCase().includes(base)) return false;
    return /^((python3?(\.exe)?|node|tsx|ts-node|bun|deno)\b|npx\s+(tsx|ts-node)\b)/i.test(command.trim());
  }

  /**
   * True when every tracked change is inert: docs/config, comment-only,
   * content-preserved rename, or no on-disk delta (reverted edit, deleted
   * scratch/untracked file). Disk check is lazy (only when record-level
   * exemptions don't cover) and fail-closed: no root or git error = not inert.
   * ponytail: git-ignored-but-existing files read as clean — acceptable, scratch
   * output is ephemeral by design; product code lives in tracked files.
   */
  private hasOnlyInertChanges(): boolean {
    if (this.modifiedFiles.size === 0 || !['R0', 'R1', 'R2'].includes(this.requiredRisk)) return false;
    const files = Array.from(this.modifiedFiles);
    const needsDiskCheck = files.filter((f) => !isNonExecutableFile(f)
      && !(this.commentOnlyFiles.has(f) && !isSensitivePath(f))
      && !this.contentPreservedFiles.has(f));
    if (needsDiskCheck.length === 0) return true;
    if (!this.workspaceRoot) return false;
    try {
      const out = execFileSync('git', ['status', '--porcelain', '--', ...needsDiskCheck], {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return String(out).trim() === '';
    } catch {
      return false;
    }
  }
}
