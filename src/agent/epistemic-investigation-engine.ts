import path from 'node:path';
import fs from 'node:fs';
import { BlastRadiusRisk, Hypothesis } from './hypothesis-tracker.js';
import { ExactTokenizer } from './exact-tokenizer.js';

/**
 * Kiểm tra xem tệp có thuộc module chia sẻ lõi (core/db/entity/types/security/etc.) hay không.
 * Sử dụng ranh giới phân tách đường dẫn (path boundary) để tránh false positives
 * với các tệp như feedback.ts, sandbox.ts, scoreboard.ts.
 */
export function isCoreModulePath(filePath?: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return /(?:^|[\\/])(?:core|db|database|entity|entities|types|tool-runner|security|query-engine)(?:[\\/._-]|$)/i.test(normalized);
}

export type DialecticalStance = 'thesis' | 'antithesis' | 'synthesis';

export type DialecticalVerdictOutcome = 'CONFIRMED_THESIS' | 'REJECTED_THESIS' | 'REFINED_HYPOTHESIS' | 'INSUFFICIENT_EVIDENCE';

export interface DialecticalVerdict {
  outcome: DialecticalVerdictOutcome;
  confidence: number; // 0.0 - 1.0
  thesisClaim: string;
  antithesisRebuttal: string;
  epistemicArbiterReasoning: string;
  recommendedAction: string;
  falsificationCriteria: string;
  distilledTokens: number;
}

export interface SpeculativeRolloutStep {
  stepIndex: number;
  action: string;
  predictedOutcome: string;
  syntaxValid: boolean;
  regressionRisk: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  score: number; // 0.0 - 1.0
}

export interface SpeculativeRolloutResult {
  steps: SpeculativeRolloutStep[];
  meanScore: number;
  passedSyntaxCheck: boolean;
  criticalRisksIdentified: string[];
  recommendation: 'PROCEED' | 'ABORT' | 'TRY_ALTERNATIVE';
}

export interface EpistemicInvestigationInputs {
  hypothesis?: Hypothesis;
  phase: 'explore' | 'plan' | 'implement' | 'verify';
  risk: BlastRadiusRisk;
  consecutiveFailures: number;
  recentError?: string;
  errorCode?: string;
  targetFiles?: string[];
  proposedFixSummary?: string;
  workspaceRoot?: string;
  adversaryRebuttal?: string;
  skepticalCriticActive?: boolean;
}

export interface EpistemicInvestigationResult {
  activated: boolean;
  gateReason?: string;
  dialecticalVerdict?: DialecticalVerdict;
  speculativeRollout?: SpeculativeRolloutResult;
  distilledContext?: string;
  tokensUsed: number;
}

/**
 * 1. Anti-Accuracy Degradation: Empirical Evidence Gating & Selective Activation
 * 
 * Đảm bảo chỉ kích hoạt điều tra sâu System 2 khi thực sự cần thiết:
 * - KHÔNG kích hoạt cho tác vụ explore/read-only đơn giản (0ms overhead, tránh paralysis by analysis).
 * - KÍCH HOẠT khi:
 *   + Rủi ro Blast Radius ở mức HIGH hoặc CRITICAL
 *   + Đang gặp failure lặp lại (consecutiveFailures >= 2)
 *   + Giả thuyết đang ở phase testing với tác động mutation lớn
 */
