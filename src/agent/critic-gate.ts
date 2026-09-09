import type { Workspace } from '../workspace/workspace.js';
import type { Session } from '../session/session.js';
import { getTurnCompletionState, type TurnCompletionState } from './completion-observations.js';
import { CompletionEvidenceGate, type CompletionEvidenceDecision } from './completion-evidence.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';
import type { HypothesisTracker } from './hypothesis-tracker.js';
import { WorkspaceStateVerifier, type CleanlinessCheckResult } from '../workspace/workspace-state-verifier.js';
import { AuditLedger, type TaskAuditRecord } from './audit-ledger.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';

export interface CriticEvaluation {
  approved: boolean;
  score: number; // 0 - 100
  invariantViolations: string[];
  lspErrors: DiagnosticItem[];
  reasons: string[];
  critiquePrompt?: string;
  auditRecord?: TaskAuditRecord;
}

export interface ComposeAcceptanceContract {
  matrix: Array<{ id: string; status: string; evidenceSeq?: number }>;
  lastMutationSeq: number;
  changedFiles: string[];
  registeredFiles: string[];
}

function extractModifiedFiles(session: Session, filesModified?: string[], turn?: number): Set<string> {
  return new Set([...getTurnCompletionState(session, turn).filesModified, ...(filesModified || [])]);
}

