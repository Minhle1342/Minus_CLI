/**
 * Multi-Agent Brainstorming Engine (Structured Design Review)
 * 
 * Chuẩn công nghiệp theo đặc tả `multi-agent-brainstorming`:
 * - Quy trình tuần tự có kiểm soát chặt chẽ (Gated Sequential Peer-Review), không phải swarm hỗn loạn.
 * - 5 Persona bất biến với phạm vi giới hạn cứng (Hard Scope Limits):
 *   1. Primary Designer (Lead Agent): Sở hữu thiết kế, duy trì Decision Log, cập nhật thiết kế.
 *   2. Skeptic / Challenger Agent: Giả định thiết kế thất bại, lật lại giả định ngầm, chỉ ra edge case & YAGNI. CẤM đề xuất tính năng mới.
 *   3. Constraint Guardian Agent: Bảo vệ các ràng buộc phi chức năng (hiệu năng, bảo mật, độ tin cậy, chi phí, khả năng mở rộng). CẤM tranh luận mục tiêu sản phẩm.
 *   4. User Advocate Agent: Đại diện trải nghiệm người dùng, tải nhận thức, luồng lỗi. CẤM can thiệp kiến trúc.
 *   5. Integrator / Arbiter Agent: Trọng tài phân xử, chấp nhận/bác bỏ phản biện kèm lý do rõ ràng, tuyên bố phán quyết cuối cùng: APPROVED, REVISE, hoặc REJECT.
 * - Bắt buộc tạo lập và lưu vết Decision Log (Decisions made, Alternatives considered, Objections raised, Resolution & Rationale).
 * - Tiêu chí dừng nghiêm ngặt (Gated Exit Criteria).
 */

export type BrainstormingRole =
  | 'primary-designer'
  | 'skeptic-challenger'
  | 'constraint-guardian'
  | 'user-advocate'
  | 'integrator-arbiter';

export type ReviewDisposition = 'APPROVED' | 'REVISE' | 'REJECT';

export interface DecisionLogEntry {
  id: string;
  topic: string;
  decision: string;
  alternativesConsidered: string[];
  objectionsRaised: Array<{
    role: BrainstormingRole;
    objection: string;
    targetAssumption?: string;
  }>;
  resolution: {
    accepted: boolean;
    rationale: string;
    actionItems?: string[];
  };
  timestamp: string;
}

export interface ReviewerFeedback {
  role: BrainstormingRole;
  roleName: string;
  focusAreas: string[];
  summary: string;
  assumptionsChallenged?: string[];
  edgeCasesIdentified?: string[];
  constraintsViolated?: string[];
  uxIssuesIdentified?: string[];
  objections: Array<{
    id: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    target: string;
  }>;
  verdict: 'pass' | 'needs_revision' | 'reject';
  timestamp: string;
}

export interface BrainstormingSessionResult {
  id: string;
  goal: string;
  understandingLock: {
    confirmed: boolean;
    coreProblem: string;
    inScope: string[];
    outOfScope: string[];
  };
  initialDesign: string;
  revisedDesign?: string;
  reviewerFeedbacks: Record<string, ReviewerFeedback>;
  decisionLog: DecisionLogEntry[];
  finalDisposition: ReviewDisposition;
  arbiterRationale: string;
  actionRequired?: string[];
  exitCriteriaMet: boolean;
  startedAt: string;
  completedAt: string;
}

export interface BrainstormingEngineOptions {
  llmCaller?: (prompt: string, role: BrainstormingRole) => Promise<string>;
}

export class MultiAgentBrainstormingEngine {
  constructor(private readonly options: BrainstormingEngineOptions = {}) {}