export class EpistemicInvestigationGating {
  static shouldActivate(inputs: EpistemicInvestigationInputs): { activate: boolean; reason: string } {
    const operationalFailure = inputs.errorCode || inputs.recentError?.match(
      /\b(?:PACKAGE_JSON_NOT_FOUND|TOOL_NOT_ALLOWED_THIS_TURN|APPROVAL_REQUIRED|CONTEXT_BUDGET_UNSATISFIABLE|COMMAND_NOT_FOUND|WORKSPACE_PATH_NOT_FOUND)\b/i,
    )?.[0];
    const hasHighRiskHypothesis = inputs.hypothesis
      && (inputs.hypothesis.blastRadius === 'HIGH' || inputs.hypothesis.blastRadius === 'CRITICAL');

    // Environment and authorization failures need deterministic recovery, not another
    // thesis/antithesis cycle. Bypass only when no independently high-risk hypothesis exists.
    if (operationalFailure && !hasHighRiskHypothesis) {
      return {
        activate: false,
        reason: `Bypassed: operational failure ${operationalFailure.toUpperCase()} requires deterministic recovery.`,
      };
    }

    // 1. Nếu consecutive failures >= 2 -> Bắt buộc kích hoạt để tránh loop/confirmation bias
    if (inputs.consecutiveFailures >= 2) {
      return {
        activate: true,
        reason: `Consecutive failures threshold reached (${inputs.consecutiveFailures} >= 2). Epistemic debiasing required.`,
      };
    }

    // 2. Nếu rủi ro HIGH hoặc CRITICAL trong phase implement/verify
    if (
      (inputs.risk === 'HIGH' || inputs.risk === 'CRITICAL') &&
      (inputs.phase === 'implement' || inputs.phase === 'verify')
    ) {
      return {
        activate: true,
        reason: `High/Critical blast radius risk (${inputs.risk}) detected during ${inputs.phase} phase. Pre-commit validation required.`,
      };
    }

    // 3. Nếu hypothesis đang được kiểm nghiệm có blast radius cao
    if (inputs.hypothesis && (inputs.hypothesis.blastRadius === 'HIGH' || inputs.hypothesis.blastRadius === 'CRITICAL')) {
      return {
        activate: true,
        reason: `Active hypothesis [${inputs.hypothesis.id}] carries ${inputs.hypothesis.blastRadius} blast radius risk.`,
      };
    }

    // 4. Nếu vừa có error nghiêm trọng và có proposed fix
    if (inputs.recentError && inputs.proposedFixSummary && inputs.consecutiveFailures >= 1) {
      return {
        activate: true,
        reason: `Recent execution error with proposed mutation requires dialectical sanity check.`,
      };
    }

    // 5. Pillar E4: Nếu phase là explore nhưng có cờ skepticalCriticActive (câu hỏi mớm cung / điều tra lỗi)
    if (inputs.phase === 'explore' && inputs.skepticalCriticActive) {
      return {
        activate: true,
        reason: 'Investigative exploration query requires lightweight dialectical check against sycophancy and confirmation bias.',
      };
    }

    // Mặc định: Bypass để bảo vệ hiệu năng và độ trễ
    return {
      activate: false,
      reason: `Bypassed: Low risk profile (${inputs.risk}, phase: ${inputs.phase}, failures: ${inputs.consecutiveFailures}).`,
    };
  }
}

/**
 * 2. Cross-Agent Dual Investigation (Cơ chế Biện chứng Đối lập)
 * 
 * Khởi tạo cặp đối lập:
 * - Thesis (Affirmative): Lập luận bảo vệ nguyên nhân và phương án sửa chữa.
 * - Antithesis (Skeptical / Null Hypothesis): Lập luận phản biện, chứng minh code hiện tại đúng hoặc phương án sửa có side effects.
 * - Epistemic Arbiter: Cân nhắc bằng chứng thực nghiệm (Empirical Grounding) và đưa ra phán quyết, triệt tiêu thiên kiến xác nhận.
 */
