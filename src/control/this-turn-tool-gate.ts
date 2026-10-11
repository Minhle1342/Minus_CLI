import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../tools/types.js';
import type { ClassificationDecision } from './classification-types.js';
import { ToolDescriptorRegistry, READ_TOOL_NAMES, EDIT_TOOL_NAMES } from './tool-descriptor-registry.js';
import { hasCodeGraphIndexSync } from '../search/codegraph-client.js';
import { detectArchitectureAnalysisIntent } from '../agent/final-answer-guard.js';
import { hasNetworkIntent } from './network-intent.js';

const PHASE_TRANSITION_TASK_CLASSES = new Set(['bugfix', 'feature', 'refactor', 'question', 'exploration']);

/** Small phase-specific exploration anchors pinned after relevance retrieval. */
const PHASE_EXPLORE_TOOL_ANCHORS: Record<string, readonly string[]> = {
  explore: ['read_file', 'list_files', 'search_text', 'search_codebase_fast', 'codegraph_search', 'codegraph_explore', 'get_symbol_context_360', 'get_diagnostics'],
  plan: ['read_file', 'list_files', 'search_text', 'search_codebase_fast', 'inspect_symbol', 'codegraph_explore', 'codegraph_impact', 'analyze_impact', 'get_symbol_context_360', 'get_architecture_topology'],
  implement: ['read_file', 'get_symbol_context_360', 'get_diagnostics'],
  verify: ['read_file', 'get_diagnostics', 'run_command'],
  release: [],
};

export interface ThisTurnToolDecision {
  id: string;
  classificationId: string;
  allowedToolNames: string[];
  deniedToolNames: string[];
  allowedToolSetHash: string;
  schemaTokensBefore: number;
  schemaTokensAfter: number;
  approvalToolNames: string[];
  /** Explore/read schemas pinned for the current phase, when registered. */
  phaseExploreToolAnchors: string[];
  reasonCodes: string[];
  toolSurface: ToolSurface;
}

/** The hard runtime allowlist and the soft LLM schema subset for one step. */
export interface ToolSurface {
  authorizedToolNames: string[];
  visibleToolNames: string[];
}

export function createToolSurface(
  authorizedToolNames: readonly string[],
  visibleToolNames: readonly string[] = [],
): ToolSurface {
  const authorized = [...new Set(authorizedToolNames)].sort();
  const allowed = new Set(authorized);
  return {
    authorizedToolNames: authorized,
    visibleToolNames: [...new Set(visibleToolNames)].filter((name) => allowed.has(name)).sort(),
  };
}

export function hashAllowedToolSet(names: readonly string[]): string {
  return createHash('sha256').update([...new Set(names)].sort().join('\n')).digest('hex');
}

export interface ThisTurnToolGateOptions {
  workspaceDir?: string;
  userRequest?: string;
  hasCodeGraph?: boolean;
  isArchitectureQuery?: boolean;
}

export class ThisTurnToolGate {
  constructor(private readonly descriptors = new ToolDescriptorRegistry()) {}

  decide(
    classification: ClassificationDecision,
    tools: ToolDefinition[],
    options?: ThisTurnToolGateOptions,
  ): ThisTurnToolDecision {
    const required = new Set(classification.requiredCapabilities);
    const allowed: ToolDefinition[] = [];
    const denied: string[] = [];
    const riskRank = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 } as const;

