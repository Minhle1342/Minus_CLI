import { createHash } from 'node:crypto';
import { hasDelegationIntent, hasExplicitPlanningDirective, isReadOnlyRequest } from './request-intent.js';
import { hasNetworkIntent } from './network-intent.js';
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

const riskRank: Record<ControlRisk, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

/**
 * The classifier no longer infers a task from prose. It starts every fresh turn
 * model-directed (`implement`, edit authority) and only narrows when the harness
 * observes state (pending mutations, a failed tool, a prior granted phase) or the
 * user wrote a literal directive (`/plan`, read-only).
 */
export class ClassificationEngine {
  classify(input: ClassificationInput): ClassificationDecision {
    const rawPrompt = input.request || input.userPrompt || input.prompt || '';
    // Quoted documents/commands are data, not authorization for execution or edits.
    const prompt = rawPrompt.replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|(?:^|\s)'[^']*'/g, ' ');
    const reasons: string[] = [];
    const previous = input.previous;

    let taskClass: TaskClass = 'feature';
    let phase: TaskPhase = 'explore';
    let complexity: TaskComplexity = 'small';
    let risk: ControlRisk = 'R1';
    let capabilities: Capability[] = ['inspect', 'search', 'memory'];

    if (previous && ['plan', 'implement', 'verify', 'release'].includes(previous.phase)) {
      // Observed state: the harness already granted this phase this turn.
      taskClass = previous.taskClass;
      phase = previous.phase;
      complexity = previous.complexity;
      risk = previous.risk;
      capabilities = [...previous.requiredCapabilities];
      reasons.push('OBSERVED_PHASE_CONTINUATION');
      if (input.lastToolFailed && phase === 'implement') {
        reasons.push('FAILED_ACTION_PRESERVE_MUTATION_CAPABILITY');
      }
      if (input.lastToolFailed && phase === 'plan' && !input.hasPlan) {
        reasons.push('FAILED_ACTION_PRESERVE_PLAN_CAPABILITY');
      }
    } else if (hasExplicitPlanningDirective(prompt)) {
      taskClass = 'feature';
      phase = 'plan';
      complexity = 'medium';
      risk = 'R2';
      capabilities = ['inspect', 'search', 'plan', 'memory'];
      reasons.push('EXPLICIT_PLANNING_INTENT');
    } else if (isReadOnlyRequest(prompt)) {
      taskClass = 'exploration';
      phase = 'explore';
      complexity = 'small';
      risk = 'R0';
      capabilities = ['inspect', 'search', 'memory'];
      reasons.push('READ_ONLY_EXPLANATION_OR_PROPOSAL');
    } else if (input.hasUnverifiedChanges) {
      taskClass = previous?.taskClass ?? 'feature';
      phase = 'verify';
      complexity = previous?.complexity ?? 'medium';
      risk = previous?.risk ?? 'R2';
      capabilities = ['inspect', 'execute', 'verify', 'git-read', 'complete', 'plan', 'edit'];
      reasons.push('UNVERIFIED_MUTATION_EXISTS');
    } else if (input.lastToolFailed) {
      phase = 'explore';
      capabilities = ['inspect', 'search', 'plan', 'memory'];
      reasons.push('FAILED_ACTION_RECLASSIFY_TO_EXPLORE');
    } else {
      // No prose inference: the model decides what to do. Hard safety policy,
      // approvals, and explicit directives still narrow this authority.
      phase = 'implement';
      complexity = 'medium';
      risk = 'R2';
      capabilities = ['inspect', 'search', 'plan', 'memory', 'edit', 'execute', 'verify', 'git-read', 'complete'];
      reasons.push('MODEL_DIRECTED_DEFAULT');
    }

    if (input.minimumRisk && riskRank[input.minimumRisk] > riskRank[risk]) {
      risk = input.minimumRisk;
      reasons.push('HYPOTHESIS_BLAST_RADIUS_RISK_FLOOR');
    }

    // The main LLM may be asked to orchestrate child agents explicitly; surface the
    // capability so gate/prompt policies treat the turn as delegation, not a plain task.
    if (hasDelegationIntent(prompt)) {
      if (!capabilities.includes('delegate')) capabilities.push('delegate');
      if (risk === 'R0') risk = 'R1';
      reasons.push('EXPLICIT_DELEGATION_INTENT');
    }

    // A pasted URL is a fact, not an inferred intent; it is the only network signal.
    const needsNetwork = hasNetworkIntent(rawPrompt);
    if (needsNetwork && !capabilities.includes('network')) {
      capabilities.push('network');
      if (risk === 'R0') risk = 'R1';
      reasons.push('NETWORK_URL_PRESENT');
    }
    if (complexity === 'large' && !capabilities.includes('delegate')) {
      capabilities.push('delegate');
      reasons.push('PARALLEL_DELEGATION_ELIGIBLE');
    }

    const confidence = prompt.trim().length < 8 ? 0.55 : 0.9;
    const stable = JSON.stringify({ taskClass, phase, complexity, risk, capabilities, text: prompt.trim() });
    return {
      id: `class-${createHash('sha256').update(stable).digest('hex').slice(0, 16)}`,
      version: 1,
      taskClass,
      phase,
      complexity,
      externality: needsNetwork ? 'network' : 'local',
      reversibility: (risk === 'R0' || phase === 'plan') ? 'read-only' : risk >= 'R4' ? 'hard-to-reverse' : 'reversible',
      risk,
      requiredCapabilities: capabilities,
      confidence,
      fastPath: complexity === 'trivial' || (risk === 'R0' && !input.hasPlan),
      reasonCodes: reasons,
      createdAt: new Date().toISOString(),
    };
  }
}