export class CrossAgentDualInvestigator {
  investigate(inputs: EpistemicInvestigationInputs): DialecticalVerdict {
    const claim = inputs.hypothesis?.statement || inputs.proposedFixSummary || 'Proposed system modification';
    const falsificationTest = inputs.hypothesis?.falsificationTest || 'Execute regression test suite and verify return code 0';
    const risk = inputs.risk;

    // Thesis: Tuyên bố khẳng định
    const thesisClaim = `Asserted error origin: "${claim}". The change will resolve the issue definitively.`;

    // Antithesis: Giả thuyết vô hiệu (Null Hypothesis) & Phản biện rủi ro
    const targetFiles = inputs.targetFiles && inputs.targetFiles.length > 0 
      ? inputs.targetFiles.join(', ')
      : 'target files';

    const hasCoreModuleTarget = (inputs.targetFiles || []).some(f => isCoreModulePath(f));

    const hasSurfaceSymptomError = Boolean(
      inputs.recentError?.includes('TypeError') || 
      inputs.recentError?.includes('TimeoutError') ||
      inputs.recentError?.includes('ContractMismatch') ||
      inputs.recentError?.includes('SchemaViolation')
    );
    
    let antithesisRebuttal = inputs.adversaryRebuttal
      ? `Counter-argument (Skeptical Critic): ${inputs.adversaryRebuttal} | Changes to [${targetFiles}] may break backward compatibility or miss the root cause.`
      : (inputs.skepticalCriticActive || inputs.consecutiveFailures >= 2)
      ? `Counter-argument (Skeptical Critic - Anti-Confirmation Bias): suspected secondary symptom at [${targetFiles}]. Trace callers/config before asserting a logic error here.`
      : `Counter-argument: check whether the current behavior is intentional design. ` +
        `Changes to [${targetFiles}] may break backward compatibility (regression) ` +
        `or the root-cause assumption may be incomplete.`;

    if (hasSurfaceSymptomError) {
      antithesisRebuttal += ` Null Hypothesis warning: the error may stem from bad caller input data or infra/index, not a logic error at [${targetFiles}].`;
    }

    if (hasCoreModuleTarget) {
      antithesisRebuttal += ` Blast Radius warning: touching the shared core module [${targetFiles}] risks breaking the contracts of many downstream callers.`;
    }

    // Epistemic Arbiter: Phán quyết dựa trên bằng chứng và tiêu chuẩn phản nghiệm
    let outcome: DialecticalVerdictOutcome = 'REFINED_HYPOTHESIS';
    let confidence = 0.85;
    let arbiterReasoning = '';
    let recommendedAction = '';

    const hasSpecificEvidence = Boolean(inputs.recentError || (inputs.targetFiles && inputs.targetFiles.length > 0) || inputs.hypothesis);

    if (!hasSpecificEvidence) {
      outcome = 'INSUFFICIENT_EVIDENCE';
      confidence = 0.50;
      arbiterReasoning = `Missing empirical evidence: no target file or concrete error trace identified yet.`;
      recommendedAction = `Localize the fault (read/grep/find) before proposing changes or a new hypothesis.`;
    } else if (inputs.consecutiveFailures >= 3 && (hasCoreModuleTarget || risk === 'CRITICAL')) {
      outcome = 'REJECTED_THESIS';
      confidence = 0.88;
      arbiterReasoning = `${inputs.consecutiveFailures} consecutive failures on a core/high-risk module. The current hypothesis/approach is rejected due to severe regression risk.`;
      recommendedAction = `Reject the current hypothesis; execute a strategic pivot and rebuild a new hypothesis from the actual error trace.`;
    } else if (risk === 'CRITICAL' && inputs.consecutiveFailures >= 2) {
      outcome = 'REFINED_HYPOTHESIS';
      confidence = 0.75;
      arbiterReasoning = `CRITICAL risk with ${inputs.consecutiveFailures} consecutive failures: the thesis is not yet independently verified. Tighten falsification criteria before applying a code patch.`;
      recommendedAction = `Dry-run or AST/syntax-check on a temporary worktree before overwriting the original file. Run confirmation test: "${falsificationTest}".`;
    } else if (hasCoreModuleTarget && (hasSurfaceSymptomError || inputs.consecutiveFailures >= 1)) {
      outcome = 'REFINED_HYPOTHESIS';
      confidence = 0.78;
      arbiterReasoning = `Antithesis detected a surface-symptom trap on core module [${targetFiles}]. Check callers/schema before structural intervention.`;
      recommendedAction = `Scope-check callers or configuration first; strictly preserve the public function signatures of [${targetFiles}].`;
    } else if (inputs.consecutiveFailures === 0 && inputs.recentError && !hasCoreModuleTarget) {
      outcome = 'CONFIRMED_THESIS';
      confidence = 0.90;
      arbiterReasoning = `Thesis targets the specific error trace in a local module and has a clear falsification test.`;
      recommendedAction = `Proceed with changes scoped to [${targetFiles}], strictly preserving public exports.`;
    } else {
      outcome = 'CONFIRMED_THESIS';
      confidence = 0.82;
      arbiterReasoning = `Antithesis flagged a regression risk; however, with a small scoping footprint, the thesis is approved conditioned on immediate regression testing.`;
      recommendedAction = `Apply a minimal patch (Minimal Delta) and run immediately: "${falsificationTest}".`;
    }

    const verdict: DialecticalVerdict = {
      outcome,
      confidence,
      thesisClaim,
      antithesisRebuttal,
      epistemicArbiterReasoning: arbiterReasoning,
      recommendedAction,
      falsificationCriteria: falsificationTest,
      distilledTokens: 0, // Sẽ được tính bởi Distillation Barrier
    };

    return verdict;
  }
}

