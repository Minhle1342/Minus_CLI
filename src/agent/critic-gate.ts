import type { Workspace } from '../workspace/workspace.js';
import type { Session } from '../session/session.js';
import { getTurnCompletionState, type TurnCompletionState } from './completion-observations.js';
import { CompletionEvidenceGate, type CompletionEvidenceDecision } from './completion-evidence.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { DiagnosticItem } from '../tools/typescript-service.js';
import type { HypothesisTracker } from './hypothesis-tracker.js';
import type { DomainIntentGuardian } from './domain-intent-guardian.js';
import { WorkspaceStateVerifier, type CleanlinessCheckResult } from '../workspace/workspace-state-verifier.js';
import { AuditLedger, type TaskAuditRecord } from './audit-ledger.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';
import { isScratchPath } from '../skills/verification-policy.js';
import { detectArchitectureAnalysisIntent, detectAnalysisOrInvestigationIntent } from './final-answer-guard.js';
import { detectLeadingQuery } from './cognitive-harness.js';

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

export interface ExplorationSufficiencyParams {
  taskClass?: string;
  session: Session;
  targetFilePath?: string;
  hasReproduction?: boolean;
  hypothesisTracker?: HypothesisTracker;
  domainGuardian?: DomainIntentGuardian;
  userRequest?: string;
  gateMode?: 'off' | 'observe' | 'enforce';
  risk?: string;
}

export interface ExplorationSufficiencyDecision {
  allowed: boolean;
  score: number; // 0 - 100
  reasons: string[];
  inspectedFiles: string[];
  critiquePrompt?: string;
  remediationHint?: string;
}

function extractInspectedFilesFromSession(session: Session): Set<string> {
  const inspected = new Set<string>();
  try {
    const events = (session as any).getEvents ? (session as any).getEvents() : [];
    for (const event of events) {
      if (event.type === 'tool/call') {
        const toolName = event.data?.toolName;
        const args = event.data?.args || {};
        const p = args.path || args.filePath || args.targetFile || args.AbsolutePath || args.file || args.SearchPath || '';
        if (typeof p === 'string' && p.trim()) {
          inspected.add(p.trim().replace(/\\/g, '/').toLowerCase());
        }
      }
    }
  } catch {}
  return inspected;
}

function extractModifiedFiles(session: Session, filesModified?: string[], turn?: number): Set<string> {
  return new Set([...getTurnCompletionState(session, turn).filesModified, ...(filesModified || [])]);
}

export type CriticRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Ngưỡng score theo risk thay vì cứng 80: task ít rủi ro không cần điểm cao. */
const CRITIC_SCORE_THRESHOLD: Record<CriticRiskLevel, number> = {
  LOW: 60,
  MEDIUM: 70,
  HIGH: 80,
  CRITICAL: 80,
};

export function resolveCriticScoreThreshold(risk?: string): { level: CriticRiskLevel; threshold: number } {
  const r = (risk || '').trim().toUpperCase();
  if (!r) return { level: 'HIGH', threshold: 80 }; // thiếu risk = giữ ngưỡng cũ
  let level: CriticRiskLevel = 'LOW';
  if (r === 'R5' || r === 'R4' || r === 'CRITICAL') level = 'CRITICAL';
  else if (r === 'R3' || r === 'HIGH') level = 'HIGH';
  else if (r === 'R2' || r === 'MEDIUM') level = 'MEDIUM';
  return { level, threshold: CRITIC_SCORE_THRESHOLD[level] };
}

function normalizeDiagPath(p: string): string {
  return (p || '').trim().replace(/\\/g, '/').toLowerCase();
}

