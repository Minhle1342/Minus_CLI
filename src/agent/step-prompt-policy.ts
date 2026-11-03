import type { ClassificationDecision, TaskPhase } from '../control/classification-types.js';
import type { CompletionObservation } from './completion-observations.js';
import { resolveGitWorkflow, gitWorkflowGuidance, type GitWorkflowState } from './git-workflow.js';
import { isMutationTool as isSharedMutationTool } from '../tools/diff-generator.js';
import {
  SECTION_TOOL_PLAYBOOKS,
  type ToolPlaybookPromptId,
  resolveVerifyPlaybookPrompt,
  GIT_WORKFLOW_PROMPTS,
  type GitWorkflowPromptId,
  SECTION_GIT_OPERATIONS,
  SECTION_FRONTEND_UI,
  SECTION_CODEBASE_INTELLIGENCE,
  SECTION_TASK_ORCHESTRATOR_BOUNDARIES,
  needsFrontendGuidance,
  needsCodebaseIntelligenceGuidance,
  needsSubagentOrchestratorGuidance,
} from '../llm/prompt-sections.js';

export type StepPromptGatingMode = 'off' | 'shadow' | 'enforce';

export interface StepPromptCandidates {
  legacyPlanContext: string;
  stepPlanContext: string;
  advicePrompt: string;
  advicePlaybook?: string;
  harnessGuidance: string;
  scaffoldPrompt: string;
  legacyScaffoldPrompt?: string;
}

export interface StepPromptPolicyContext {
  activeStepQuery: string;
  /** Human request only; generated plan steps do not authorize Git mutations. */
  userRequest?: string;
  gitWorkflowObservations?: readonly CompletionObservation[];
  gitWorkflowMayEdit?: boolean;
  gitWorkflowImplementationRequested?: boolean;
  gitWorkflowImplementationReady?: boolean;
  fingerprint: string;
  failureSignature?: string;
  classification: ClassificationDecision;
  previousPhase?: TaskPhase;
  activeTask?: { title?: string; acceptanceCriteria?: string };
  hasPlan: boolean;
  planRequired: boolean;
  planIncomplete: boolean;
  planBlocked: boolean;
  readyTaskCount: number;
  visibleToolNames: string[];
  lastToolName?: string;
  lastToolResult?: unknown;
  consecutiveFailures: number;
  hasValidatedHypothesis: boolean;
  paretoEvidenceSufficient?: boolean;
  paretoUncertainty?: 'low' | 'medium' | 'high';
  hasSubmittedSolution: boolean;
  hasVerifiedTests: boolean;
  activeAgentCount: number;
  /** True when the turn prompt carries @-attached files (anchors + 2-hop neighborhood). */
  hasAttachments?: boolean;
  harnessProfileName: 'strict-verification' | 'velocity-first' | 'read-only-guard' | 'balanced-default';
  candidates: StepPromptCandidates;
  /** Dynamic Strong Advisory signals (downgraded from hard blocks). */
  cascadeFrozen?: boolean;
  cascadeReason?: string;
  evidenceScore?: number;
  evidenceThreshold?: number;
  evidenceReasons?: string[];
  reproductionEnforced?: boolean;
  hasPostFixPass?: boolean;
  /** Whether the workspace has frontend/UI dependencies (React, Vue, Tailwind, etc.). */
  isFrontendWorkspace?: boolean;
  /** File paths touched or referenced in the active turn. */
  touchedFiles?: string[];
  /** Whether codebase intelligence tools are registered and available. */
  hasCodebaseTools?: boolean;
  /** Whether subagent / task delegation tools are registered and available. */
  hasSubagentTools?: boolean;
}

export interface StepPromptDecision {
  requestedMode: StepPromptGatingMode;
  effectiveMode: StepPromptGatingMode;
  conservativeFallback: boolean;
  reasonCodes: string[];
  selectedPlaybooks: ToolPlaybookPromptId[];
  selectedGitPlaybook?: GitWorkflowPromptId;
  gitWorkflow?: GitWorkflowState;
  includeStaticToolPlaybooks: boolean;
  includeStaticFrontendUI: boolean;
  includeStaticCodebaseIntelligence: boolean;
  includeStaticTaskOrchestrator: boolean;
  toolPlaybookPrompt: string;
  gitPlaybookPrompt: string;
  dynamicFrontendGuidance?: string;
  dynamicCodebaseIntelligenceGuidance?: string;
  dynamicOrchestratorGuidance?: string;
  planContext: string;
  advicePrompt: string;
  harnessGuidance: string;
  scaffoldPrompt: string;
  /** Dynamic non-blocking Strong Advisory (always injected when non-empty, any mode). */
  strongAdvisoryPrompt: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  injectedEstimatedTokens: number;
}

