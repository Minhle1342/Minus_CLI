import type { TaskPhase } from '../../control/classification-types.js';
import { FILE_MUTATION_SAFETY_RULE } from './shared.js';
import { resolvePatchFormatSpec, resolveVerifyPlaybookPrompt } from './tools.js';

/**
 * TIER 2: PHASE-SPECIFIC DYNAMIC GUIDANCE (Pareto 80/20 & cache-safe tail injection)
 * Never embed it in the system prompt, to preserve 100% KV-cache prefix invariance.
 * It is injected dynamically at the end of the user message (dynamic suffix) via DynamicContextArbiter.
 */
export const SECTION_PHASE_EXPLORE_GUIDANCE = `📍 [PHASE: EXPLORE (EVIDENCE-ADAPTIVE INVESTIGATION)]:
- Goal: Reduce uncertainty until the available evidence is strong enough for the cost and reversibility of the next action.
- Tool Strategy by Use Case:
  * Structure & Layout: Use \`list_files\` to explore directory layout.
  * Search: Use \`run_command\` (with ripgrep/grep or git log) to find symbols, occurrences, or commit history.
  * Source Inspection: Use \`read_file\` to examine exact lines and obtain contentHash.
  * Parallel Inspection: Emit multiple read-only tool calls (read_file, list_files) in a single turn to run them concurrently in parallel.
- Evidence Rule: Inspect the exact target lines with \`read_file\` before editing.`;

export const SECTION_PHASE_EXPLORE_READONLY_GUIDANCE = `📍 [PHASE: EXPLORE (READ-ONLY INVESTIGATION - R0 FAST PATH)]:
- Goal: Gather relevant context and directly answer or explain with zero mutation risk.
- Tool Strategy:
  * Structure: Use \`list_files\` to explore directory layout.
  * Source Inspection: Use \`read_file\` to examine exact lines.
  * Search: Use \`run_command\` to search codebase.
- Read-Only Rule: Answer directly once context is understood. No mutation or test execution required.`;

export const SECTION_PHASE_PLAN_GUIDANCE = `📍 [PHASE: PLAN (ARCHITECTURAL DECOMPOSITION)]:
- Goal: Survey codebase and plan surgical changes.
- Read-Only Scope: Survey and plan ONLY — no edits or premature mutations.
- Tools: Use \`list_files\` and \`read_file\` to confirm configurations, types, and logic before modifying.`;

export const SECTION_PHASE_IMPLEMENT_GUIDANCE = `📍 [PHASE: IMPLEMENT (BOUNDED COHERENT MUTATION)]:
- Goal: Apply minimal, surgical code modifications strictly restoring the intended invariant.
- Primary Mutation Tools:
  * Use \`replace_text\` with \`expectedFileHash\` and unique anchor lines for modifying existing files.
  * Use \`write_file\` for creating new files or full file rewrites; ${FILE_MUTATION_SAFETY_RULE}
- In-Flight Safety:
  * Inspect target lines with \`read_file\` for contentHash and line offsets before modifying.
  * Avoid unrelated or speculative rewrites.`;

export const SECTION_PHASE_VERIFY_GUIDANCE = `📍 [PHASE: VERIFY (EMPIRICAL VERIFICATION)]:
- Goal: Verify the changes with empirical tests and diff review.
- Verification Tools:
  * Use \`run_command\` to run builds (e.g. \`npm run build\`, \`tsc\`) and test suites (\`npm test\`, \`cargo test\`, \`pytest\`).
  * Use \`run_command "git diff"\` to inspect working tree changes.
- Completion: Report clear evidence of test passes and observed diff.`;

export const SECTION_PHASE_RELEASE_GUIDANCE = `📍 [PHASE: RELEASE (USER-AUTHORIZED COMPLETION)]:
- Goal: Provide a clear, natural final summary matching the user's language.
- Git: Perform git operations (\`run_command "git ..."\`) ONLY when explicitly requested by user.`;

export interface PhaseGuidanceOptions {
  taskClass?: string;
  hasValidatedHypothesis?: boolean;
  hasSupportedHypothesis?: boolean;
  evidenceSufficient?: boolean;
  evidenceScore?: number;
  evidenceThreshold?: number;
  hasUnverifiedChanges?: boolean;
  includePatchSpec?: boolean;
  targetFile?: string;
  risk?: string;
  reversibility?: string;
}

export function resolvePhaseDynamicGuidance(
  phase: TaskPhase | string,
  options?: PhaseGuidanceOptions,
): string {
  const cacheKey = JSON.stringify([
    phase,
    options?.taskClass, options?.risk, options?.reversibility,
    options?.hasValidatedHypothesis, options?.hasSupportedHypothesis,
    options?.evidenceSufficient, options?.evidenceScore, options?.evidenceThreshold,
    options?.hasUnverifiedChanges, options?.includePatchSpec, options?.targetFile,
  ]);
  const cached = phaseGuidanceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = resolvePhaseDynamicGuidanceUncached(phase, options);
  if (phaseGuidanceCache.size >= 200) phaseGuidanceCache.clear();
  phaseGuidanceCache.set(cacheKey, resolved);
  return resolved;
}

const phaseGuidanceCache = new Map<string, string>();