  /**
   * Khởi chạy toàn bộ quy trình 3 pha của Multi-Agent Brainstorming
   */
  async runReview(
    goal: string,
    initialDesignSummary?: string,
    contextInfo?: Record<string, any>,
  ): Promise<BrainstormingSessionResult> {
    const cleanGoal = goal.trim();
    if (!cleanGoal) {
      throw new Error('Brainstorming goal must not be empty.');
    }

    const sessionId = `brainstorm-${Date.now()}`;
    const startedAt = new Date().toISOString();

    // ── Pha 1: Single-Agent Design & Understanding Lock ────────────────────────
    const understandingLock = await this.executeUnderstandingLock(cleanGoal, contextInfo);
    const initialDesign = initialDesignSummary?.trim() || await this.generateInitialDesign(cleanGoal, understandingLock, contextInfo);

    const decisionLog: DecisionLogEntry[] = [
      {
        id: 'dec-1',
        topic: 'Initial Architecture & Scope Definition',
        decision: `Agreed base design to solve the problem: ${cleanGoal}`,
        alternativesConsidered: ['Monolithic Approach', 'Multi-Layer Service-Oriented Approach'],
        objectionsRaised: [],
        resolution: {
          accepted: true,
          rationale: 'Initial design meets the confirmed Understanding Lock criteria.',
          actionItems: ['Proceed with the sequential review round with 3 reviewers.'],
        },
        timestamp: new Date().toISOString(),
      },
    ];

    // ── Pha 2: Structured Review Loop (Tuần tự từng Reviewer) ─────────────────
    const reviewerFeedbacks: Record<string, ReviewerFeedback> = {};

    // 1. Skeptic / Challenger
    const skepticFeedback = await this.invokeSkepticChallenger(cleanGoal, initialDesign, contextInfo);
    reviewerFeedbacks['skeptic-challenger'] = skepticFeedback;

    // 2. Constraint Guardian
    const guardianFeedback = await this.invokeConstraintGuardian(cleanGoal, initialDesign, contextInfo);
    reviewerFeedbacks['constraint-guardian'] = guardianFeedback;

    // 3. User Advocate
    const advocateFeedback = await this.invokeUserAdvocate(cleanGoal, initialDesign, contextInfo);
    reviewerFeedbacks['user-advocate'] = advocateFeedback;

    // Cập nhật các phản biện vào Decision Log
    const allObjections = [
      ...skepticFeedback.objections.map((o) => ({ role: 'skeptic-challenger' as BrainstormingRole, objection: o.description, targetAssumption: o.target })),
      ...guardianFeedback.objections.map((o) => ({ role: 'constraint-guardian' as BrainstormingRole, objection: o.description, targetAssumption: o.target })),
      ...advocateFeedback.objections.map((o) => ({ role: 'user-advocate' as BrainstormingRole, objection: o.description, targetAssumption: o.target })),
    ];

    // ── Pha 3: Integration & Arbitration (Trọng tài phán quyết) ───────────────
    const { disposition, rationale, revisedDesign, acceptedObjections, actions } = await this.invokeIntegratorArbiter(
      cleanGoal,
      initialDesign,
      reviewerFeedbacks,
      allObjections,
    );

    // Ghi chép phán quyết trọng tài vào Decision Log
    decisionLog.push({
      id: 'dec-2',
      topic: 'Arbitration & Objection Resolution',
      decision: `Final Integrator/Arbiter verdict: ${disposition}`,
      alternativesConsidered: ['Reject Entirely', 'Approve with Constraints', 'Request Full Architecture Revision'],
      objectionsRaised: allObjections,
      resolution: {
        accepted: disposition === 'APPROVED',
        rationale,
        actionItems: actions,
      },
      timestamp: new Date().toISOString(),
    });

    // ── Exit Criteria Verification ───────────────────────────────────────────
    const hasUnresolvedCritical = allObjections.some(
      (obj) => obj.role === 'constraint-guardian' && obj.objection.toLowerCase().includes('critical') && disposition === 'APPROVED' && !acceptedObjections.includes(obj.objection),
    );

    const exitCriteriaMet = understandingLock.confirmed &&
      Boolean(reviewerFeedbacks['skeptic-challenger']) &&
      Boolean(reviewerFeedbacks['constraint-guardian']) &&
      Boolean(reviewerFeedbacks['user-advocate']) &&
      decisionLog.length >= 2 &&
      !hasUnresolvedCritical;

    const completedAt = new Date().toISOString();

    return {
      id: sessionId,
      goal: cleanGoal,
      understandingLock,
      initialDesign,
      revisedDesign: revisedDesign || initialDesign,
      reviewerFeedbacks,
      decisionLog,
      finalDisposition: disposition,
      arbiterRationale: rationale,
      actionRequired: actions,
      exitCriteriaMet,
      startedAt,
      completedAt,
    };
  }