function estimateTokens(parts: Array<string | undefined>): number {
  const chars = parts.filter(Boolean).join('\n\n').length;
  return Math.ceil(chars / 4);
}

function stringifyResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  try {
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function isMutationTool(toolName?: string): boolean {
  if (!toolName) return false;
  // Single source of truth lives in tools/diff-generator.ts (FILE_MUTATION_TOOLS).
  // run_command is intentionally NOT a blanket mutation:
  // read-only shell (ls, git status/diff) must not trigger mutation advice.
  return isSharedMutationTool(toolName);
}

const STRONG_ADVISORY_HEADER = '[STRONG ADVISORY — ACTION GUIDELINE (non-blocking, tool still executes)]';

function extractCarriedAdvisories(lastToolResult: unknown): string[] {
  if (!lastToolResult || typeof lastToolResult !== 'object') return [];
  const rec = lastToolResult as Record<string, unknown>;
  const warnings = (rec as { _guardian_warnings?: unknown })._guardian_warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((w): w is string => typeof w === 'string')
    .filter((w) => w.includes('STRONG ADVISORY'))
    .slice(-2);
}

/** Dynamic Strong Advisory for CASCADE + UNVERIFIED_MUTATION (plus reproduction carry-forward). Only emit what is currently missing. */
function buildStrongAdvisoryPrompt(context: StepPromptPolicyContext): { text: string; codes: string[] } {
  if (context.hasSubmittedSolution) return { text: '', codes: [] };
  const blocks: string[] = [];
  const codes: string[] = [];
  for (const carried of extractCarriedAdvisories(context.lastToolResult)) {
    blocks.push(carried);
    codes.push('CARRIED_GUARDIAN_ADVISORY');
  }
  if (context.cascadeFrozen) {
    const detail = context.cascadeReason ? ` ${context.cascadeReason}.` : '';
    blocks.push(
      `${STRONG_ADVISORY_HEADER}\n[CASCADE_REPAIR_ADVISORY]: Repeated fixes keep failing on the same error signature.${detail} Re-evaluate the underlying hypothesis and diagnostics before further edits.`,
    );
    codes.push('CASCADE_REPAIR_ADVISORY');
  }
  const evidenceTask = ['bugfix', 'refactor', 'security'].includes(String(context.classification.taskClass));
  const score = context.evidenceScore ?? 0;
  const threshold = Math.max(1, context.evidenceThreshold ?? 3);
  if (evidenceTask && !context.hasValidatedHypothesis && context.paretoEvidenceSufficient !== true && score < threshold) {
    const reasons = context.evidenceReasons?.length ? ` Current evidence: ${context.evidenceReasons.join(', ')}.` : '';
    blocks.push(
      `${STRONG_ADVISORY_HEADER}\n[UNVERIFIED_MUTATION_ADVISORY]: Current evidence (${score}/${threshold}, risk ${context.classification.risk}).${reasons} Inspect the target before broad edits.`,
    );
    codes.push('UNVERIFIED_MUTATION_ADVISORY');
  }
  if (context.reproductionEnforced && !context.hasPostFixPass && context.classification.taskClass === 'bugfix') {
    blocks.push(
      `${STRONG_ADVISORY_HEADER}\n[REPRODUCTION_VERIFICATION_ADVISORY]: Bugfix currently lacks observed post-fix test pass. Verify the fix empirically before completing.`,
    );
    codes.push('REPRODUCTION_VERIFICATION_ADVISORY');
  }
  if (blocks.length === 0) return { text: '', codes: [] };
  return { text: blocks.join('\n\n'), codes: [...new Set(codes)] };
}

export function resolveStepPromptGatingMode(
  configured?: StepPromptGatingMode,
  environmentValue = process.env.MINUS_STEP_PROMPT_GATING,
): StepPromptGatingMode {
  if (configured) return configured;
  const normalized = environmentValue?.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'shadow' || normalized === 'enforce') return normalized;
  return 'shadow';
}

