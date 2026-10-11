/**
 * Task Complexity and Runtime Harness Profile
 * Dynamic test-time compute allocation and profile selection based on task class & phase.
 */

export interface RuntimeHarnessProfile {
  profileName: 'strict-verification' | 'velocity-first' | 'read-only-guard' | 'balanced-default';
  /** @deprecated Kept for profile API compatibility; evidence policy decides whether reproduction is required. */
  enforceScratchTest: boolean;
  criticStrictness: 'strict' | 'standard' | 'lenient';
  compactionRatioBias: number;
  guidance: string;
}

export function resolveRuntimeHarnessProfile(taskClass?: string, phase?: string): RuntimeHarnessProfile {
  const isPlanning = phase === 'plan';
  const isBugfixOrSecurity = !isPlanning && (taskClass === 'bugfix' || taskClass === 'security');
  const isExploration = isPlanning || phase === 'explore' || taskClass === 'exploration' || taskClass === 'docs';
  const isScaffoldOrFeature = !isPlanning && (taskClass === 'feature' || taskClass === 'scaffold' || taskClass === 'greenfield');

  if (isBugfixOrSecurity) {
    return {
      profileName: 'strict-verification',
      enforceScratchTest: false,
      criticStrictness: 'strict',
      compactionRatioBias: -0.05,
      guidance: '🛡️ [HARNESS PROFILE: STRICT-VERIFICATION ACTIVE]: Bugfix/security tasks require risk-proportional evidence. Use empirical verification for high-risk changes; small, easily reversible changes may proceed once the target has been read and the causal mechanism has direct evidence.',
    };
  }

  if (isExploration) {
    return {
      profileName: 'read-only-guard',
      enforceScratchTest: false,
      criticStrictness: 'standard',
      compactionRatioBias: -0.05,
      guidance: '🔍 [HARNESS PROFILE: EXPLORATION ACTIVE]: Prioritize structural survey — call read/search tools and extract context. Avoid direct source-code intervention before a plan exists.',
    };
  }

  if (isScaffoldOrFeature) {
    return {
      profileName: 'velocity-first',
      enforceScratchTest: false,
      criticStrictness: 'lenient',
      compactionRatioBias: +0.05,
      guidance: '⚡ [HARNESS PROFILE: VELOCITY-FIRST ACTIVE]: Scaffolding/new-feature task. Prioritize source-code creation speed and relax test-blocker checks in the early steps.',
    };
  }

  return {
    profileName: 'balanced-default',
    enforceScratchTest: false,
    criticStrictness: 'standard',
    compactionRatioBias: 0,
    guidance: '⚖️ [HARNESS PROFILE: BALANCED-DEFAULT ACTIVE]: Balanced operation following the standard TDD workflow.',
  };
}

export interface TaskComplexityAssessment {
  score: number;
  scaleFactor: number;
  reason: string;
}

/**
 * SWE-Reasoner Dynamic Test-Time Compute Allocation (Phase 2):
 * Đánh giá độ phức tạp tác vụ C_task dựa trên yêu cầu, phân loại và dấu vết stack trace
 * để tự động co giãn ngân sách bước (step budget) và token window tương ứng.
 */
export function calculateTaskComplexity(
  userRequest: string,
  taskClass?: string
): TaskComplexityAssessment {
  let score = 0.2;
  const reasons: string[] = [];

  if (taskClass === 'bugfix' || taskClass === 'security') {
    score += 0.35;
    reasons.push('Bugfix/security task requires deep reasoning and execution verification');
  } else if (taskClass === 'feature' || taskClass === 'refactor') {
    score += 0.25;
    reasons.push('New-feature/refactor task requires an expanded search space');
  }

  const hasStackTrace = /(?:(?:Error|Exception):|at\s+[\w$./\\-]+\s*\([^)]+:\d+:\d+\)|Traceback \(most recent call last\):)/i.test(userRequest);
  if (hasStackTrace) {
    score += 0.25;
    reasons.push('Error stack trace detected in the request');
  }

  if (userRequest.length > 500) {
    score += 0.15;
    reasons.push('Detailed request description with many constraints');
  }

  score = Math.min(1.0, Math.max(0.1, score));
  const scaleFactor = 1.0 + Math.round(score * 10) / 10;

  return {
    score,
    scaleFactor,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Standard task',
  };
}
