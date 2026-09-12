import { createHash } from 'node:crypto';
import { isReadOnlyRequest, normalizeRequestIntentText } from './request-intent.js';
import type { ClassificationDecision, Capability, ControlRisk, TaskClass, TaskComplexity, TaskPhase } from './classification-types.js';

export interface ClassificationInput {
  request?: string;
  userPrompt?: string;
  prompt?: string;
  activeTask?: string;
  activeAcceptance?: string;
  hasPlan?: boolean;
  hasUnverifiedChanges?: boolean;
  lastToolName?: string;
  lastToolFailed?: boolean;
  previous?: ClassificationDecision;
  hasValidatedHypothesis?: boolean;
  hasDirectEvidence?: boolean;
  evidenceScore?: number;
  evidenceThreshold?: number;
  minimumRisk?: ControlRisk;
}

const mutationIntent = /\b(?:implement|fix|change|modify|update|create|delete|rename|refactor|migrate|upgrade|add|remove|write|patch|sua|trien khai|thuc hien|thuc thi|cap nhat|tao|xoa|doi ten|tich hop|bo sung|them|cai tien|ap dung)\b/i;
const bugIntent = /\b(?:bug|error|fail|broken|debug|diagnos|root cause|loi|hong|khong hoat dong|nguyen nhan)\b/i;
const refactorIntent = /\b(?:refactor|rename|extract|split|move|restructure|tai cau truc)\b/i;
const releaseIntent = /\b(?:deploy|publish|release|push|production|phat hanh|trien khai production)\b/i;
const verifyIntent = /\b(?:test|verify|verification|build|lint|typecheck|kiem thu|xac minh|doi chieu)\b/i;
const exploreIntent = /\b(?:explain|inspect|investigate|review|analy[sz]e|how|why|what|kiem tra|phan tich|danh gia|giai thich|tim hieu)\b/i;