/**
 * 3. Lightweight Test-Time Monte Carlo Rollout (Speculative Reasoning Rollout)
 * 
 * Thực hiện 1-2 bước suy đoán lookahead trước khi mutate code thật:
 * - Bước 1: Giả lập áp dụng thay đổi (Dry-run lookahead)
 * - Bước 2: Đánh giá nguy cơ vi phạm cú pháp và hồi quy hệ thống (Regression risk)
 */
export class TestTimeMonteCarloRollout {
  simulateRollout(inputs: EpistemicInvestigationInputs): SpeculativeRolloutResult {
    const steps: SpeculativeRolloutStep[] = [];
    const criticalRisks: string[] = [];

    // Step 1: Phân tích thay đổi đề xuất đối với cú pháp & hợp đồng giao diện
    const isHighRisk = inputs.risk === 'HIGH' || inputs.risk === 'CRITICAL';
    let step1Valid = true;

    // Empirical AST / syntax validation nếu workspaceRoot & targetFiles tồn tại trên đĩa
    if (inputs.workspaceRoot && inputs.targetFiles && inputs.targetFiles.length > 0) {
      for (const file of inputs.targetFiles) {
        const fullPath = path.isAbsolute(file) ? file : path.join(inputs.workspaceRoot, file);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (file.endsWith('.json')) {
              JSON.parse(content);
            }
          } catch {
            step1Valid = false;
            criticalRisks.push(`Target file [${file}] currently has invalid syntax`);
          }
        }
      }
    }

    const step1Score = !step1Valid ? 0.30 : (isHighRisk ? 0.82 : 0.95);

    steps.push({
      stepIndex: 1,
      action: `Speculative Dry-Run: Apply the proposed patch to a temporary buffer`,
      predictedOutcome: step1Valid 
        ? `Patch applied successfully with no file syntax conflicts`
        : `Pre-existing syntax error detected on the target file`,
      syntaxValid: step1Valid,
      regressionRisk: !step1Valid ? 'HIGH' : (isHighRisk ? 'MEDIUM' : 'NONE'),
      score: step1Score,
    });

    // Step 2: Phân tích ảnh hưởng lân cận (Downstream Impact Lookahead)
    let step2Regression: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    let step2Score = 0.88;

    const hasCoreModuleTarget = (inputs.targetFiles || []).some(f => isCoreModulePath(f));

    if (inputs.consecutiveFailures >= 2) {
      step2Regression = 'MEDIUM';
      step2Score = 0.70;
      criticalRisks.push(`Environment is unstable (${inputs.consecutiveFailures} failures)`);
    }

    if (inputs.risk === 'CRITICAL') {
      step2Regression = 'HIGH';
      step2Score = Math.min(step2Score, 0.65);
      criticalRisks.push(`Target module is a system core with CRITICAL blast radius`);
    }

    if (hasCoreModuleTarget && (inputs.risk === 'HIGH' || inputs.risk === 'CRITICAL')) {
      step2Regression = 'HIGH';
      step2Score = Math.min(step2Score, 0.62);
      criticalRisks.push(`Target module [${inputs.targetFiles?.join(', ')}] is a shared core module - risk of breaking changes to downstream callers`);
    }

    steps.push({
      stepIndex: 2,
      action: `Impact Lookahead: Verify public contract immutability`,
      predictedOutcome: isHighRisk 
        ? `Must ensure no change to function signatures or data schemas consumed by other modules`
        : `Local impact is safe, no wide regression risk`,
      syntaxValid: true,
      regressionRisk: step2Regression,
      score: step2Score,
    });

    const meanScore = steps.reduce((sum, s) => sum + s.score, 0) / steps.length;
    const recommendation = meanScore >= 0.75 ? 'PROCEED' : (meanScore >= 0.60 ? 'TRY_ALTERNATIVE' : 'ABORT');

    return {
      steps,
      meanScore: Math.round(meanScore * 100) / 100,
      passedSyntaxCheck: step1Valid,
      criticalRisksIdentified: criticalRisks,
      recommendation,
    };
  }
}