/** Deterministic, zero-LLM selector for model-visible guidance on one agent step. */
export class StepPromptPolicy {
  decide(context: StepPromptPolicyContext, mode: StepPromptGatingMode): StepPromptDecision {
    const query = context.activeStepQuery.trim();
    const confidence = context.classification.confidence;
    const inconsistent = context.hasSubmittedSolution && context.visibleToolNames.length > 0;
    const conservativeFallback = mode === 'enforce' && (!query || confidence < 0.8 || inconsistent);
    const useLegacyInjection = mode !== 'enforce' || conservativeFallback;
    const reasonCodes: string[] = [];

    if (!query) reasonCodes.push('EMPTY_ACTIVE_STEP_QUERY');
    if (confidence < 0.8) reasonCodes.push('LOW_CLASSIFICATION_CONFIDENCE');
    if (inconsistent) reasonCodes.push('POST_SUBMISSION_TOOLS_STILL_VISIBLE');
    if (mode === 'shadow') reasonCodes.push('SHADOW_LEGACY_INJECTION');
    if (mode === 'off') reasonCodes.push('GATING_DISABLED');
    if (conservativeFallback) reasonCodes.push('CONSERVATIVE_FALLBACK');

    const selectedPlaybooks: ToolPlaybookPromptId[] = [];
    const lower = query.toLowerCase();
    const capabilities = new Set(context.classification.requiredCapabilities);
    const lastResult = stringifyResult(context.lastToolResult).toLowerCase();
    const lastToolFailed = Boolean(context.failureSignature)
      || /(error|failed|failure|exception|exitcode[^0-9]*[1-9])/.test(lastResult);

    if (!context.hasSubmittedSolution && !context.hasVerifiedTests && context.classification.phase === 'verify') {
      selectedPlaybooks.push('verifyDiff');
    }

    if (selectedPlaybooks.length > 0) reasonCodes.push(`PLAYBOOKS_${selectedPlaybooks.join('_').toUpperCase()}`);
    else reasonCodes.push('NO_STEP_PLAYBOOK_REQUIRED');

    if (context.hasAttachments && !context.hasSubmittedSolution) {
      reasonCodes.push('ATTACHMENT_NEIGHBORHOOD');
    }

    const gitWorkflow = context.hasSubmittedSolution ? undefined : resolveGitWorkflow({
      userRequest: context.userRequest ?? '',
      observations: context.gitWorkflowObservations ?? [],
      mayEdit: context.gitWorkflowMayEdit ?? (capabilities.has('edit') && context.classification.reversibility !== 'read-only'),
      implementationRequested: context.gitWorkflowImplementationRequested,
      implementationReady: context.gitWorkflowImplementationReady ?? (!context.planBlocked && !context.planIncomplete),
    });
    const selectedGitPlaybook: GitWorkflowPromptId | undefined = gitWorkflow?.playbook
      ?? (!context.hasSubmittedSolution && !gitWorkflow && /(?:\bgit\s+(?:status|diff|log|show|blame|rev-parse|reflog|ls-files|branch\s+(?:-a|-v|--show-current)|stash\s+(?:list|show))\b|working tree|uncommitted|baseline|trạng thái git|kiểm tra git)/i.test(lower) ? 'gitInspect' : undefined);
    if (gitWorkflow) reasonCodes.push(`GIT_WORKFLOW_${gitWorkflow.stage.toUpperCase()}`);

    if (selectedGitPlaybook) {
      reasonCodes.push(`GIT_PLAYBOOK_${selectedGitPlaybook.toUpperCase()}`);
    }

    const phaseChanged = Boolean(context.previousPhase && context.previousPhase !== context.classification.phase);
    const isInitialBugReport = !context.lastToolName && context.candidates.advicePlaybook === 'B_DEBUGGING';
    const actionableAdvice = context.hasSubmittedSolution
      || lastToolFailed
      || isMutationTool(context.lastToolName)
      || phaseChanged
      || isInitialBugReport
      || (Boolean(context.activeTask) && context.candidates.advicePlaybook !== 'GENERAL');
    const includeAdvice = !context.hasVerifiedTests && actionableAdvice;
    if (includeAdvice) reasonCodes.push('ACTIONABLE_TOOL_ADVICE');

    const highRisk = ['R3', 'R4', 'R5'].includes(context.classification.risk)
      || String(context.classification.taskClass) === 'security';
    const evidenceSufficient = context.hasValidatedHypothesis || context.paretoEvidenceSufficient === true;
    const includeHarnessGuidance = (
      context.harnessProfileName === 'strict-verification'
        ? (highRisk
          ? (!context.hasValidatedHypothesis || !context.hasVerifiedTests)
          : (!evidenceSufficient || (context.classification.phase === 'verify' && !context.hasVerifiedTests)))
        : context.harnessProfileName === 'velocity-first'
          ? ['plan', 'implement'].includes(context.classification.phase)
          : context.harnessProfileName === 'read-only-guard'
            ? confidence < 0.9 && context.visibleToolNames.some(isMutationTool)
            : (highRisk && !evidenceSufficient)
              || (context.classification.phase === 'verify' && !context.hasVerifiedTests)
    );
    if (includeHarnessGuidance) reasonCodes.push(`HARNESS_${context.harnessProfileName.toUpperCase()}`);

    // Cognitive Scaffold removed per policy guidance to allow model autonomy

    const includePlanContext = context.planRequired || (context.hasPlan && context.planIncomplete);
    if (includePlanContext) reasonCodes.push(context.planBlocked ? 'PLAN_BLOCKED_CONTEXT' : 'ACTIVE_PLAN_CONTEXT');

    const strongAdvisory = buildStrongAdvisoryPrompt(context);
    if (strongAdvisory.text) {
      for (const code of strongAdvisory.codes) reasonCodes.push(`STRONG_ADVISORY_${code}`);
    }

    const includeFrontend = needsFrontendGuidance(query, context.touchedFiles, context.isFrontendWorkspace ?? true);
    const includeCodebase = needsCodebaseIntelligenceGuidance(query, context.classification.phase, context.hasCodebaseTools ?? true);
    const includeOrchestrator = needsSubagentOrchestratorGuidance(query, context.hasSubagentTools ?? false, context.activeAgentCount);

    const dynamicFrontendGuidance = (!useLegacyInjection && includeFrontend) ? SECTION_FRONTEND_UI : '';
    const dynamicCodebaseIntelligenceGuidance = (!useLegacyInjection && includeCodebase) ? SECTION_CODEBASE_INTELLIGENCE : '';
    const dynamicOrchestratorGuidance = (!useLegacyInjection && includeOrchestrator) ? SECTION_TASK_ORCHESTRATOR_BOUNDARIES : '';

    if (!useLegacyInjection) {
      if (includeFrontend) reasonCodes.push('DYNAMIC_FRONTEND_GUIDANCE');
      if (includeCodebase) reasonCodes.push('DYNAMIC_CODEBASE_INTELLIGENCE');
      if (includeOrchestrator) reasonCodes.push('DYNAMIC_ORCHESTRATOR_GUIDANCE');
    }

    const targetPlaybookPrompt = selectedPlaybooks.length > 0
      ? resolveVerifyPlaybookPrompt(context.classification.risk)
      : '';
    const targetGitPlaybookPrompt = [
      gitWorkflow ? gitWorkflowGuidance(gitWorkflow) : '',
      selectedGitPlaybook ? GIT_WORKFLOW_PROMPTS[selectedGitPlaybook] : '',
    ].filter(Boolean).join('\n\n');
    const beforeTokens = estimateTokens([
      SECTION_TOOL_PLAYBOOKS,
      context.candidates.legacyPlanContext,
      context.candidates.advicePrompt,
      context.candidates.harnessGuidance,
    ]);
    const targetAfterTokens = estimateTokens([
      targetPlaybookPrompt,
      targetGitPlaybookPrompt,
      includePlanContext ? context.candidates.stepPlanContext : '',
      includeAdvice ? context.candidates.advicePrompt : '',
      includeHarnessGuidance ? context.candidates.harnessGuidance : '',
      strongAdvisory.text,
      dynamicFrontendGuidance,
      dynamicCodebaseIntelligenceGuidance,
      dynamicOrchestratorGuidance,
    ]);
    const injectedAfterTokens = useLegacyInjection ? beforeTokens : targetAfterTokens;
    const reportedAfterTokens = mode === 'off' || conservativeFallback
      ? beforeTokens
      : targetAfterTokens;
    const gitPlaybookPrompt = useLegacyInjection ? '' : targetGitPlaybookPrompt;

    return {
      requestedMode: mode,
      effectiveMode: conservativeFallback ? 'off' : mode,
      conservativeFallback,
      reasonCodes,
      selectedPlaybooks,
      selectedGitPlaybook,
      gitWorkflow,
      includeStaticToolPlaybooks: useLegacyInjection,
      includeStaticFrontendUI: useLegacyInjection,
      includeStaticCodebaseIntelligence: useLegacyInjection,
      includeStaticTaskOrchestrator: useLegacyInjection,
      toolPlaybookPrompt: useLegacyInjection ? '' : targetPlaybookPrompt,
      gitPlaybookPrompt,
      dynamicFrontendGuidance,
      dynamicCodebaseIntelligenceGuidance,
      dynamicOrchestratorGuidance,
      planContext: useLegacyInjection
        ? context.candidates.legacyPlanContext
        : includePlanContext ? context.candidates.stepPlanContext : '',
      advicePrompt: useLegacyInjection
        ? context.candidates.advicePrompt
        : includeAdvice ? context.candidates.advicePrompt : '',
      harnessGuidance: useLegacyInjection
        ? context.candidates.harnessGuidance
        : includeHarnessGuidance ? context.candidates.harnessGuidance : '',
      scaffoldPrompt: '',
      strongAdvisoryPrompt: strongAdvisory.text,
      estimatedTokensBefore: beforeTokens,
      estimatedTokensAfter: reportedAfterTokens,
      estimatedTokensSaved: Math.max(0, beforeTokens - reportedAfterTokens),
      injectedEstimatedTokens: injectedAfterTokens,
    };
  }
}
