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
import { spawnSync } from 'node:child_process';
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
  private agentCreatedTestFiles = new Set<string>();

  constructor() {}

  /**
   * Phân tích và đóng băng Hợp đồng Ý định Nghiệp vụ (Contract-Driven Intent Grounding)
   */
  public extractAndFreezeContract(userRequest: string): DomainIntentContract {
    const lower = (userRequest || '').toLowerCase();

    // 1. Nhận diện quyền sửa file test hoặc bổ sung kiểm thử
    // "keep/preserve assertions unchanged" = NGƯỢC LẠI với quyền sửa test: người dùng muốn bảo toàn assertions, không được động vào test.
    const preservesTests = /(?:keep|preserve|maintain|giữ|bảo toàn)\s+(?:existing\s+)?(?:test\s+)?(?:assertions?|tests?|kiểm thử)\s+(?:unchanged|intact|as is|nguyên vẹn|không đổi|khong doi)/i.test(userRequest);
    const forbidsTests = isUserExplicitlyExemptingTests(userRequest) || preservesTests || /(?:do not|don't|must not|never|không|khong|đừng|dung)\s+(?:modify|change|edit|delete|update|fix|write|add|create|sửa|sua|đổi|doi|xóa|xoa|viết|viet|thêm|them|tạo|tao)\s+(?:existing\s+|các\s+|cac\s+)?(?:tests?|kiểm thử|kiem thu)/iu.test(userRequest);
    const upgradeIntent = /(nâng cấp|nang cap|upgrade|update assertion|nâng cấp assertion)/i.test(userRequest)
      && /(test|assert|kiểm thử|kiem thu)/i.test(userRequest);
    const explicitlyAllowsTestModification = !forbidsTests && (
      upgradeIntent ||
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
      lower.includes('update assertion') ||
      lower.includes('upgrade test') ||
      lower.includes('update test file') ||
      lower.includes('modify test') ||
      lower.includes('change test') ||
      lower.includes('sửa file test') ||
      lower.includes('sửa đổi test') ||
      ((lower.includes('nâng cấp') || lower.includes('nang cap') ||
        lower.includes('assertion') || lower.includes('expected')) &&
        (lower.includes('test') || lower.includes('assert') ||
          lower.includes('kiểm thử') || lower.includes('kiem thu'))) ||
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
    this.agentCreatedTestFiles.clear();
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

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase().trim();
  }

  /**
   * Đánh dấu file test được tạo bởi Agent trong phiên làm việc hiện tại
   */
  public recordAgentCreatedFile(filePath: string): void {
    if (!filePath) return;
    this.agentCreatedTestFiles.add(this.normalizePath(filePath));
  }

  /**
   * Kiểm tra xem file test có nguồn gốc từ Agent hay từ commit gốc của con người
   */
  public isAgentCreatedTestFile(filePath: string, workspaceRoot?: string): boolean {
    if (!filePath) return false;
    const normalized = this.normalizePath(filePath);
    if (this.agentCreatedTestFiles.has(normalized)) return true;
    for (const created of this.agentCreatedTestFiles) {
      if (normalized.endsWith(created) || created.endsWith(normalized)) return true;
    }
    if (workspaceRoot) {
      try {
        const abs = path.resolve(workspaceRoot, filePath);
        const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
        const gitDir = path.join(workspaceRoot, '.git');
        if (fs.existsSync(gitDir) && rel && !rel.startsWith('..')) {
          const res = spawnSync('git', ['cat-file', '-e', `HEAD:${rel}`], {
            cwd: workspaceRoot,
            stdio: 'ignore',
            windowsHide: true,
          });
          // Mã thoát != 0 chứng minh file chưa từng tồn tại trong commit gốc của con người (HEAD)
          if (res.status !== 0) {
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  /**
   * Trích xuất số lượng assertions hoạt động (active) và assertions bị comment out
   */
  public extractAssertionStats(code: string): { active: number; commented: number } {
    if (!code || typeof code !== 'string') return { active: 0, commented: 0 };

    const lines = code.split(/\r?\n/);
    let active = 0;
    let commented = 0;
    let inBlockComment = false;

    const assertPattern = /\b(?:assert(?:\.[a-zA-Z0-9_$]+|\s*\()|expect(?:\.[a-zA-Z0-9_$]+|\s*\()|should(?:\.[a-zA-Z0-9_$]+)?|self\.assert[a-zA-Z0-9_]*\s*\(|t\.(?:Error|Fatal)[a-zA-Z0-9_]*\s*\(|ASSERT_[A-Z0-9_]+\s*\(|EXPECT_[A-Z0-9_]+\s*\(|assert!\s*\(|assert_eq!\s*\(|assert_ne!\s*\()/i;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (inBlockComment) {
        if (assertPattern.test(trimmed)) commented++;
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }

      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        if (assertPattern.test(trimmed)) commented++;
        continue;
      }

      if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        if (assertPattern.test(trimmed)) commented++;
        continue;
      }

      const inlineCommentMatch = /\/\/|#/.exec(trimmed);
      let codePart = trimmed;
      let commentPart = '';
      if (inlineCommentMatch) {
        codePart = trimmed.slice(0, inlineCommentMatch.index);
        commentPart = trimmed.slice(inlineCommentMatch.index);
      }

      if (commentPart && assertPattern.test(commentPart)) {
        commented++;
      }

      if (codePart && assertPattern.test(codePart)) {
        const matches = codePart.match(new RegExp(assertPattern.source, 'gi')) || [];
        active += matches.length;
      }
    }

    return { active, commented };
  }

  /**
   * Phân tích độ mạnh của Assert: Cho phép sửa nếu số lượng assert tăng lên hoặc tương đương,
   * chỉ chặn khi Agent cố tình comment out hoặc xóa bớt assert.
   */
  public checkAssertionStrength(
    toolName: string,
    args: Record<string, any>,
    targetFile: string,
    workspaceRoot?: string
  ): { isTampering: boolean; reason: string; oldAsserts: number; newAsserts: number } {
    let oldCode = '';
    let newCode = '';

    if (toolName === 'replace_file_content' || toolName === 'replace_text') {
      oldCode = String(args.TargetContent ?? args.oldText ?? '');
      newCode = String(args.ReplacementContent ?? args.newText ?? '');
    } else if (toolName === 'multi_replace_file_content') {
      const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
      oldCode = chunks.map((c: any) => c.TargetContent ?? '').join('\n');
      newCode = chunks.map((c: any) => c.ReplacementContent ?? '').join('\n');
    } else if (toolName === 'apply_patch') {
      const patchText = String(args.patch || args.Patch || args.patchText || '');
      const lines = patchText.split(/\r?\n/);
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('-') && !line.startsWith('---')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          newLines.push(line.slice(1));
        }
      }
      oldCode = oldLines.join('\n');
      newCode = newLines.join('\n');
    } else if (['write_file', 'write_to_file'].includes(toolName)) {
      newCode = String(args.content ?? args.CodeContent ?? '');
      if (workspaceRoot) {
        const absPath = path.resolve(workspaceRoot, targetFile);
        try {
          if (fs.existsSync(absPath)) {
            oldCode = fs.readFileSync(absPath, 'utf8');
          }
        } catch {}
      }
    } else if (toolName === 'delete_file') {
      oldCode = 'assert(true);';
      newCode = '';
    }

    const oldStats = this.extractAssertionStats(oldCode);
    const newStats = this.extractAssertionStats(newCode);

    // 1. Chặn hành vi cố tình comment out assertions
    if (newStats.commented > oldStats.commented) {
      return {
        isTampering: true,
        reason: `Commented out assertion detected (${newStats.commented} commented assertion(s))`,
        oldAsserts: oldStats.active,
        newAsserts: newStats.active,
      };
    }

    // 2. Chặn hành vi xóa bớt assertions
    if (oldStats.active > 0 && newStats.active < oldStats.active) {
      return {
        isTampering: true,
        reason: `Assertion count decreased from ${oldStats.active} to ${newStats.active}`,
        oldAsserts: oldStats.active,
        newAsserts: newStats.active,
      };
    }

    return {
      isTampering: false,
      reason: 'Assertions preserved or strengthened',
      oldAsserts: oldStats.active,
      newAsserts: newStats.active,
    };
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

      // Ghi nhận nguồn gốc file: phát hiện các file test mới được tạo bởi Agent
      const createsNewTest = Boolean(forbidden && ['create_file', 'write_file', 'write_to_file'].includes(toolName)
        && options?.workspaceRoot && testTargets.every(target => {
          const absolute = path.resolve(options.workspaceRoot!, target);
          const relative = path.relative(options.workspaceRoot!, absolute);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
          try { fs.lstatSync(absolute); return false; }
          catch (error: any) { return error?.code === 'ENOENT'; }
        })) && !this.contract.prohibitedMutations.includes('all test files');

      if (createsNewTest) {
        for (const t of testTargets) {
          this.recordAgentCreatedFile(t);
          if (options?.workspaceRoot) {
            const rel = path.relative(options.workspaceRoot, path.resolve(options.workspaceRoot, t));
            this.recordAgentCreatedFile(rel);
          }
        }
      }

      // Ghi nhận file test được thêm mới từ patch
      const addedPatchPaths = String(args.patch || args.Patch || args.patchText || '').split(/\r?\n/)
        .flatMap(line => /^\*\*\* Add File: (.+)$/.exec(line)?.slice(1) || []);
      for (const added of addedPatchPaths) {
        if (this.isTestFile(added)) {
          this.recordAgentCreatedFile(added);
          if (options?.workspaceRoot) {
            const rel = path.relative(options.workspaceRoot, path.resolve(options.workspaceRoot, added));
            this.recordAgentCreatedFile(rel);
          }
        }
      }

      if (forbidden) {
        // Provenance-aware ƯU TIÊN CAO NHẤT: file test do chính Agent sinh ra trong phiên
        // không thuộc "existing tests" của con người mà hợp đồng bảo vệ, nên quyền sửa của Agent
        // không thể bị thu hồi kể cả với contract cấm tuyệt đối (case 2c & 2b trong test #52).
        const isAgentCreated = createsNewTest || this.isAgentCreatedTestFile(forbidden, options?.workspaceRoot);
        if (isAgentCreated) {
          return null;
        }

        if (this.contract.prohibitedMutations.includes('all test files')) {
          // "keep existing test assertions unchanged" chỉ cấm SỬA/ẨN/bớt assertions của test hiện có
          // (tampering thật), không cấm việc BỔ SUNG assert — thêm bảo vệ không phải là phá rào.
          const check = this.checkAssertionStrength(toolName, args, forbidden, options?.workspaceRoot);
          if (!check.isTampering) {
            return null;
          }
          this.blockedTamperAttempts++;
          return {
            type: 'TEST_TAMPERING',
            severity: 'BLOCKING',
            message: `[SCAFFOLD-CEGIS: TEST TAMPERING BLOCKED] Modifying test files is explicitly prohibited by contract.`,
            courseCorrectionGuidance: `Preserve existing assertions. Fix production logic instead.`,
          };
        }

        // Nếu người dùng đã cho phép sửa test thì không chặn
        if (this.contract.allowTestFileModification) {
          return null;
        }

        // Assertion Strength Check: Cho phép sửa nếu số lượng assert tăng lên hoặc tương đương,
        // chỉ chặn khi Agent cố tình comment out hoặc xóa bớt assert.
        const strengthCheck = this.checkAssertionStrength(toolName, args, forbidden, options?.workspaceRoot);
        if (strengthCheck.isTampering) {
          this.blockedTamperAttempts++;
          return {
            type: 'TEST_TAMPERING',
            severity: 'BLOCKING',
            message: `[SCAFFOLD-CEGIS: TEST TAMPERING BLOCKED] You are attempting to modify existing test file '${forbidden}' without authorization (${strengthCheck.reason}). Preserve existing assertions; add an independent regression test or request explicit scope to change this test.`,
            courseCorrectionGuidance: `Preserve existing assertions. Fix production logic and add an independent regression test where appropriate.`,
          };
        }
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