function resolvePhaseDynamicGuidanceUncached(
  phase: TaskPhase | string,
  options?: PhaseGuidanceOptions,
): string {
  switch (phase) {
    case 'explore': {
      if (options?.risk === 'R0' || options?.reversibility === 'read-only' || options?.taskClass === 'question') {
        return SECTION_PHASE_EXPLORE_READONLY_GUIDANCE;
      }
      let baseGuidance = SECTION_PHASE_EXPLORE_GUIDANCE;
      if (options?.risk === 'R1' || options?.risk === 'R2') {
        baseGuidance = baseGuidance.replace(
          '- Evidence Rule: Inspect the exact target before editing. High-risk bugfix/security changes need empirical reproduction; planned R3 refactors may proceed after target inspection.',
          '- Evidence Rule: Inspect the exact target before editing. For localized changes, in-memory diagnostics or code inspection is sufficient before moving to implementation.',
        );
      }
      let extra = '';
      if (options?.taskClass === 'bugfix' || options?.taskClass === 'refactor') {
        extra = options.hasValidatedHypothesis
          ? '\n✔ Causal hypothesis is empirically validated. Request the implement phase before editing.'
          : options?.evidenceSufficient
            ? `\n✔ Evidence threshold reached (${options.evidenceScore ?? '?'}/${options.evidenceThreshold ?? '?'}). Request the implement phase; wait for the next model response before editing.`
            : options?.hasSupportedHypothesis
              ? `\n⚠️ Static evidence supports the hypothesis, but uncertainty remains above the current threshold (${options.evidenceScore ?? '?'}/${options.evidenceThreshold ?? '?'}). Inspect the target or run a discriminating check.`
              : `\n⚠️ Evidence gate active (${options?.evidenceScore ?? 0}/${options?.evidenceThreshold ?? '?'}). Gather the smallest discriminating evidence before editing product files.`;
      }
      return `${baseGuidance}${extra}`;
    }
    case 'plan':
      return SECTION_PHASE_PLAN_GUIDANCE;
    case 'implement': {
      const withPatchSpec = options?.includePatchSpec ?? true;
      const patchSpec = resolvePatchFormatSpec(options?.targetFile);
      return withPatchSpec
        ? `${SECTION_PHASE_IMPLEMENT_GUIDANCE}\n\n${patchSpec}`
        : SECTION_PHASE_IMPLEMENT_GUIDANCE;
    }
    case 'verify':
      return `${SECTION_PHASE_VERIFY_GUIDANCE}\n\n${resolveVerifyPlaybookPrompt(options?.risk)}`;
    case 'release':
      return SECTION_PHASE_RELEASE_GUIDANCE;
    default:
      return '';
  }
}

/**
 * P0 phase/tool authority directive (dynamic tail, non-truncatable via P1.5).
 * Tells the model exactly which tools are authorized this step so it never
 * has to guess an unauthorized edit to advance its workflow. Keep it compact:
 * a sorted tool list plus the legal advance mechanism for the current phase.
 */
export function buildPhaseToolAuthorityDirective(
  phase: string,
  visibleToolNames: readonly string[],
  options?: { canRequestPhaseTransition?: boolean; hasSubmittedSolution?: boolean; isReadOnly?: boolean },
): string {
  // visibleToolNames is already sorted at the call site path; sort a copy for a
  // stable cache key without mutating the caller's array.
  const names = [...new Set(visibleToolNames)].sort();
  const cacheKey = `${phase}|${names.join(',')}|${options?.canRequestPhaseTransition ? 1 : 0}${options?.hasSubmittedSolution ? 1 : 0}${options?.isReadOnly ? 1 : 0}`;
  const cached = phaseAuthorityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = buildPhaseToolAuthorityDirectiveUncached(phase, names, options);
  if (phaseAuthorityCache.size >= 200) phaseAuthorityCache.clear();
  phaseAuthorityCache.set(cacheKey, resolved);
  return resolved;
}

const phaseAuthorityCache = new Map<string, string>();

function buildPhaseToolAuthorityDirectiveUncached(
  phase: string,
  names: string[],
  options?: { canRequestPhaseTransition?: boolean; hasSubmittedSolution?: boolean; isReadOnly?: boolean },
): string {
  if (options?.hasSubmittedSolution || names.length === 0) {
    return `🔧 [PHASE TOOL AUTHORITY: ${phase}] No tools are authorized this step. Answer directly with text; do not call any tool.`;
  }
  const list = names.join(', ');
  const advance = options?.isReadOnly
    ? ` Read-only exploration: answer directly with text once evidence is found.`
    : options?.canRequestPhaseTransition
      ? ` To advance workflow, call request_phase_transition with rationale+evidenceRefs, then wait for the next turn before using the new phase tools.`
      : phase === 'plan' && options?.canRequestPhaseTransition !== false
        ? ` Use create_plan for milestones, then request_phase_transition to implement before editing.`
        : phase === 'plan'
          ? ` Use create_plan for milestones and continue with the authorized tools.`
          : ` Call ONLY tools from this list; do not hallucinate tool names outside it.`;
  return `🔧 [PHASE TOOL AUTHORITY: ${phase}] Authorized this step (${names.length}): ${list}.${advance}`;
}
