import type {
  CriticDecision,
  CriticVerdict,
  ControlAction,
} from '../control-plane-state.js';

export interface BuildDecisionParams {
  verdict: CriticVerdict;
  score: number;
  approved: boolean;
  hardBlockers?: string[];
  missingEvidence?: string[];
  staleEvidence?: string[];
  reasons?: string[];
  authorizedNextActions?: ControlAction[];
}

export class CriticDecisionBuilder {
  static build(params: BuildDecisionParams): CriticDecision {
    const hardBlockers = params.hardBlockers || [];
    const missingEvidence = params.missingEvidence || [];
    const staleEvidence = params.staleEvidence || [];
    const reasons = params.reasons || [];
    const authorizedNextActions = params.authorizedNextActions || [];

    let critiquePrompt: string | undefined;
    if (!params.approved) {
      const parts: string[] = [
        `\n🛑 [EVIDENCE-DRIVEN CRITIC REJECTION - SCORE: ${params.score}/100]:`,
        `Decision verdict: ${params.verdict}`,
      ];

      if (hardBlockers.length > 0) {
        parts.push(`\n🚨 [HARD BLOCKERS]:`);
        for (const b of hardBlockers) parts.push(`  ❌ ${b}`);
      }

      if (staleEvidence.length > 0) {
        parts.push(`\n⏳ [STALE EVIDENCE - RE-RUN REQUIRED]:`);
        for (const s of staleEvidence) parts.push(`  ⚠️ ${s}`);
      }

      if (missingEvidence.length > 0) {
        parts.push(`\n🔍 [MISSING VERIFICATION EVIDENCE]:`);
        for (const m of missingEvidence) parts.push(`  • ${m}`);
      }

      if (reasons.length > 0) {
        parts.push(`\n📝 [REASONS & GUIDANCE]:`);
        for (const r of reasons) parts.push(`  - ${r}`);
      }

      critiquePrompt = parts.join('\n');
    }

    return {
      verdict: params.verdict,
      score: Math.max(0, Math.min(100, params.score)),
      approved: params.approved,
      hardBlockers,
      missingEvidence,
      staleEvidence,
      reasons,
      authorizedNextActions,
      critiquePrompt,
    };
  }
}