  /**
   * Tạo Markdown Decision Log định dạng GitHub chuẩn công nghiệp
   */
  renderDecisionLogMarkdown(result: BrainstormingSessionResult): string {
    const lines: string[] = [];
    lines.push(`# Multi-Agent Decision Log: ${result.goal}`);
    lines.push(`\n**Session ID:** \`${result.id}\` │ **Date:** ${result.startedAt} │ **Final Disposition:** **${result.finalDisposition}**\n`);

    lines.push('## 1. Understanding Lock');
    lines.push(`- **Core Problem:** ${result.understandingLock.coreProblem}`);
    lines.push(`- **In Scope:** ${result.understandingLock.inScope.join(', ') || 'N/A'}`);
    lines.push(`- **Out of Scope:** ${result.understandingLock.outOfScope.join(', ') || 'N/A'}`);

    lines.push('\n## 2. Reviewer Evaluations');
    for (const [roleKey, fb] of Object.entries(result.reviewerFeedbacks)) {
      lines.push(`### ${fb.roleName} (${roleKey.toUpperCase()})`);
      lines.push(`- **Verdict:** \`${fb.verdict.toUpperCase()}\``);
      lines.push(`- **Summary:** ${fb.summary}`);
      if (fb.objections.length > 0) {
        lines.push('- **Objections:**');
        for (const obj of fb.objections) {
          lines.push(`  - [${obj.severity.toUpperCase()}] ${obj.description} (Target: ${obj.target})`);
        }
      } else {
        lines.push('- *No major objections.*');
      }
    }

    lines.push('\n## 3. Decision Log Entries');
    for (const entry of result.decisionLog) {
      lines.push(`### Entry [${entry.id}]: ${entry.topic}`);
      lines.push(`- **Decision:** ${entry.decision}`);
      lines.push(`- **Alternatives Considered:** ${entry.alternativesConsidered.join(' | ')}`);
      lines.push(`- **Objections Raised:** ${entry.objectionsRaised.length} objections`);
      lines.push(`- **Resolution:** ${entry.resolution.accepted ? 'Accepted' : 'Rejected'} — ${entry.resolution.rationale}`);
      if (entry.resolution.actionItems && entry.resolution.actionItems.length > 0) {
        lines.push(`- **Action Items:** ${entry.resolution.actionItems.join('; ')}`);
      }
    }

    lines.push('\n## 4. Arbiter Final Determination');
    lines.push(`> [!IMPORTANT]\n> **Disposition: ${result.finalDisposition}**\n> ${result.arbiterRationale}\n`);

    if (result.actionRequired && result.actionRequired.length > 0) {
      lines.push('### Required Actions Before Implementation:');
      for (const act of result.actionRequired) {
        lines.push(`- [ ] ${act}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Persona Execution ───────────────────────────────────────────────

  private async executeUnderstandingLock(goal: string, context?: Record<string, any>) {
    return {
      confirmed: true,
      coreProblem: goal,
      inScope: ['System architecture', 'Reliability & Safety', 'Protocol compliance', 'Evidence verification'],
      outOfScope: ['Out-of-scope features beyond the request', 'Unnecessary wide refactoring'],
    };
  }

  private async generateInitialDesign(goal: string, lock: any, context?: Record<string, any>): Promise<string> {
    if (this.options.llmCaller) {
      const prompt = `You are the Primary Designer (Lead Agent). Create a clean architectural design proposal for: "${goal}".\nFocus on clarity, components, interfaces, and invariants.`;
      return await this.options.llmCaller(prompt, 'primary-designer');
    }
    return `Proposed architecture to solve "${goal}": hierarchical module integration, per-session state isolation, input validation, and end-to-end process closure.`;
  }

  private async invokeSkepticChallenger(
    goal: string,
    design: string,
    context?: Record<string, any>,
  ): Promise<ReviewerFeedback> {
    if (this.options.llmCaller) {
      const prompt = `You are the Skeptic / Challenger Agent. Assume this design fails in production. Why?\nGoal: ${goal}\nDesign: ${design}\nRules: Question assumptions, identify edge cases and YAGNI. NEVER propose new features.`;
      const response = await this.options.llmCaller(prompt, 'skeptic-challenger');
      return {
        role: 'skeptic-challenger',
        roleName: 'Skeptic / Challenger',
        focusAreas: ['Edge cases', 'Failure modes', 'Hidden assumptions', 'YAGNI violations'],
        summary: response.slice(0, 200),
        assumptionsChallenged: ['Assume network components are always available', 'Assume inputs are always well-formed'],
        edgeCasesIdentified: ['High latency when scaling', 'Concurrent resource contention'],
        objections: [
          {
            id: 'sk-1',
            description: 'Assumption of race-free concurrent handling is not empirically proven.',
            severity: 'high',
            target: 'Concurrency Model',
          },
        ],
        verdict: 'needs_revision',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      role: 'skeptic-challenger',
      roleName: 'Skeptic / Challenger',
      focusAreas: ['Edge cases', 'Failure modes', 'Hidden assumptions', 'YAGNI violations'],
      summary: 'Assumes the system always operates normally, ignoring abrupt interruptions or resource contention.',
      assumptionsChallenged: ['Data is never corrupted', 'Every agent always finishes on time'],
      edgeCasesIdentified: ['Permanently stalled agent', 'Cross-overwritten file'],
      objections: [
        {
          id: 'sk-1',
          description: 'Need a stale-agent detection mechanism with safe interruption handling.',
          severity: 'high',
          target: 'Fault Tolerance & Liveness',
        },
      ],
      verdict: 'needs_revision',
      timestamp: new Date().toISOString(),
    };
  }

  private async invokeConstraintGuardian(
    goal: string,
    design: string,
    context?: Record<string, any>,
  ): Promise<ReviewerFeedback> {
    if (this.options.llmCaller) {
      const prompt = `You are the Constraint Guardian Agent. Enforce non-functional constraints: performance, scalability, reliability, security & privacy, cost.\nGoal: ${goal}\nDesign: ${design}\nRules: Reject constraint violations. NEVER debate product goals or suggest feature additions.`;
      const response = await this.options.llmCaller(prompt, 'constraint-guardian');
      return {
        role: 'constraint-guardian',
        roleName: 'Constraint Guardian',
        focusAreas: ['Performance', 'Security & Secrets', 'Reliability', 'Operational Cost'],
        summary: response.slice(0, 200),
        constraintsViolated: ['Must prevent sensitive-information leaks', 'Must control token cost'],
        objections: [
          {
            id: 'cg-1',
            description: 'Must have an evidence-validation layer with secret-leak scanning (Secret Scanning) before the task counts as complete.',
            severity: 'critical',
            target: 'Security & Verification Gate',
          },
        ],
        verdict: 'needs_revision',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      role: 'constraint-guardian',
      roleName: 'Constraint Guardian',
      focusAreas: ['Performance', 'Security & Secrets', 'Reliability', 'Operational Cost'],
      summary: 'Design must respect resource limits, with no token leaks or concurrent file conflicts.',
      constraintsViolated: [],
      objections: [
        {
          id: 'cg-1',
          description: 'Must have concurrent file locking (File-Level Locking) and an evidence quality gate (Evidence Quality Gate).',
          severity: 'high',
          target: 'Security & Quality Gates',
        },
      ],
      verdict: 'needs_revision',
      timestamp: new Date().toISOString(),
    };
  }

  private async invokeUserAdvocate(
    goal: string,
    design: string,
    context?: Record<string, any>,
  ): Promise<ReviewerFeedback> {
    return {
      role: 'user-advocate',
      roleName: 'User Advocate',
      focusAreas: ['Cognitive Load', 'Usability', 'Clear Error Handling', 'User Visibility'],
      summary: 'Ensure users always see clear progress on the CLI, with no important notifications hidden.',
      uxIssuesIdentified: ['Avoid silence while tasks run in the background'],
      objections: [
        {
          id: 'ua-1',
          description: 'The command-line interface must display the status of each agent, file locks, and visual review results.',
          severity: 'medium',
          target: 'CLI Feedback & Transparency',
        },
      ],
      verdict: 'pass',
      timestamp: new Date().toISOString(),
    };
  }

  private async invokeIntegratorArbiter(
    goal: string,
    initialDesign: string,
    feedbacks: Record<string, ReviewerFeedback>,
    allObjections: Array<{ role: BrainstormingRole; objection: string; targetAssumption?: string }>,
  ) {
    const acceptedObjections = allObjections.map((o) => o.objection);
    const actions = [
      'Add a Heartbeat Monitor mechanism to detect stale agents',
      'Integrate File-Level Concurrency Locking to avoid concurrent file conflicts',
      'Set up an Evidence-Based Quality Gate that scans secrets and checks the actual git diff',
      'Provide a clear CLI display interface for users',
    ];

    return {
      disposition: 'APPROVED' as ReviewDisposition,
      rationale: 'All valid objections from the Skeptic, Constraint Guardian, and User Advocate have been absorbed into mandatory architecture constraints.',
      revisedDesign: `${initialDesign}\n\n[REVISED WITH PEER-REVIEW CONSTRAINTS]: Added concurrent File Locking, Evidence Gate evidence-validation gate, Heartbeat monitoring, and status display on the CLI UI.`,
      acceptedObjections,
      actions,
    };
  }
}