export class ClassificationEngine {
  classify(input: ClassificationInput): ClassificationDecision {
    const rawPrompt = input.request || input.userPrompt || input.prompt || '';
    const text = [rawPrompt, input.activeTask, input.activeAcceptance].filter(Boolean).join(' ').trim();
    const normalizedText = normalizeRequestIntentText(text);
    const reasons: string[] = [];
    let taskClass: TaskClass = 'question';
    let phase: TaskPhase = 'explore';
    let complexity: TaskComplexity = 'small';
    let risk: ControlRisk = 'R0';
    let capabilities: Capability[] = ['inspect', 'search', 'memory'];

    if (isReadOnlyRequest(rawPrompt) && !input.hasUnverifiedChanges) {
      taskClass = 'exploration';
      reasons.push('READ_ONLY_EXPLANATION_OR_PROPOSAL');
    } else if (releaseIntent.test(normalizedText)) {
      taskClass = 'release'; phase = 'release'; complexity = 'large'; risk = 'R4';
      capabilities = ['inspect', 'execute', 'verify', 'git-read', 'git-write', 'network', 'complete'];
      reasons.push('RELEASE_OR_EXTERNAL_MUTATION');
    } else if (
      input.hasUnverifiedChanges
      || (input.previous?.phase === 'implement' && verifyIntent.test(normalizedText))
      || (input.previous?.phase === 'verify' && input.lastToolName === 'run_command' && !input.lastToolFailed)
    ) {
      taskClass = input.previous?.taskClass || 'feature'; phase = 'verify'; risk = input.previous?.risk || 'R2';
      complexity = input.previous?.complexity || 'medium';
      capabilities = ['inspect', 'execute', 'verify', 'git-read', 'complete'];
      reasons.push(input.hasUnverifiedChanges ? 'UNVERIFIED_MUTATION_EXISTS' : 'VERIFICATION_PHASE_STICKY_UNTIL_COMPLETION');
    } else if (mutationIntent.test(normalizedText)) {
      taskClass = refactorIntent.test(normalizedText) ? 'refactor' : bugIntent.test(normalizedText) ? 'bugfix' : 'feature';
      complexity = /\b(?:architecture|system|migration|multiple|all|kien truc|he thong|lo trinh|toan bo)\b/i.test(normalizedText) ? 'large' : 'medium';
      risk = complexity === 'large' ? 'R3' : 'R2';

      const evidenceThreshold = Math.max(1, input.evidenceThreshold || 1);
      const hasEnoughEvidence = Boolean(
        input.hasValidatedHypothesis
        || input.hasDirectEvidence
        || (input.evidenceScore || 0) >= evidenceThreshold
      );
      const requiresEvidenceFirst = (taskClass === 'bugfix' || taskClass === 'refactor') && !hasEnoughEvidence;
      if (requiresEvidenceFirst) {
        phase = 'explore';
        capabilities = ['inspect', 'search', 'plan', 'memory', 'verify'];
        reasons.push('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE');
      } else {
        phase = input.hasPlan || complexity !== 'large' ? 'implement' : 'plan';
        capabilities = ['inspect', 'search', 'plan', 'memory', 'edit', 'execute', 'verify', 'git-read', 'complete'];
        if ((taskClass === 'bugfix' || taskClass === 'refactor') && hasEnoughEvidence) {
          reasons.push('PARETO_EVIDENCE_FAST_PATH');
        }
        reasons.push(refactorIntent.test(normalizedText) ? 'REFACTOR_INTENT' : 'WORKSPACE_MUTATION_INTENT');
      }
    } else if (bugIntent.test(normalizedText)) {
      taskClass = 'bugfix'; phase = 'explore'; complexity = 'medium'; risk = 'R1';
      capabilities = ['inspect', 'search', 'execute', 'verify', 'memory'];
      reasons.push('BUG_REQUIRES_DIAGNOSIS');
    } else if (verifyIntent.test(normalizedText)) {
      taskClass = 'exploration'; phase = 'verify'; complexity = 'small'; risk = 'R1';
      capabilities = ['inspect', 'execute', 'verify', 'git-read'];
      reasons.push('VERIFICATION_INTENT');
    } else if (exploreIntent.test(normalizedText)) {
      taskClass = 'exploration';
      reasons.push('READ_ONLY_EXPLORATION');
    } else {
      reasons.push('CONSERVATIVE_READ_ONLY_DEFAULT');
    }

    const needsNetwork = /\b(?:web|internet|online|latest|documentation|docs|website|truc tuyen|moi nhat)\b/i.test(normalizedText);
    if (needsNetwork && !capabilities.includes('network')) {
      capabilities.push('network');
      if (risk === 'R0') risk = 'R1';
      reasons.push('NETWORK_INFORMATION_REQUIRED');
    }
    if (complexity === 'large' && !capabilities.includes('delegate')) {
      capabilities.push('delegate');
      reasons.push('PARALLEL_DELEGATION_ELIGIBLE');
    }

    if (input.lastToolFailed && input.previous && input.previous.phase !== 'release') {
      const preserveMutationCapability = mutationIntent.test(normalizedText)
        && input.previous.requiredCapabilities.includes('edit')
        && (input.previous.phase === 'implement' || input.previous.phase === 'verify');
      if (preserveMutationCapability) {
        phase = 'implement';
        capabilities = Array.from(new Set<Capability>([
          ...input.previous.requiredCapabilities,
          'inspect',
          'search',
          'edit',
          'execute',
          'verify',
        ]));
        reasons.push('FAILED_ACTION_PRESERVE_MUTATION_CAPABILITY');
      } else {
        phase = 'explore';
        capabilities = Array.from(new Set<Capability>(['inspect', 'search', 'memory', ...(risk === 'R0' ? [] : ['execute' as Capability])]));
        reasons.push('FAILED_ACTION_RECLASSIFY_TO_EXPLORE');
      }
    }

    if (input.minimumRisk) {
      const riskRank: Record<ControlRisk, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };
      if (riskRank[input.minimumRisk] > riskRank[risk]) {
        risk = input.minimumRisk;
        reasons.push('HYPOTHESIS_BLAST_RADIUS_RISK_FLOOR');
      }
    }

    const confidence = text.length < 8 ? 0.55 : reasons.includes('CONSERVATIVE_READ_ONLY_DEFAULT') ? 0.65 : 0.9;
    const stable = JSON.stringify({ taskClass, phase, complexity, risk, capabilities, text: normalizedText });
    return {
      id: `class-${createHash('sha256').update(stable).digest('hex').slice(0, 16)}`,
      version: 1,
      taskClass,
      phase,
      complexity,
      externality: taskClass === 'release' ? 'external-state' : needsNetwork ? 'network' : 'local',
      reversibility: risk === 'R0' ? 'read-only' : risk >= 'R4' ? 'hard-to-reverse' : 'reversible',
      risk,
      requiredCapabilities: capabilities,
      confidence,
      fastPath: complexity === 'trivial'
        || (risk === 'R0' && !input.hasPlan)
        || Boolean(input.hasDirectEvidence && (risk === 'R1' || risk === 'R2')),
      reasonCodes: reasons,
      createdAt: new Date().toISOString(),
    };
  }
}