    for (const tool of tools) {
      const descriptor = this.descriptors.describe(tool);
      // Tool đọc an toàn luôn được phép ở mọi phase vì quan sát là quyền năng cốt lõi của Agent
      const isAlwaysAllowedRead = READ_TOOL_NAMES.has(tool.name) && !descriptor.mutates;
      // File effects require an implementation/verification/release phase.
      const isAuthorizedEdit = EDIT_TOOL_NAMES.has(tool.name)
        && ['implement', 'verify', 'release'].includes(classification.phase)
        && required.has('edit');
      if (descriptor.mutates && (['explore', 'plan'].includes(classification.phase)
        || classification.reversibility === 'read-only')) {
        denied.push(tool.name);
        continue;
      }
      // The model may ask the Harness to advance phase, but cannot expand its current tool authority.
      const isPhaseTransitionTool = tool.name === 'request_phase_transition';
      const isPhaseTransitionRequest = isPhaseTransitionTool
        && ['explore', 'plan', 'implement'].includes(classification.phase)
        && PHASE_TRANSITION_TASK_CLASSES.has(classification.taskClass);
      const isVerificationRepairTool = classification.phase === 'verify'
        && EDIT_TOOL_NAMES.has(tool.name);
      const isCompletionTool = tool.name === 'submit_solution'
        && descriptor.phases.includes(classification.phase);
      const capabilityMatch = descriptor.capabilities.some((capability) => required.has(capability))
        || isAlwaysAllowedRead
        || isAuthorizedEdit
        || isPhaseTransitionRequest
        || isVerificationRepairTool
        || isCompletionTool;
      const phaseMatch = descriptor.phases.includes(classification.phase)
        || isAlwaysAllowedRead
        || isAuthorizedEdit;
      const riskMatch = riskRank[classification.risk] >= riskRank[descriptor.minimumRisk]
        || (classification.risk !== 'R0' || !descriptor.mutates)
        || isAuthorizedEdit;

      if ((!isPhaseTransitionTool && capabilityMatch && phaseMatch && riskMatch) || isPhaseTransitionRequest) {
        allowed.push(tool);
      } else {
        denied.push(tool.name);
      }
    }

    const names = allowed.map((tool) => tool.name).sort();
    const allowedToolSetHash = hashAllowedToolSet(names);
    const before = tools.reduce((sum, tool) => sum + this.descriptors.describe(tool).schemaCost, 0);
    const after = allowed.reduce((sum, tool) => sum + this.descriptors.describe(tool).schemaCost, 0);
    const approvalToolNames = allowed
      .filter((tool) => this.descriptors.describe(tool).requiresApproval)
      .map((tool) => tool.name)
      .sort();
    const hasCodeGraph = options?.hasCodeGraph ?? (options?.workspaceDir ? hasCodeGraphIndexSync(options.workspaceDir) : false);
    const isArchitectureQuery = options?.isArchitectureQuery ?? (options?.userRequest ? detectArchitectureAnalysisIntent(options.userRequest).isArchitectureQuery : false);
    const allowCodeGraphAnchors = hasCodeGraph || isArchitectureQuery;

    const baseAnchors = PHASE_EXPLORE_TOOL_ANCHORS[classification.phase] || [];
    const filteredAnchors = allowCodeGraphAnchors
      ? baseAnchors
      : baseAnchors.filter((name) => !name.startsWith('codegraph_'));

    const anchors = [...filteredAnchors];
    // Pin web tools when the turn needs network: pasted URL, explicit web
    // request, or proactive refresh. Guarantees visibility even if RATS ranks low.
    if (required.has('network') || hasNetworkIntent(options?.userRequest)) {
      for (const name of ['web_search', 'web_fetch']) {
        if (names.includes(name) && !anchors.includes(name)) anchors.push(name);
      }
    }

    const phaseExploreToolAnchors = anchors.filter((name) => names.includes(name));

    return {
      id: `tools-${classification.id.slice(6)}-${allowedToolSetHash.slice(0, 12)}`,
      classificationId: classification.id,
      allowedToolNames: names,
      deniedToolNames: denied.sort(),
      allowedToolSetHash,
      schemaTokensBefore: before,
      schemaTokensAfter: after,
      approvalToolNames,
      phaseExploreToolAnchors,
      reasonCodes: denied.length ? ['PHASE_CAPABILITY_REDUCTION'] : ['FULL_TOOLSET_REQUIRED'],
      toolSurface: createToolSurface(names, phaseExploreToolAnchors),
    };
  }
}
