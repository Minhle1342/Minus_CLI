export type ReasoningTier = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface ReasoningEscalationState {
  currentTier: ReasoningTier;
  rejectionCount: number;
  maxTier: ReasoningTier;
  escalationReasons: string[];
}

const TIER_SEQUENCE: ReasoningTier[] = ['off', 'low', 'medium', 'high', 'max'];

const TIER_BUDGETS: Record<ReasoningTier, number> = {
  off: 0,
  low: 2048,
  medium: 8192,
  high: 16384,
  max: 32768,
};

/**
 * AdaptiveReasoningController - Codex CLI Adaptive Thinking Escalation
 * 
 * Automatically escalates model thinking token budget and System 2 reasoning
 * depth whenever completion gates reject premature final answers or test failures repeat.
 */
export class AdaptiveReasoningController {
  private currentTier: ReasoningTier;
  private defaultTier: ReasoningTier;
  private rejectionCount: number = 0;
  private escalationReasons: string[] = [];

  constructor(defaultTier: ReasoningTier = 'medium') {
    this.defaultTier = defaultTier;
    this.currentTier = defaultTier;
  }

  getCurrentTier(): ReasoningTier {
    return this.currentTier;
  }

  getRejectionCount(): number {
    return this.rejectionCount;
  }

  getBudget(): number {
    return TIER_BUDGETS[this.currentTier] ?? 8192;
  }

  /**
   * Escalate reasoning effort after a rejection
   */
  escalate(reason: string): ReasoningTier {
    this.rejectionCount++;
    this.escalationReasons.push(reason);

    const currentIndex = TIER_SEQUENCE.indexOf(this.currentTier);
    if (currentIndex < TIER_SEQUENCE.length - 1) {
      this.currentTier = TIER_SEQUENCE[currentIndex + 1];
    }

    return this.currentTier;
  }

  /**
   * Reset reasoning effort back to default baseline
   */
  reset(): void {
    this.currentTier = this.defaultTier;
    this.rejectionCount = 0;
    this.escalationReasons = [];
  }

  getState(): ReasoningEscalationState {
    return {
      currentTier: this.currentTier,
      rejectionCount: this.rejectionCount,
      maxTier: 'max',
      escalationReasons: [...this.escalationReasons],
    };
  }

  getGuidancePrompt(options?: { submissionOnly?: boolean }): string {
    if (this.rejectionCount === 0) return '';

    return [
      `🧠 [ADAPTIVE REASONING ESCALATED TO "${this.currentTier.toUpperCase()}"]:`,
      `Your previous solution attempt was rejected by verification gates (${this.rejectionCount} rejection(s)).`,
      options?.submissionOnly
        ? 'Correct the submission contract using existing evidence. Inspect only missing evidence; do not introduce edits or tests for a submission-only rejection.'
        : 'Reassess the specific rejection using observed evidence and inspect only what is missing before resubmitting. This guidance does not change the provider thinking budget or authorize new operations.',
    ].join('\n');
  }
}
