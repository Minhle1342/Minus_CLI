import type { ClassificationDecision, TaskPhase } from '../control/classification-types.js';
import {
  SECTION_TOOL_PLAYBOOKS,
  TOOL_PLAYBOOK_PROMPTS,
  type ToolPlaybookPromptId,
  resolveVerifyPlaybookPrompt,
  GIT_WORKFLOW_PROMPTS,
  type GitWorkflowPromptId,
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
}

export interface StepPromptDecision {
  requestedMode: StepPromptGatingMode;
  effectiveMode: StepPromptGatingMode;
  conservativeFallback: boolean;
  reasonCodes: string[];
  selectedPlaybooks: ToolPlaybookPromptId[];
  selectedGitPlaybook?: GitWorkflowPromptId;
  includeStaticToolPlaybooks: boolean;
  toolPlaybookPrompt: string;
  gitPlaybookPrompt: string;
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
  return Boolean(toolName && /^(?:apply_patch|replace_text|replace_file_content|multi_replace_file_content|write_file|write_to_file|create_file|delete_file|move_file)$/.test(toolName));
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
      `${STRONG_ADVISORY_HEADER}\n[CASCADE_REPAIR_ADVISORY]: Repeated fixes keep failing on the same error signature.${detail} Stop editing blindly — revise the root-cause hypothesis, re-plan via "update_plan_task", or run diagnostics/tests to get a genuinely new signal. Recommended: update_plan_task first, mutate after.`,
    );
    codes.push('CASCADE_REPAIR_ADVISORY');
  }
  const evidenceTask = ['bugfix', 'refactor', 'security'].includes(String(context.classification.taskClass));
  const score = context.evidenceScore ?? 0;
  const threshold = Math.max(1, context.evidenceThreshold ?? 3);
  if (evidenceTask && !context.hasValidatedHypothesis && score < threshold) {
    const reasons = context.evidenceReasons?.length ? ` Current evidence: ${context.evidenceReasons.join(', ')}.` : '';
    blocks.push(
      `${STRONG_ADVISORY_HEADER}\n[UNVERIFIED_MUTATION_ADVISORY]: Evidence is still thin (${score}/${threshold}, risk ${context.classification.risk}) — read the exact target and run formulate_and_verify_hypothesis before broad edits.${reasons} Recommended: read_file the target before mutating.`,
    );
    codes.push('UNVERIFIED_MUTATION_ADVISORY');
  }
  if (context.reproductionEnforced && !context.hasPostFixPass && context.classification.taskClass === 'bugfix') {
    blocks.push(
      `${STRONG_ADVISORY_HEADER}\n[REPRODUCTION_VERIFICATION_ADVISORY]: Bugfix has no post-fix PASS yet. Run the reproduction test and prove PASS before submit_solution; if the infra is broken, state the reason explicitly in the summary. Recommended: run_command (reproduction test).`,
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

    if (!context.hasSubmittedSolution && !context.hasVerifiedTests) {
      if (/\b(architecture|architectural|topology|dependency|dependencies|route|call[ -]?graph|blast radius|kiến trúc|phụ thuộc)\b/i.test(lower)) {
        selectedPlaybooks.push('architecture');
      }
      if (
        ['bugfix', 'security'].includes(context.classification.taskClass)
        || Boolean(context.failureSignature)
        || lastToolFailed
        || /\b(root cause|diagnos|debug|traceback|exception|nguyên nhân|lỗi)\b/i.test(lower)
      ) {
        selectedPlaybooks.push('rootCause');
      }
      if (context.classification.phase === 'implement' && capabilities.has('edit')) {
        selectedPlaybooks.push('mutation');
      }
      if (
        ['manage_task', 'schedule'].includes(context.lastToolName || '')
        || /\b(background|running|taskid|server|watcher|schedule|async|long task|tác vụ dài)\b/i.test(`${lower} ${lastResult}`)
      ) {
        selectedPlaybooks.push('longTask');
      }
      if (
        capabilities.has('delegate')
        || context.activeAgentCount > 0
        || /\b(subagent|multi-agent|delegate|parallel review|brainstorm|phân công)\b/i.test(lower)
      ) {
        selectedPlaybooks.push('subagent');
      }
      if (
        context.classification.phase === 'plan'
        || context.planRequired
        || (context.hasPlan && context.planIncomplete)
        || context.planBlocked
      ) {
        selectedPlaybooks.push('dagPlan');
      }
      if (context.classification.phase === 'verify') {
        selectedPlaybooks.push('verifyDiff');
      }
    }

    // Attachment neighborhood: @-attached files are anchors — force dependency/blast-radius
    // guidance so the model expands to hop-1/hop-2 related files instead of staring at anchors.
    if (context.hasAttachments && !context.hasSubmittedSolution) {
      if (!selectedPlaybooks.includes('architecture')) selectedPlaybooks.push('architecture');
    }

    if (selectedPlaybooks.length > 0) reasonCodes.push(`PLAYBOOKS_${selectedPlaybooks.join('_').toUpperCase()}`);
    else reasonCodes.push('NO_STEP_PLAYBOOK_REQUIRED');

    if (context.hasAttachments && !context.hasSubmittedSolution) {
      reasonCodes.push('ATTACHMENT_NEIGHBORHOOD');
    }

    let selectedGitPlaybook: GitWorkflowPromptId | undefined;

    // Gating conditions for Git Workflows:
    // Only inject at most 1 relevant playbook when specific intent/phase matches.
    // Default is 0 tokens (undefined / empty).
    if (!context.hasSubmittedSolution) {
      // 1. Rollback & Stash (Highest priority when handling failure/revert)
      if (
        context.consecutiveFailures >= 2
        || /\b(rollback|revert|restore|stash|hoàn tác|hủy thay đổi)\b/i.test(lower)
      ) {
        selectedGitPlaybook = 'gitRollback';
      }
      // 2. PR Enhancement (When explicitly dealing with PR review, PR preparation or release phase with PR intent)
      else if (
        /\b(pull request|\bpr\b|create pr|enhance pr|review pr|mô tả pr|pr-enhance)\b/i.test(lower)
        || (context.classification.phase === 'release' && /\b(pr|pull request|review)\b/i.test(lower))
      ) {
        selectedGitPlaybook = 'gitPrEnhance';
      }
      // 3. Atomic Staging & Commit (When tests are verified or query explicitly requests commit/stage)
      else if (
        (/\b(git commit|commit changes|stage files|đóng gói commit|tạo commit|git add)\b/i.test(lower)
          || (context.hasVerifiedTests && context.classification.phase === 'verify'))
        && context.consecutiveFailures === 0
      ) {
        selectedGitPlaybook = 'gitCommit';
      }
      // 4. Branch Isolation (When planning new work and branch is mentioned or plan required with branch intent)
      else if (
        (context.classification.phase === 'plan' || context.classification.phase === 'explore')
        && /\b(branch|nhánh|checkout -b|isolate branch|feature branch|tạo nhánh)\b/i.test(lower)
      ) {
        selectedGitPlaybook = 'gitBranch';
      }
      // 5. Baseline Inspection (When exploring repo state or query asks for git status/diff)
      else if (
        (context.classification.phase === 'explore' || !context.lastToolName)
        && /\b(git status|git diff|working tree|uncommitted|baseline|trạng thái git|kiểm tra git)\b/i.test(lower)
      ) {
        selectedGitPlaybook = 'gitInspect';
      }
    }

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
            : false
    );
    if (includeHarnessGuidance) reasonCodes.push(`HARNESS_${context.harnessProfileName.toUpperCase()}`);

    const antiDeception = /\b(skip tests?|ignore tests?|bypass|hardcode|quick fix|trust me|asap|sycophancy|không cần (?:đọc|chạy|test)|gấp để release)\b/i.test(lower);
    const parserTask = /\b(parser|extract|normalize|validator|phone|email|trích xuất|chuẩn hóa)\b/i.test(lower);
    const riskyMutation = ['bugfix', 'security', 'refactor'].includes(context.classification.taskClass)
      && (capabilities.has('edit') || ['explore', 'implement'].includes(context.classification.phase));
    const includeScaffold = antiDeception
      || context.consecutiveFailures >= 2
      || confidence < 0.8
      || context.hasAttachments === true
      || (riskyMutation && (!evidenceSufficient || highRisk))
      || (parserTask && context.paretoUncertainty === 'high');
    if (includeScaffold) reasonCodes.push('COGNITIVE_SCAFFOLD_REQUIRED');

    const includePlanContext = context.planRequired || (context.hasPlan && context.planIncomplete);
    if (includePlanContext) reasonCodes.push(context.planBlocked ? 'PLAN_BLOCKED_CONTEXT' : 'ACTIVE_PLAN_CONTEXT');

    const strongAdvisory = buildStrongAdvisoryPrompt(context);
    if (strongAdvisory.text) {
      for (const code of strongAdvisory.codes) reasonCodes.push(`STRONG_ADVISORY_${code}`);
    }

    const targetPlaybookPrompt = selectedPlaybooks
      .map((id) => (id === 'verifyDiff' ? resolveVerifyPlaybookPrompt(context.classification.risk) : TOOL_PLAYBOOK_PROMPTS[id]))
      .join('\n\n');
    const targetGitPlaybookPrompt = selectedGitPlaybook ? GIT_WORKFLOW_PROMPTS[selectedGitPlaybook] : '';
    const beforeTokens = estimateTokens([
      SECTION_TOOL_PLAYBOOKS,
      context.candidates.legacyPlanContext,
      context.candidates.advicePrompt,
      context.candidates.harnessGuidance,
      context.candidates.legacyScaffoldPrompt,
    ]);
    const targetAfterTokens = estimateTokens([
      targetPlaybookPrompt,
      targetGitPlaybookPrompt,
      includePlanContext ? context.candidates.stepPlanContext : '',
      includeAdvice ? context.candidates.advicePrompt : '',
      includeHarnessGuidance ? context.candidates.harnessGuidance : '',
      includeScaffold ? context.candidates.scaffoldPrompt : '',
      strongAdvisory.text,
    ]);
    const injectedAfterTokens = useLegacyInjection ? beforeTokens : targetAfterTokens;
    const reportedAfterTokens = mode === 'off' || conservativeFallback
      ? beforeTokens
      : targetAfterTokens;
    const gitPlaybookPrompt = mode === 'off' || conservativeFallback ? '' : targetGitPlaybookPrompt;

    return {
      requestedMode: mode,
      effectiveMode: conservativeFallback ? 'off' : mode,
      conservativeFallback,
      reasonCodes,
      selectedPlaybooks,
      selectedGitPlaybook,
      includeStaticToolPlaybooks: useLegacyInjection,
      toolPlaybookPrompt: useLegacyInjection ? '' : targetPlaybookPrompt,
      gitPlaybookPrompt,
      planContext: useLegacyInjection
        ? context.candidates.legacyPlanContext
        : includePlanContext ? context.candidates.stepPlanContext : '',
      advicePrompt: useLegacyInjection
        ? context.candidates.advicePrompt
        : includeAdvice ? context.candidates.advicePrompt : '',
      harnessGuidance: useLegacyInjection
        ? context.candidates.harnessGuidance
        : includeHarnessGuidance ? context.candidates.harnessGuidance : '',
      scaffoldPrompt: useLegacyInjection
        ? (context.candidates.legacyScaffoldPrompt || '')
        : includeScaffold ? context.candidates.scaffoldPrompt : '',
      strongAdvisoryPrompt: strongAdvisory.text,
      estimatedTokensBefore: beforeTokens,
      estimatedTokensAfter: reportedAfterTokens,
      estimatedTokensSaved: Math.max(0, beforeTokens - reportedAfterTokens),
      injectedEstimatedTokens: injectedAfterTokens,
    };
  }
}