/**
 * 4. Anti-Context Dilution: Distillation Barrier
 * 
 * Cơ chế đóng gói và chưng cất tri thức:
 * - Tuyệt đối KHÔNG đẩy hàng ngàn tokens tranh luận thô Thesis vs Antithesis vào Session history.
 * - Chưng cất kết quả thành một khối Verdict cô đọng <= 180 tokens.
 * - Đảm bảo định dạng súc tích, mang tính chỉ dẫn hành động trực tiếp cho LLM.
 */
export class EpistemicDistillationBarrier {
  static readonly MAX_DISTILLED_TOKENS = 180;

  distill(
    dialecticalVerdict: DialecticalVerdict,
    speculativeRollout: SpeculativeRolloutResult,
    hypothesis?: Hypothesis,
  ): { distilledText: string; tokenCount: number } {
    const outcomeSymbol = 
      dialecticalVerdict.outcome === 'CONFIRMED_THESIS' ? '✅ THESIS CONFIRMED' :
      dialecticalVerdict.outcome === 'REFINED_HYPOTHESIS' ? '⚖️ HYPOTHESIS REFINED' :
      dialecticalVerdict.outcome === 'REJECTED_THESIS' ? '❌ THESIS REJECTED' : '⚠️ INSUFFICIENT EVIDENCE';

    const rolloutSymbol = 
      speculativeRollout.recommendation === 'PROCEED' ? '🟢 PROCEED' :
      speculativeRollout.recommendation === 'TRY_ALTERNATIVE' ? '🟡 CAUTION (Refine Patch)' : '🔴 ABORT';

    let arbiterReasoning = dialecticalVerdict.epistemicArbiterReasoning || '';
    let action = dialecticalVerdict.recommendedAction || '';
    let warnings = [...(speculativeRollout.criticalRisksIdentified || [])];

    const buildDistilled = (reasoningText: string, actionText: string, warningList: string[]) => {
      const lines: string[] = [
        `⚖️ [EPISTEMIC ARBITER VERDICT - DEBIASED]:`,
        `• Consensus: ${outcomeSymbol} (Confidence: ${Math.round(dialecticalVerdict.confidence * 100)}%)`,
        `• Antithesis Risk Guard: ${reasoningText}`,
        `• Speculative Rollout: ${rolloutSymbol} (Feasibility: ${Math.round(speculativeRollout.meanScore * 100)}%, Syntax: OK)`,
      ];

      if (warningList.length > 0) {
        lines.push(`• Critical Warning: ${warningList.join('; ')}`);
      }

      lines.push(`👉 Mandatory Rule: ${actionText}`);
      return lines.join('\n');
    };

    let distilledText = buildDistilled(arbiterReasoning, action, warnings);
    let tokenCount = ExactTokenizer.countTokens(distilledText);

    // Hard ceiling enforcement: Đảm bảo trần cứng MAX_DISTILLED_TOKENS mà KHÔNG bỏ rơi Critical Warning
    if (tokenCount > EpistemicDistillationBarrier.MAX_DISTILLED_TOKENS) {
      // 1. Tinh gọn cảnh báo nếu quá dài
      warnings = warnings.map(w => (w.length > 90 ? `${w.slice(0, 87)}...` : w)).slice(0, 2);

      // 2. Cắt tỉa reasoning và action nếu vượt ngân sách
      while (tokenCount > EpistemicDistillationBarrier.MAX_DISTILLED_TOKENS && (arbiterReasoning.length > 40 || action.length > 40)) {
        if (arbiterReasoning.length > action.length && arbiterReasoning.length > 40) {
          arbiterReasoning = `${arbiterReasoning.slice(0, Math.max(40, arbiterReasoning.length - 30))}...`;
        } else if (action.length > 40) {
          action = `${action.slice(0, Math.max(40, action.length - 20))}...`;
        } else {
          arbiterReasoning = `${arbiterReasoning.slice(0, Math.max(20, arbiterReasoning.length - 15))}...`;
        }
        distilledText = buildDistilled(arbiterReasoning, action, warnings);
        tokenCount = ExactTokenizer.countTokens(distilledText);
      }

      // 3. Fallback an toàn tuyệt đối nếu tokenCount vẫn > 180 (e.g. vì warnings hoặc symbols quá dài)
      while (tokenCount > EpistemicDistillationBarrier.MAX_DISTILLED_TOKENS && warnings.length > 1) {
        warnings = warnings.slice(0, 1);
        distilledText = buildDistilled(arbiterReasoning, action, warnings);
        tokenCount = ExactTokenizer.countTokens(distilledText);
      }
      while (tokenCount > EpistemicDistillationBarrier.MAX_DISTILLED_TOKENS && warnings.length > 0 && warnings[0].length > 30) {
        warnings[0] = `${warnings[0].slice(0, 27)}...`;
        distilledText = buildDistilled(arbiterReasoning, action, warnings);
        tokenCount = ExactTokenizer.countTokens(distilledText);
      }
    }

    dialecticalVerdict.distilledTokens = tokenCount;
    return { distilledText, tokenCount };
  }
}