/**
 * CriticGate - Cổng Phản biện Độc lập (Actor-Critic Dual-Role Architecture)
 * 
 * Đóng vai trò là "Critic / Verifier" độc lập với "Actor / Code Generator":
 * 1. Hard-Gated Invariant: Không cho phép bất kỳ lỗi SyntaxError / NameError / Missing Import nào tồn tại.
 * 2. Thẩm định TypeScript / JavaScript / Python / JSON trực tiếp qua Language Service & CodeSyntaxValidator.
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

  /** Independent, side-effect-free acceptance decision for a locked Compose run. */
  evaluateComposeAcceptance(contract: ComposeAcceptanceContract): { approved: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const stale = contract.matrix.filter((item) => item.status !== 'PASSED' || (item.evidenceSeq || 0) <= contract.lastMutationSeq);
    if (contract.matrix.length === 0) reasons.push('Compose acceptance matrix is empty.');
    else if (stale.length > 0) reasons.push(`${stale.length} acceptance scenario(s) lack fresh passing evidence.`);
    const unregistered = contract.changedFiles.filter((file) => !contract.registeredFiles.some((registered) => file === registered || file.startsWith(`${registered.replace(/\/$/, '')}/`)));
    if (unregistered.length > 0) reasons.push(`Unregistered changed paths: ${unregistered.join(', ')}`);
    return { approved: reasons.length === 0, reasons };
  }

  /**
   * Đánh giá độc lập toàn diện trước khi cho phép Agent kết thúc task (Hard-Gated Critic Invariant)
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
    completionState?: TurnCompletionState;
    evidenceDecision?: CompletionEvidenceDecision;
  }): CriticEvaluation {
    const { finalAnswer, session, workspace, hypothesisTracker, userRequest, filesModified, turn, hasSubmittedSolution } = params;
    const reasons: string[] = [];
    const invariantViolations: string[] = [];
    let lspErrors: DiagnosticItem[] = [];
    let score = 100;

    // Trích xuất toàn bộ các file đã được chỉnh sửa từ Session History & Events
    const targetFiles = params.completionState
      ? new Set(params.completionState.filesModified)
      : extractModifiedFiles(session, filesModified, turn);

    // 1. HARD INVARIANT: Kiểm tra In-Memory LSP / TypeScript Diagnostics & Multi-language Syntax
    // CHỈ kiểm tra diagnostics cho các file thực sự bị thay đổi (Targeted LSP Inspection).
    // Nếu targetFiles.size === 0 (read-only query / tra cứu), bỏ qua hoàn toàn việc quét TypeScript diagnostics.
    if (targetFiles.size > 0) {
      try {
        const tsService = getOrCreateTypeScriptService(workspace);
        for (const file of targetFiles) {
          if (/\.[cm]?[jt]sx?$/i.test(file)) {
            try {
              const fileDiags = tsService.getDiagnostics(file);
              const tsErrors = fileDiags.filter((d) =>
                d.category === 'error' &&
                !d.file.startsWith('scratch') &&
                !d.file.startsWith('temp') &&
                !d.file.includes('/scratch/') &&
                !d.file.includes('\\scratch\\') &&
                !d.file.includes('/temp/') &&
                !d.file.includes('\\temp\\')
              );
              lspErrors.push(...tsErrors);
            } catch {}
          }
        }
      } catch {
        // Ignore if workspace is not a TS project
      }
    }

    // Kiểm tra các file modified đối với Python, JSON và TS
    for (const file of targetFiles) {
      if (file.endsWith('.py')) {
        try {
          const safePath = workspace.resolveSafePath(file);
          const pyErrors = (CodeSyntaxValidator as any).analyzePythonScopeAndImports
            ? (CodeSyntaxValidator as any).analyzePythonScopeAndImports(file, fsReadFileSyncSafe(safePath))
            : [];
          lspErrors.push(...pyErrors);
        } catch {}
      }
    }

    if (lspErrors.length > 0) {
      score = 0; // HARD ZERO SCORE: Lỗi cú pháp hoặc NameError là vi phạm bất biến nghiêm trọng
      invariantViolations.push(`Detected ${lspErrors.length} unresolved syntax / compiler / missing import error(s).`);
      reasons.push(
        `[HARD CRITIC INVARIANT VIOLATION]: Detected ${lspErrors.length} unresolved syntax / compiler / missing import error(s) (e.g. NameError, undefined symbol) in the workspace.`,
      );
    }

    // 2. Thẩm định bằng chứng thực thi qua CompletionEvidenceGate
    const evidenceDecision = params.evidenceDecision ?? this.evidenceGate.evaluate(finalAnswer, session, {
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

    // Hard Gate: Không bao giờ approve nếu còn bất kỳ lỗi compiler / syntax / missing import nào
    const approved = lspErrors.length === 0 && score >= 80 && evidenceDecision.allow;

    const auditRecord = this.auditLedger.record({
      turn: typeof turn === 'number' ? turn : 1,
      summary: finalAnswer.slice(0, 300),
      filesModified: Array.from(targetFiles),
      verificationCommand: targetFiles.size === 0 ? 'not-required' : (hasSubmittedSolution || evidenceDecision.allow) ? 'verified' : 'unverified',
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
        promptParts.push(`\n🔍 [COMPILER / LINTER DIAGNOSTICS & MISSING IMPORTS TO FIX]:`);
        for (const err of lspErrors.slice(0, 8)) {
          promptParts.push(`  • [${err.code ? `CODE ${err.code}` : 'ERROR'}] ${err.file}:${err.line}:${err.character || 0} - ${err.message}`);
        }
        promptParts.push(`\n👉 CRITICAL ACTION REQUIRED: Add the missing import statement(s) at the top of the file(s) or fix the syntax errors before completing.`);
      } else {
        promptParts.push(evidenceDecision.continuationPrompt || 'State the findings and unresolved questions honestly using the available evidence.');
      }
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

  /**
   * Đánh giá bất đồng bộ toàn diện với CodeSyntaxValidator
   */
  async evaluateAsync(params: {
    finalAnswer: string;
    session: Session;
    workspace: Workspace;
    hypothesisTracker?: HypothesisTracker;
    userRequest?: string;
    filesModified?: string[];
    turn?: number;
    hasSubmittedSolution?: boolean;
    completionState?: TurnCompletionState;
    evidenceDecision?: CompletionEvidenceDecision;
  }): Promise<CriticEvaluation> {
    const { finalAnswer, session, workspace, hypothesisTracker, userRequest, filesModified, turn, hasSubmittedSolution } = params;
    const reasons: string[] = [];
    const invariantViolations: string[] = [];
    let lspErrors: DiagnosticItem[] = [];
    let score = 100;

    // Trích xuất toàn bộ các file đã được chỉnh sửa từ Session History & Events
    const targetFiles = params.completionState
      ? new Set(params.completionState.filesModified)
      : extractModifiedFiles(session, filesModified, turn);

    // 1. HARD INVARIANT: Thẩm định cú pháp & missing imports toàn diện qua CodeSyntaxValidator & TypeScript Service
    // CHỈ kiểm tra diagnostics cho các file thực sự bị thay đổi (Targeted LSP Inspection).
    if (targetFiles.size > 0) {
      try {
        const syntaxDiags = await CodeSyntaxValidator.validateFiles(Array.from(targetFiles), workspace);
        lspErrors.push(...syntaxDiags);
      } catch {}

      try {
        const tsService = getOrCreateTypeScriptService(workspace);
        for (const file of targetFiles) {
          if (/\.[cm]?[jt]sx?$/i.test(file)) {
            try {
              const fileDiags = tsService.getDiagnostics(file);
              const tsErrors = fileDiags.filter((d) =>
                d.category === 'error' &&
                !d.file.startsWith('scratch') &&
                !d.file.startsWith('temp') &&
                !d.file.includes('/scratch/') &&
                !d.file.includes('\\scratch\\') &&
                !d.file.includes('/temp/') &&
                !d.file.includes('\\temp\\')
              );
              for (const tErr of tsErrors) {
                if (!lspErrors.some((e) => e.file === tErr.file && e.line === tErr.line && e.code === tErr.code)) {
                  lspErrors.push(tErr);
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    if (lspErrors.length > 0) {
      score = 0; // HARD ZERO SCORE
      invariantViolations.push(`Detected ${lspErrors.length} unresolved syntax / compiler / missing import error(s).`);
      reasons.push(
        `[HARD CRITIC INVARIANT VIOLATION]: Detected ${lspErrors.length} unresolved syntax / compiler / missing import error(s) (e.g. NameError, undefined symbol) in the workspace.`,
      );
    }

    // 2. Thẩm định bằng chứng thực thi qua CompletionEvidenceGate
    const evidenceDecision = params.evidenceDecision ?? this.evidenceGate.evaluate(finalAnswer, session, {
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

    // Hard Gate: Không bao giờ approve nếu còn bất kỳ lỗi compiler / syntax / missing import nào
    const approved = lspErrors.length === 0 && score >= 80 && evidenceDecision.allow;

    const auditRecord = this.auditLedger.record({
      turn: typeof turn === 'number' ? turn : 1,
      summary: finalAnswer.slice(0, 300),
      filesModified: Array.from(targetFiles),
      verificationCommand: targetFiles.size === 0 ? 'not-required' : (hasSubmittedSolution || evidenceDecision.allow) ? 'verified' : 'unverified',
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
        promptParts.push(`\n🔍 [COMPILER / LINTER DIAGNOSTICS & MISSING IMPORTS TO FIX]:`);
        for (const err of lspErrors.slice(0, 8)) {
          promptParts.push(`  • [${err.code ? `CODE ${err.code}` : 'ERROR'}] ${err.file}:${err.line}:${err.character || 0} - ${err.message}`);
        }
        promptParts.push(`\n👉 CRITICAL ACTION REQUIRED: Add the missing import statement(s) at the top of the file(s) or fix the syntax errors before completing.`);
      } else {
        promptParts.push(evidenceDecision.continuationPrompt || 'State the findings and unresolved questions honestly using the available evidence.');
      }
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

function fsReadFileSyncSafe(filePath: string): string {
  try {
    const fs = require('node:fs');
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}