/** Chỉ giữ lỗi diagnostics thuộc file task vừa sửa (service có thể trả lan sang file khác). */
export function filterErrorsToModifiedFiles<T extends { file: string }>(errors: T[], modifiedFiles: Iterable<string>): T[] {
  const targets = new Set([...modifiedFiles].map(normalizeDiagPath).filter(Boolean));
  if (targets.size === 0) return [...errors];
  const baseOf = (p: string) => p.split('/').pop() || p;
  return errors.filter((e) => {
    const ef = normalizeDiagPath(e.file);
    if (!ef) return false;
    for (const t of targets) {
      if (ef === t || baseOf(ef) === baseOf(t) || ef.endsWith(`/${t}`) || t.endsWith(`/${ef}`)) return true;
    }
    return false;
  });
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
export interface ExplorationExhaustionParams {
  userRequest?: string;
  session: Session;
  finalAnswer?: string;
  gateMode?: 'off' | 'observe' | 'enforce';
}

export interface ExplorationExhaustionDecision {
  allowed: boolean;
  scorePenalty: number;
  reasons: string[];
  remediationHint?: string;
}

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
   * Dual-Agent Verifier: Đánh giá độc lập xem pha Exploration đã thu thập đủ thông tin để tiến sang Implementation chưa.
   * Rào chắn bảo vệ: Chặn sửa đổi mã nguồn nếu LLM chưa đọc file đích hoặc chưa có bằng chứng tái hiện lỗi (Reproduction Test).
   */
  /**
   * Pillar E2: Exploration Exhaustion Gate
   * Prevents premature stopping and hallucinated explanations when answering codebase questions.
   */
  evaluateExplorationExhaustion(params: ExplorationExhaustionParams): ExplorationExhaustionDecision {
    const { userRequest, session } = params;
    if (!userRequest) return { allowed: true, scorePenalty: 0, reasons: [] };

    const isArch = detectArchitectureAnalysisIntent(userRequest).isArchitectureQuery;
    const isAnalysis = detectAnalysisOrInvestigationIntent(userRequest).isAnalysisQuery;
    const isLeading = detectLeadingQuery(userRequest).isLeading;

    if (!isArch && !isAnalysis && !isLeading) {
      return { allowed: true, scorePenalty: 0, reasons: [] };
    }

    const inspectedFiles = extractInspectedFilesFromSession(session);
    const nonScratchInspected = Array.from(inspectedFiles).filter((f) => !isScratchPath(f));
    const reasons: string[] = [];
    let scorePenalty = 0;

    // Zero-Evidence Invariant: Cannot answer architecture or root cause questions without inspecting any code file
    if (nonScratchInspected.length === 0) {
      scorePenalty += 40;
      reasons.push(
        'EXPLORATION_EXHAUSTED_ZERO_EVIDENCE: Answering an architecture or defect investigation query requires inspecting source files or call-graph context (read_file, GitNexus context/query) before drawing conclusions.',
      );
    } else if (nonScratchInspected.length === 1 && (isAnalysis || isLeading)) {
      // Single-File Satisficing / Premature Closure Invariant
      scorePenalty += 20;
      reasons.push(
        `PREMATURE_SEARCH_CLOSURE: Investigated only 1 file ('${nonScratchInspected[0]}'). Defect and causal queries require checking at least one caller call-site, schema, or configuration to prevent single-file confirmation bias.`,
      );
    }

    const allowed = scorePenalty < 30;
    return {
      allowed,
      scorePenalty,
      reasons,
      remediationHint: reasons.join('; '),
    };
  }

  evaluateExplorationSufficiency(params: ExplorationSufficiencyParams): ExplorationSufficiencyDecision {
    const {
      taskClass,
      session,
      targetFilePath = '',
      hasReproduction = false,
      hypothesisTracker,
      gateMode = 'observe',
    } = params;

    const reasons: string[] = [];
    let score = 100;

    const normalizedTarget = targetFilePath.trim().replace(/\\/g, '/').toLowerCase();
    const isScratch = isScratchPath(normalizedTarget);

    // Scratch files / reproduction scripts are always allowed
    if (isScratch) {
      return {
        allowed: true,
        score: 100,
        reasons: [],
        inspectedFiles: [],
      };
    }

    const inspectedFiles = extractInspectedFilesFromSession(session);
    const hasInspectedTarget = Array.from(inspectedFiles).some((f) =>
      normalizedTarget.endsWith(f) || f.endsWith(normalizedTarget) || normalizedTarget.includes(f) || f.includes(normalizedTarget)
    );

    // 1. Target Inspection Invariant: Must inspect target before mutating
    if (normalizedTarget && !hasInspectedTarget) {
      score -= 50;
      reasons.push(
        `Target file '${targetFilePath}' has NOT been inspected with read_file/view_file before attempting modification.`,
      );
    }

    // 2. Reproduction Proof Invariant (Bugfix / Security)
    const isBugfixOrSecurity = taskClass === 'bugfix' || taskClass === 'security';
    if (isBugfixOrSecurity && !hasReproduction) {
      const latestHypo = hypothesisTracker?.getLatestHypothesis();
      const hasVerifiedHypo = latestHypo && (latestHypo.status === 'supported' || latestHypo.status === 'validated');
      if (!hasVerifiedHypo) {
        score -= 50;
        reasons.push(
          'No failing reproduction test execution (e.g. scratch/reproduce_*.py or failing unit test) found for bugfix task.',
        );
      }
    }

    // 2b. Causal Lineage Invariant (Bugfix / Security at R2+ Risk)
    // Anti-Confirmation Bias: Prevent mutating based on local symptom alone without tracing upstream caller or related test/config
    const nonScratchInspected = Array.from(inspectedFiles).filter((f) => !isScratchPath(f));
    const isHighOrMediumRisk = ['R2', 'R3', 'R4', 'R5', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(
      (params.risk || '').trim().toUpperCase(),
    );
    if (isBugfixOrSecurity && isHighOrMediumRisk && nonScratchInspected.length < 2) {
      score -= 50;
      reasons.push(
        `CAUSAL_TRACE_INSUFFICIENT: Bugfix/security task at risk level '${params.risk || 'R2+'}' requires inspecting at least 2 causal chain files (root cause locus + caller/call-site/test). Found ${nonScratchInspected.length} inspected production file(s).`,
      );
    }

    // 3. Hypothesis Falsification Invariant: Cannot mutate based on a falsified hypothesis
    if (hypothesisTracker) {
      const latestHypo = hypothesisTracker.getLatestHypothesis();
      if (latestHypo && latestHypo.status === 'falsified') {
        score -= 50;
        reasons.push(
          `Latest hypothesis [${latestHypo.id}] "${latestHypo.statement}" was FALSIFIED (${latestHypo.rejectionReason || 'test failed'}). Formulate and test a new hypothesis before mutating code.`,
        );
      }
    }

    // 4. Goal Guardian Audit Invariant: Check for blocked tamper attempts or severe drift
    if (params.domainGuardian) {
      const audit = params.domainGuardian.getAuditSummary();
      if (audit.blockedTamperAttempts > 0) {
        score -= 30;
        reasons.push(
          `Domain Intent Guardian blocked ${audit.blockedTamperAttempts} test tampering attempt(s).`,
        );
      }
      if (audit.consecutiveDriftWarnings > 1) {
        score -= 20;
        reasons.push(
          `Domain Intent Guardian detected ${audit.consecutiveDriftWarnings} consecutive goal drift warnings.`,
        );
      }
    }

    const allowed = gateMode !== 'enforce' || score >= 60;

    let critiquePrompt: string | undefined;
    let remediationHint: string | undefined;

    if (!allowed) {
      critiquePrompt = [
        `\n🛑 [DUAL-AGENT EXPLORATION SUFFICIENCY GATE REJECTION - SCORE: ${score}/100]:`,
        `The independent Verifier determined that exploration information is INSUFFICIENT to begin implementation:`,
        ...reasons.map((r) => `  ❌ ${r}`),
        `\n👉 REQUIRED REMEDIATION ACTIONS:`,
        `1. Inspect the target file (${targetFilePath}) with read_file/view_file to understand existing logic and exact line numbers.`,
        `2. For bugfixes, write a reproduction script (e.g. scratch/reproduce_issue.py) or execute a test command to establish reproduction proof.`,
        `3. Formulate and verify the causal hypothesis before applying mutations.`,
        `4. Trace the causal lineage: inspect upstream callers, related tests, or config files with read_file/inspect_symbol to avoid tunnel vision.`,
      ].join('\n');

      remediationHint = reasons.join('; ');
    }

    return {
      allowed,
      score: Math.max(0, score),
      reasons,
      inspectedFiles: Array.from(inspectedFiles),
      critiquePrompt,
      remediationHint,
    };
  }

  /**
   * Đánh giá độc lập toàn diện trước khi cho phép Agent kết thúc task (Hard-Gated Critic Invariant)
   */
  evaluate(params: {
    finalAnswer: string;
    session: Session;
    workspace: Workspace;
    hypothesisTracker?: HypothesisTracker;
    domainGuardian?: DomainIntentGuardian;
    userRequest?: string;
    filesModified?: string[];
    turn?: number;
    hasSubmittedSolution?: boolean;
    completionState?: TurnCompletionState;
    evidenceDecision?: CompletionEvidenceDecision;
    risk?: string;
  }): CriticEvaluation {
    const { finalAnswer, session, workspace, hypothesisTracker, domainGuardian, userRequest, filesModified, turn, hasSubmittedSolution } = params;
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

    // Nới lỏng: LSP error chỉ block khi thuộc file task vừa sửa.
    lspErrors = filterErrorsToModifiedFiles(lspErrors, targetFiles);

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

    // 4. Thẩm định Goal Guardian Audit
    if (domainGuardian) {
      const audit = domainGuardian.getAuditSummary();
      if (audit.blockedTamperAttempts > 0) {
        score -= 30;
        reasons.push(`Domain Intent Guardian detected ${audit.blockedTamperAttempts} blocked test tampering attempt(s).`);
      }
      if (audit.consecutiveDriftWarnings > 1) {
        score -= 20;
        reasons.push(`Domain Intent Guardian detected ${audit.consecutiveDriftWarnings} consecutive goal drift warnings.`);
      }
    }

    // 5. Pillar E2: Exploration Exhaustion Gate for Read-Only / Architecture / Investigation queries
    if (targetFiles.size === 0) {
      const exhaustion = this.evaluateExplorationExhaustion({
        userRequest,
        session,
        finalAnswer,
      });
      if (exhaustion.scorePenalty > 0) {
        score -= exhaustion.scorePenalty;
        reasons.push(...exhaustion.reasons);
      }
    }

    // Ngưỡng score theo risk (LOW 60 / MEDIUM 70 / HIGH-CRITICAL 80), thiếu risk giữ ngưỡng cũ 80.
    const { level: riskLevel, threshold: scoreThreshold } = resolveCriticScoreThreshold(params.risk);
    const approved = lspErrors.length === 0 && score >= scoreThreshold && evidenceDecision.allow;

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
        `\n🛑 [CRITIC GATE REJECTION - CRITIQUE SCORE: ${score}/100 (threshold ${scoreThreshold} for ${riskLevel} risk)]:`,
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
    domainGuardian?: DomainIntentGuardian;
    userRequest?: string;
    filesModified?: string[];
    turn?: number;
    hasSubmittedSolution?: boolean;
    completionState?: TurnCompletionState;
    evidenceDecision?: CompletionEvidenceDecision;
    risk?: string;
  }): Promise<CriticEvaluation> {
    const { finalAnswer, session, workspace, hypothesisTracker, domainGuardian, userRequest, filesModified, turn, hasSubmittedSolution } = params;
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

    // Nới lỏng: LSP error chỉ block khi thuộc file task vừa sửa.
    lspErrors = filterErrorsToModifiedFiles(lspErrors, targetFiles);

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

    // 4. Thẩm định Goal Guardian Audit
    if (domainGuardian) {
      const audit = domainGuardian.getAuditSummary();
      if (audit.blockedTamperAttempts > 0) {
        score -= 30;
        reasons.push(`Domain Intent Guardian detected ${audit.blockedTamperAttempts} blocked test tampering attempt(s).`);
      }
      if (audit.consecutiveDriftWarnings > 1) {
        score -= 20;
        reasons.push(`Domain Intent Guardian detected ${audit.consecutiveDriftWarnings} consecutive goal drift warnings.`);
      }
    }

    // Ngưỡng score theo risk (LOW 60 / MEDIUM 70 / HIGH-CRITICAL 80), thiếu risk giữ ngưỡng cũ 80.
    const { level: riskLevel, threshold: scoreThreshold } = resolveCriticScoreThreshold(params.risk);
    const approved = lspErrors.length === 0 && score >= scoreThreshold && evidenceDecision.allow;

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
        `\n🛑 [CRITIC GATE REJECTION - CRITIQUE SCORE: ${score}/100 (threshold ${scoreThreshold} for ${riskLevel} risk)]:`,
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
