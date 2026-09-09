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

    // 1. Nhận diện quyền sửa file test
    const explicitlyAllowsTestModification =
      lower.includes('update test') ||
      lower.includes('fix test') ||
      lower.includes('sửa test') ||
      lower.includes('viết test') ||
      lower.includes('write test') ||
      lower.includes('add test') ||
      lower.includes('test-suite') ||
      lower.includes('test suite');

    // 2. Trích xuất Non-Negotiable Constraints
    const constraints: string[] = [];
    if (!explicitlyAllowsTestModification) {
      constraints.push('Không được tự tiện sửa đổi hoặc xóa các bài test hiện có để ép pass test');
    }
    if (lower.includes('backward compatibility') || lower.includes('tương thích ngược') || lower.includes('không phá vỡ')) {
      constraints.push('Bắt buộc bảo toàn tương thích ngược (Backward Compatibility), không thay đổi public API signatures');
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
            constraints.push(`Bảo toàn ràng buộc: ${phrase}`);
          }
        }
      }
    }

    // 3. Trích xuất Domain Invariants
    const invariants: string[] = [];
    if (lower.includes('bảo mật') || lower.includes('security') || lower.includes('sql injection') || lower.includes('auth')) {
      invariants.push('Nguyên tắc bất biến: Tuyệt đối không dùng concatenated SQL query hay bypass auth checks');
    }
    if (lower.includes('tax') || lower.includes('thuế') || lower.includes('vat')) {
      invariants.push('Nguyên tắc bất biến: Tuân thủ chính xác công thức và điều kiện miễn giảm thuế');
    }

    // 4. Xác định Core Goal tóm lược
    const firstLine = userRequest.split('\n')[0].trim();
    const coreGoal = firstLine.length > 150 ? `${firstLine.slice(0, 147)}...` : firstLine;

    this.contract = {
      coreGoal,
      nonNegotiableConstraints: constraints,
      domainInvariants: invariants,
      allowTestFileModification: explicitlyAllowsTestModification,
      prohibitedMutations: explicitlyAllowsTestModification ? [] : ['test files'],
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
  }): DriftIntervention | null {
    if (!this.contract) return null;
    const { toolName, args } = toolCall;

    // 1. Kiểm tra Test Tampering khi sửa đổi file
    if (isMutationTool(toolName)) {
      const targetPath = (args.TargetFile || args.AbsolutePath || args.path || args.target_path || args.file_path || '').toString();

      if (targetPath && this.isTestFile(targetPath) && !this.contract.allowTestFileModification) {
        this.blockedTamperAttempts++;
        return {
          type: 'TEST_TAMPERING',
          severity: 'BLOCKING',
          message: `[SCAFFOLD-CEGIS: TEST TAMPERING BLOCKED] Bạn đang cố gắng sửa đổi file test '${targetPath}'. Yêu cầu nghiệp vụ ban đầu không cho phép sửa đổi test suite để ép pass.`,
          courseCorrectionGuidance: `Dừng việc sửa file test! Hãy sửa mã nguồn logic nghiệp vụ thực tế trong src/ để thỏa mãn các điều kiện kiểm thử của bài test.`,
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
          message: `[SPECIFICATION DRIFT DETECTED (Wink Meta AI)]: Hệ thống phát hiện bạn có dấu hiệu từ bỏ mục tiêu nghiệp vụ ban đầu ("${this.contract.coreGoal}").`,
          courseCorrectionGuidance: `Tuyệt đối không hạ thấp tiêu chuẩn hoặc hardcode giải pháp giả tạo. Mục tiêu nghiệp vụ bắt buộc: "${this.contract.coreGoal}". Hãy tập trung giải quyết đúng nguyên nhân gốc theo đúng hợp đồng nghiệp vụ đã đóng băng.`,
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
      lines.push(`• Strict Anti-Tampering: Modifying existing test files is FORBIDDEN. Fix the business logic, not the tests.`);
    }

    return lines.join('\n');
  }

  public reset(): void {
    this.contract = null;
    this.consecutiveDriftWarnings = 0;
    this.blockedTamperAttempts = 0;
  }
}