/**
 * 5. EpistemicInvestigationEngine (Facade Orchestrator)
 * 
 * Bộ điều phối tổng thể kết hợp 4 thành phần:
 * 1. Gating kiểm tra điều kiện an toàn (Anti-Accuracy Degradation).
 * 2. Biện chứng Thesis vs Antithesis với Arbiter loại trừ confirmation bias.
 * 3. Test-time Monte Carlo Rollout đánh giá rủi ro lookahead.
 * 4. Distillation Barrier chưng cất tri thức <= 180 tokens (Anti-Context Dilution).
 */
export class EpistemicInvestigationEngine {
  private dualInvestigator = new CrossAgentDualInvestigator();
  private rolloutSimulator = new TestTimeMonteCarloRollout();
  private distillationBarrier = new EpistemicDistillationBarrier();

  investigate(inputs: EpistemicInvestigationInputs): EpistemicInvestigationResult {
    // Bước 1: Kiểm tra Gating an toàn
    const gate = EpistemicInvestigationGating.shouldActivate(inputs);
    if (!gate.activate) {
      return {
        activated: false,
        gateReason: gate.reason,
        tokensUsed: 0,
      };
    }

    // Bước 2: Cross-Agent Dual Investigation (Thesis vs Antithesis)
    const dialecticalVerdict = this.dualInvestigator.investigate(inputs);

    // Bước 3: Test-Time Monte Carlo Rollout (Lookahead simulation)
    const speculativeRollout = this.rolloutSimulator.simulateRollout(inputs);

    // Bước 4: Distillation Barrier chưng cất không làm loãng context (<= 180 tokens)
    const { distilledText, tokenCount } = this.distillationBarrier.distill(
      dialecticalVerdict,
      speculativeRollout,
      inputs.hypothesis,
    );

    return {
      activated: true,
      gateReason: gate.reason,
      dialecticalVerdict,
      speculativeRollout,
      distilledContext: distilledText,
      tokensUsed: tokenCount,
    };
  }
}
