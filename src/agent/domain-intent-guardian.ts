/**
 * Domain Intent & Specification Drift Guardian
 * Dựa trên các nghiên cứu:
 * - Meta AI: "Wink: Recovering from Misbehaviors in Coding Agents" (arXiv:2602.17037)
 * - SCAFFOLD-CEGIS (2026): Verifiable Hard Constraints & Plausible Patch Prevention
 * - CARE (Collaborative Agent Reasoning Engineering): Contract-Driven Semantic Grounding
 *
 * Chức năng cốt lõi:
 * 1. Contract-Driven Intent Anchoring & Freezing: Đóng băng mục tiêu và ràng buộc nghiệp vụ
 * 2. Wink-Style Specification Drift Detection: Phát hiện trôi dạt mục tiêu và sinh Course-Correction Guidance
 * 3. SCAFFOLD-CEGIS Test Tampering Auditor: Ngăn chặn sửa đổi file test hoặc làm biến chất Domain Invariants
 */

import { isMutationTool } from '../tools/diff-generator.js';
import { isScratchPath } from '../skills/verification-policy.js';
import fs from 'node:fs';
import path from 'node:path';
import { isUserExplicitlyExemptingTests } from './completion-evidence.js';

export interface DomainIntentContract {
  coreGoal: string;
  nonNegotiableConstraints: string[];
  domainInvariants: string[];
  allowTestFileModification: boolean;
  prohibitedMutations: string[];
  isFrozen: boolean;
  createdAt: number;
}

export interface DriftIntervention {
  type: 'GOAL_DRIFT' | 'TEST_TAMPERING' | 'CONSTRAINT_VIOLATION' | 'PLAUSIBLE_PATCH';
  severity: 'WARNING' | 'BLOCKING';
  message: string;
  courseCorrectionGuidance: string;
}

const TEST_FILE_PATTERNS = [
  /\.test\.[a-zA-Z0-9]+$/i,
  /\.spec\.[a-zA-Z0-9]+$/i,
  /_test\.[a-zA-Z0-9]+$/i,
  /test-[^/\\\\]+\.[a-zA-Z0-9]+$/i,
  /tests?[/\\\\]/i,
  /__tests__[/\\\\]/i,
];

export class DomainIntentGuardian {
  private contract: DomainIntentContract | null = null;
  private consecutiveDriftWarnings = 0;
  private blockedTamperAttempts = 0;

  constructor() {}

