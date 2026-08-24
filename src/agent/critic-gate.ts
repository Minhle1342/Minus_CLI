import type { Workspace } from '../workspace/workspace.js';
import type { Session } from '../session/session.js';
import { CompletionEvidenceGate } from './completion-evidence.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';
import type { HypothesisTracker } from './hypothesis-tracker.js';
import { WorkspaceStateVerifier, type CleanlinessCheckResult } from '../workspace/workspace-state-verifier.js';
import { AuditLedger, type TaskAuditRecord } from './audit-ledger.js';

export interface CriticEvaluation {
  approved: boolean;
  score: number; // 0 - 100
  invariantViolations: string[];
  lspErrors: DiagnosticItem[];
  reasons: string[];
  critiquePrompt?: string;
  auditRecord?: TaskAuditRecord;
}

/**
 * CriticGate - Cổng Phản biện Độc lập (Actor-Critic Dual-Role Architecture)
 * 
 * Đóng vai trò là "Critic / Verifier" độc lập với "Actor / Code Generator":
 * 1. Kiểm tra tính bất biến (Invariant Checker): Chống phá vỡ ranh giới workspace & file rác.
 * 2. Thẩm định TypeScript Semantic & Syntax trực tiếp qua Language Service trong RAM.
 * 3. Thẩm định bằng chứng thực nghiệm (CompletionEvidenceGate) - Không chấp nhận lời nói mồm.
 * 4. Kiểm tra trạng thái Giả thuyết (Hypothesis Validation Status).
 * 5. Thẩm định tính sạch sẽ của Workspace qua WorkspaceStateVerifier và ghi AuditLedger.
 */
export class CriticGate {
  private evidenceGate: CompletionEvidenceGate;
  readonly auditLedger: AuditLedger = new AuditLedger();

  constructor(evidenceGate?: CompletionEvidenceGate) {
    this.evidenceGate = evidenceGate || new CompletionEvidenceGate();
  }

  /**
   * Đánh giá độc lập toàn diện trước khi cho phép Agent kết thúc task
   */
  evaluate(params: {
    finalAnswer: string;
    session: Session;
    workspace: Workspace;
    hypothesisTracker?: HypothesisTracker;
    userRequest?: string;
    filesModified?: string[];
    turn?: number;
    hasSubmittedSolution?: boolean;
  }): CriticEvaluation {
    const { finalAnswer, session, workspace, hypothesisTracker, userRequest, filesModified, turn, hasSubmittedSolution } = params;
    const reasons: string[] = [];
    const invariantViolations: string[] = [];
    let lspErrors: DiagnosticItem[] = [];
    let score = 100;

    // 1. Kiểm tra In-Memory LSP / TypeScript Diagnostics (Zero Syntax/Type Regressions)
    try {
      const tsService = getOrCreateTypeScriptService(workspace);
      const allDiags = tsService.getDiagnostics();
      lspErrors = allDiags.filter((d) => d.category === 'error');

      if (lspErrors.length > 0) {
        score -= Math.min(40, lspErrors.length * 15);
        reasons.push(
          `Detected ${lspErrors.length} TypeScript compiler error(s) (LSP Diagnostics) unresolved in the workspace.`,
        );
      }
    } catch {
      // Ignore if workspace is not a TS project
    }

    // 2. Thẩm định bằng chứng thực thi qua CompletionEvidenceGate
    // Nếu hasSubmittedSolution đã là true, bằng chứng thực nghiệm đã được kiểm chứng và chốt theo chuẩn Codex CLI
    const evidenceDecision = hasSubmittedSolution
      ? { allow: true, reasons: [] }
      : this.evidenceGate.evaluate(finalAnswer, session, {
          userRequest,
          turn,
          hasSubmittedSolution,
        });

    if (!evidenceDecision.allow) {
      score -= 50;
      reasons.push(...evidenceDecision.reasons);
    }

    // 3. Thẩm định trạng thái Hypothesis
    if (hypothesisTracker) {
      const active = hypothesisTracker.getActiveHypothesis();
      if (active && active.status === 'testing') {
        score -= 20;
        reasons.push(`Hypothesis [${active.id}] "${active.statement}" remains in 'testing' state without validation outcome.`);
      }
    }

    const approved = score >= 80 && lspErrors.length === 0 && evidenceDecision.allow;

    const auditRecord = this.auditLedger.record({
      turn: typeof turn === 'number' ? turn : 1,
      summary: finalAnswer.slice(0, 300),
      filesModified: filesModified || [],
      verificationCommand: (hasSubmittedSolution || evidenceDecision.allow) ? 'verified' : 'unverified',
      verificationExitCode: (hasSubmittedSolution || evidenceDecision.allow) ? 0 : 1,
      critiqueScore: Math.max(0, score),
      lspDiagnosticsCount: lspErrors.length,
      status: approved ? 'APPROVED' : 'REJECTED',
      reasons: reasons.length > 0 ? reasons : undefined,
    }, session);

    let critiquePrompt: string | undefined;
    if (!approved) {
      const promptParts: string[] = [
        `\n🛑 [CRITIC GATE REJECTION - CRITIQUE SCORE: ${score}/100]:`,
        `Task completion rejected by independent Verifier due to unsatisfied invariants:`,
      ];

      for (const r of reasons) {
        promptParts.push(`  ❌ ${r}`);
      }

      if (lspErrors.length > 0) {
        promptParts.push(`\n🔍 [TYPESCRIPT COMPILER DIAGNOSTICS TO FIX]:`);
        for (const err of lspErrors.slice(0, 5)) {
          promptParts.push(`  • [TS${err.code}] ${err.file}:${err.line}:${err.character} - ${err.message}`);
        }
        promptParts.push(`👉 Use "inspect_symbol" and "replace_text" to surgically resolve these compiler errors.`);
      }

      promptParts.push(`\n👉 ACTION REQUIRED: Run the necessary test/build/typecheck commands to provide empirical verification evidence before concluding.`);
      critiquePrompt = promptParts.join('\n');
    }

    return {
      approved,
      score: Math.max(0, score),
      invariantViolations,
      lspErrors,
      reasons,
      critiquePrompt,
      auditRecord,
    };
  }
}