  /**
   * Phân tích và đóng băng Hợp đồng Ý định Nghiệp vụ (Contract-Driven Intent Grounding)
   */
  public extractAndFreezeContract(userRequest: string): DomainIntentContract {
    const lower = (userRequest || '').toLowerCase();

    // 1. Nhận diện quyền sửa file test hoặc bổ sung kiểm thử
    const forbidsTests = isUserExplicitlyExemptingTests(userRequest) || /(?:do not|don't|must not|never|không|khong|đừng|dung)\s+(?:modify|change|edit|delete|update|fix|write|add|create|sửa|sua|đổi|doi|xóa|xoa|viết|viet|thêm|them|tạo|tao)\s+(?:existing\s+|các\s+|cac\s+)?(?:tests?|kiểm thử|kiem thu)/iu.test(userRequest);
    const explicitlyAllowsTestModification = !forbidsTests && (
      lower.includes('update test') ||
      lower.includes('fix test') ||
      lower.includes('sửa test') ||
      lower.includes('viết test') ||
      lower.includes('write test') ||
      lower.includes('add test') ||
      lower.includes('create test') ||
      lower.includes('new test') ||
      lower.includes('bổ sung test') ||
      lower.includes('thêm test') ||
      lower.includes('tạo test') ||
      lower.includes('đồng bộ test') ||
      lower.includes('tdd') ||
      lower.includes('tdd'));

    // 2. Trích xuất Non-Negotiable Constraints
    const constraints: string[] = [];
    if (!explicitlyAllowsTestModification) {
      constraints.push('Do not arbitrarily modify or delete existing tests to force a pass');
    }
    if (lower.includes('backward compatibility') || lower.includes('tương thích ngược') || lower.includes('không phá vỡ')) {
      constraints.push('Must preserve backward compatibility — do not change public API signatures');
    }

    // Match các mệnh đề cấm đoán tiếng Anh & tiếng Việt
    const constraintRegexes = [
      /(?:không sửa|không đổi|do not modify|do not change|do not alter|must not change|must not alter|must not modify)\s+([^,;.]+)/gi,
      /(?:keep|giữ)\s+([^,;.]+)\s+(?:intact|unchanged|nguyên vẹn)/gi,
      /(?:do not|must not|không được)\s+([^,;.]+)/gi,
    ];

    for (const regex of constraintRegexes) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(userRequest)) !== null) {
        if (match[1]) {
          const phrase = match[1].trim();
          if (phrase.length >= 3 && !constraints.some((c) => c.toLowerCase().includes(phrase.toLowerCase()))) {
            constraints.push(`Preserve constraint: ${phrase}`);
          }
        }
      }
    }

    // 3. Trích xuất Domain Invariants
    const invariants: string[] = [];
    if (lower.includes('bảo mật') || lower.includes('security') || lower.includes('sql injection') || lower.includes('auth')) {
      invariants.push('Invariant: never use concatenated SQL queries or bypass auth checks');
    }
    if (lower.includes('tax') || lower.includes('thuế') || lower.includes('vat')) {
      invariants.push('Invariant: follow tax formulas and exemption conditions exactly');
    }

    // 4. Xác định Core Goal tóm lược (lọc bỏ lời chào hỏi và lấy ý định cốt lõi đa dòng)
    const cleanedRequest = userRequest
      .replace(/^(?:chào bạn|xin chào|hello|hi|hey|dear agent|bot ơi|em ơi|anh ơi)[,.:!\s]+/i, '')
      .trim();
    const requestLines = cleanedRequest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^(?:chào bạn|xin chào|hello|hi|hey)[,.:!\s]*$/i.test(l));
    const substantiveGoal = requestLines.slice(0, 4).join(' ').replace(/\s+/g, ' ').trim();
    const coreGoal = substantiveGoal.length > 250
      ? `${substantiveGoal.slice(0, 247)}...`
      : (substantiveGoal || userRequest.trim().slice(0, 250));

    this.contract = {
      coreGoal,
      nonNegotiableConstraints: constraints,
      domainInvariants: invariants,
      allowTestFileModification: explicitlyAllowsTestModification,
      prohibitedMutations: forbidsTests ? ['all test files'] : explicitlyAllowsTestModification ? [] : ['existing test files'],
      isFrozen: true,
      createdAt: Date.now(),
    };

    this.consecutiveDriftWarnings = 0;
    this.blockedTamperAttempts = 0;
    return this.contract;
  }

  public getContract(): DomainIntentContract | null {
    return this.contract;
  }

  public getAuditSummary(): { blockedTamperAttempts: number; consecutiveDriftWarnings: number } {
    return {
      blockedTamperAttempts: this.blockedTamperAttempts,
      consecutiveDriftWarnings: this.consecutiveDriftWarnings,
    };
  }

  public isTestFile(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/');
    return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  /**
   * Giám sát thao tác gọi công cụ để phát hiện Specification Drift & Test Tampering (SCAFFOLD-CEGIS)
   */
  public observeToolCall(toolCall: {
    toolName: string;
    args: Record<string, any>;
  }, options?: { workspaceRoot?: string }): DriftIntervention | null {
    if (!this.contract) return null;
    const { toolName, args } = toolCall;

    // 1. Kiểm tra Test Tampering khi sửa đổi file
    if (isMutationTool(toolName)) {
      const targetPath = (args.TargetFile || args.AbsolutePath || args.path || args.filePath || args.target_path || args.file_path || '').toString();
      const patchPaths = String(args.patch || args.Patch || args.patchText || '').split(/\r?\n/)
        .flatMap(line => /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)?.slice(1) || []);
      const targets = [targetPath, args.sourcePath, args.destinationPath, args.oldPath, args.newPath, ...patchPaths].filter(Boolean).map(String);

      // Cho phép tự do tạo scratch tests để thử nghiệm
      const testTargets = targets.filter(target => !isScratchPath(target) && this.isTestFile(target));
      const forbidden = testTargets[0];
      // New regression tests are permitted; existing assertions need explicit
      // authorization. Creating tests must never disguise replacing old tests.
      const createsNewTest = Boolean(forbidden && ['create_file', 'write_file', 'write_to_file'].includes(toolName)
        && options?.workspaceRoot && testTargets.every(target => {
          const absolute = path.resolve(options.workspaceRoot!, target);
          const relative = path.relative(options.workspaceRoot!, absolute);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
          try { fs.lstatSync(absolute); return false; }
          catch (error: any) { return error?.code === 'ENOENT'; }
        })) && !this.contract.prohibitedMutations.includes('all test files');
      if (forbidden && !createsNewTest && !this.contract.allowTestFileModification) {
        this.blockedTamperAttempts++;
        return {
          type: 'TEST_TAMPERING',
          severity: 'BLOCKING',
          message: `[SCAFFOLD-CEGIS: TEST TAMPERING BLOCKED] You are attempting to modify existing test file '${forbidden}' without authorization. Preserve existing assertions; add an independent regression test or request explicit scope to change this test.`,
          courseCorrectionGuidance: `Preserve existing assertions. Fix production logic and add an independent regression test where appropriate.`,
        };
      }
    }

    return null;
  }

  /**
   * Giám sát dòng suy luận (Thoughts) của Model để phát hiện Goal Substitution (Wink Meta AI)
   */
  public observeModelThoughts(thoughts: string): DriftIntervention | null {
    if (!this.contract || !thoughts) return null;
    const lower = thoughts.toLowerCase();

    // Dấu hiệu từ bỏ mục tiêu ban đầu để chọn phương án dễ hơn
    const goalSubstitutionTriggers = [
      'thay vì giải quyết',
      'thay vì sửa logic',
      'bỏ qua yêu cầu này',
      'tạm thời mock',
      'hardcode giá trị',
      'bỏ qua kiểm tra',
      'temporarily mock',
      'temporary mock',
      'mock the return',
      'mocking the',
      'bypass this',
      'skip this test',
      'skip this check',
      'instead of fixing',
      'skip this requirement',
      'hardcode the result',
      'hardcode the value',
      'cannot fix',
      'too complex to fix',
    ];

    for (const trigger of goalSubstitutionTriggers) {
      if (lower.includes(trigger)) {
        this.consecutiveDriftWarnings++;
        return {
          type: 'GOAL_DRIFT',
          severity: 'WARNING',
          message: `[SPECIFICATION DRIFT DETECTED (Wink Meta AI)]: The system detected signs that you are abandoning the original business goal ("${this.contract.coreGoal}").`,
          courseCorrectionGuidance: `Do not lower the bar or hardcode a fake solution. Mandatory business goal: "${this.contract.coreGoal}". Focus on solving the true root cause per the frozen business contract.`,
        };
      }
    }

    return null;
  }

  /**
   * Định dạng khối Hợp đồng Nghiệp vụ đóng băng để tiêm vào Prompt Context
   */
  public formatContractForPromptContext(): string {
    if (!this.contract) return '';
    const lines: string[] = [
      `🎯 [DOMAIN INTENT CONTRACT - FROZEN (WINK & CARE SPECIFICATION)]:`,
      `• Core Business Objective: "${this.contract.coreGoal}"`,
    ];

    if (this.contract.nonNegotiableConstraints.length > 0) {
      lines.push(`• Non-Negotiable Constraints:`);
      for (const c of this.contract.nonNegotiableConstraints) {
        lines.push(`  - 🔒 ${c}`);
      }
    }

    if (this.contract.domainInvariants.length > 0) {
      lines.push(`• Domain Invariants:`);
      for (const inv of this.contract.domainInvariants) {
        lines.push(`  - ⚖️ ${inv}`);
      }
    }

    if (!this.contract.allowTestFileModification) {
      lines.push(`• Preserve existing test assertions; modifying existing tests needs explicit authorization. Independent new regression tests may be added within task scope.`);
    }

    return lines.join('\n');
  }

  public reset(): void {
    this.contract = null;
    this.consecutiveDriftWarnings = 0;
    this.blockedTamperAttempts = 0;
  }
}
