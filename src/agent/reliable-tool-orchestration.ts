export type ReliableToolOrchestrationMode = 'off' | 'shadow' | 'enforce';
export type RetrievalStage =
  | 'broad_discovery'
  | 'candidate_localization'
  | 'symbol_context'
  | 'exact_implementation'
  | 'ready_for_mutation'
  | 'cycle_break'
  | 'fallback';

export interface TrajectoryStep {
  toolName: string;
  args?: Record<string, unknown>;
  success?: boolean;
  producedEntities?: string[];
  signature?: string;
}

export interface ToolRouteInput {
  userRequest?: string;
  lastToolName?: string;
  lastToolResult?: any;
  visibleToolNames?: string[];
  trajectory?: TrajectoryStep[];
  evidenceSufficient?: boolean;
}

export type ReliableToolRouteDecision = ToolRouteDecision;

export interface ToolRouteDecision {
  stage: RetrievalStage;
  preferredTool?: string;
  selectedTool?: string;
  fallbackTools: string[];
  suggestedArgs?: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'low';
  reasonCodes: string[];
  guidance: string;
  failOpen: boolean;
  constrainSafe: boolean;
  abstainRetrieval?: boolean;
  cycleDetected?: boolean;
}

export interface ToolOrchestrationTelemetrySnapshot {
  decisions: number;
  followed: number;
  fallbackSelections: number;
  failOpenDecisions: number;
  exactBodyRoundTrips: number;
  invalidCycles: number;
  cyclesDetected: number;
  abstentionDecisions: number;
  stageCounts: Record<string, number>;
  transitionCounts: Record<string, number>;
}

export const RELIABLE_CONTEXT_TOOL_NAMES = new Set([
  'search_text',
  'list_files',
  'read_file',
]);

export function resolveReliableToolOrchestrationMode(value = process.env.MINUS_RELIABLE_TOOL_ORCHESTRATION): ReliableToolOrchestrationMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'enforce' || normalized === 'shadow') return normalized;
  if (normalized === 'off') return 'off';
  return normalized ? 'off' : 'shadow';
}

export function applyReliableToolRouteToDeclarations<T extends { name: string }>(
  declarations: T[],
  decision: ToolRouteDecision,
  mode: ReliableToolOrchestrationMode,
): T[] {
  if (mode !== 'enforce' || !decision.constrainSafe || decision.failOpen || !decision.selectedTool) return declarations;

  const allowedContextTools = new Set([decision.selectedTool, ...decision.fallbackTools]);

  // Repoformer Abstention Gate: when evidence is sufficient or in mutation phase, strip broad discovery tools
  if (decision.abstainRetrieval) {
    allowedContextTools.delete('search_text');
    allowedContextTools.delete('list_files');
  }

  // LATS Cycle break: prune cycling tool from allowed set
  if (decision.cycleDetected && decision.selectedTool !== 'search_text') {
    allowedContextTools.delete('search_text');
  }

  const scoped = declarations.filter((tool) => !RELIABLE_CONTEXT_TOOL_NAMES.has(tool.name) || allowedContextTools.has(tool.name));
  return scoped.some((tool) => tool.name === decision.selectedTool) ? scoped : declarations;
}

/**
 * Trajectory-Aware & Abstention-Gated routing for evidence acquisition.
 * Incorporates:
 * - Multi-turn trajectory cycle detection (LATS / MCTS pattern)
 * - Selective retrieval & abstention gate (Repoformer)
 * - Progressive broad-to-narrow scoping (LocAgent & SWE-agent)
 */
export function decideReliableToolRoute(input: ToolRouteInput): ToolRouteDecision {
  // 1. Repoformer Abstention Gate: if evidence is marked sufficient, abstain from broad discovery
  if (input.evidenceSufficient) {
    return selectVisible(input, {
      stage: 'ready_for_mutation',
      preferredTool: 'replace_text',
      fallbackTools: ['read_file', 'run_command'],
      confidence: 'high',
      reasonCodes: ['EVIDENCE_SUFFICIENT_ABSTAIN_RETRIEVAL', 'ENTER_MUTATION_PHASE'],
      guidance: '[Repoformer Abstention] Sufficient codebase evidence acquired. Broad discovery is locked to avoid attention dilution. Proceed to a bounded mutation and verify with run_command.',
      constrainSafe: true,
      abstainRetrieval: true,
    });
  }

  // 2. Trajectory-Aware Cycle Detection (LATS pattern)
  if (input.trajectory && input.trajectory.length >= 3) {
    const cycle = detectTrajectoryCycle(input.trajectory);
    if (cycle.detected) {
      return selectVisible(input, {
        stage: 'cycle_break',
        preferredTool: cycle.suggestedRecoveryTool,
        fallbackTools: ['read_file', 'search_text'],
        confidence: 'high',
        reasonCodes: ['SEMANTIC_CYCLE_DETECTED', cycle.reason],
        guidance: `[LATS Cycle Break] Repetitive tool loop detected (${cycle.pattern}). Pivot immediately to ${cycle.suggestedRecoveryTool} instead of repeating the same search.`,
        constrainSafe: true,
        cycleDetected: true,
      });
    }
  }

  const lastToolName = input.lastToolName;
  const result = input.lastToolResult || {};
  const failed = Boolean(result?.error || result?.success === false);

  if (failed) {
    return selectVisible(input, {
      stage: 'fallback',
      preferredTool: recoveryTool(lastToolName),
      fallbackTools: ['search_text', 'read_file', 'list_files'],
      confidence: 'medium',
      reasonCodes: ['LAST_TOOL_FAILED', 'FAIL_OPEN_RECOVERY'],
      guidance: 'The last retrieval step failed. Recover with an independent, focused search and preserve the full tool set if none is available.',
      constrainSafe: false,
    });
  }

  if (lastToolName === 'search_text' || lastToolName === 'search_codebase_fast') {
    const hit = extractBestSymbolHit(result);
    if (hit?.symbol) {
      return selectVisible(input, {
        stage: 'symbol_context',
        preferredTool: 'read_file',
        fallbackTools: ['search_text', 'list_files'],
        suggestedArgs: { path: hit.path },
        confidence: 'high',
        reasonCodes: ['SEARCH_FOUND_SYMBOL', 'READ_BEFORE_BODY'],
        guidance: `Search localized ${hit.symbol} in ${hit.path}. Read that region before editing; search again only if the symbol is not in it.`,
        constrainSafe: true,
      });
    }
    const paths = extractPaths(result);
    return selectVisible(input, {
      stage: 'candidate_localization',
      preferredTool: 'read_file',
      fallbackTools: ['search_text', 'list_files'],
      suggestedArgs: paths[0] ? { path: paths[0] } : undefined,
      confidence: paths.length > 0 ? 'high' : 'low',
      reasonCodes: paths.length > 1 ? ['MULTI_FILE_CANDIDATES', 'READ_BEST_CANDIDATE'] : ['NO_EXACT_SYMBOL', 'BROADEN_QUERY'],
      guidance: paths.length > 1
        ? `Search found ${paths.length} candidate files. Read the most likely one first, then narrow with a targeted search.`
        : 'Search did not identify a unique symbol. Broaden the query or inspect the workspace layout without guessing line ranges.',
      constrainSafe: paths.length > 0,
    });
  }

  if (lastToolName === 'read_file') {
    const path = stringValue(result?.path);
    const symbol = stringValue(result?.symbol);
    if (symbol && result?.completeDeclaration !== false) {
      return selectVisible(input, {
        stage: 'ready_for_mutation',
        preferredTool: 'replace_text',
        fallbackTools: ['read_file', 'run_command'],
        suggestedArgs: path ? { path } : undefined,
        confidence: 'high',
        reasonCodes: ['EXACT_BODY_ACQUIRED', 'MUTATE_THEN_VERIFY'],
        guidance: `The exact ${symbol} body is available. Apply a bounded mutation and verify with run_command; do not cycle back to discovery without new evidence.`,
        constrainSafe: true,
        abstainRetrieval: true,
      });
    }
    const candidate = firstOutlineSymbol(result);
    return selectVisible(input, {
      stage: 'candidate_localization',
      preferredTool: 'search_text',
      fallbackTools: ['read_file', 'list_files'],
      suggestedArgs: candidate
        ? { query: candidate, isRegex: false }
        : input.userRequest?.trim() ? { query: input.userRequest.trim() } : undefined,
      confidence: candidate ? 'medium' : 'low',
      reasonCodes: candidate ? ['OUTLINE_FOUND_SYMBOL', 'LOCATE_EXACT_BODY'] : ['RANGE_READ_NO_SYMBOL', 'RELOCALIZE'],
      guidance: candidate
        ? `The outline exposed ${candidate}. Locate its exact declaration with a focused search_text query before mutating.`
        : 'A range read did not establish a unique symbol. Relocalize with a focused search_text query instead of scrolling through arbitrary line windows.',
      constrainSafe: Boolean(candidate),
    });
  }

  return selectVisible(input, {
    stage: 'broad_discovery',
    preferredTool: 'search_text',
    fallbackTools: ['list_files', 'read_file'],
    suggestedArgs: input.userRequest?.trim() ? { query: input.userRequest.trim() } : undefined,
    confidence: input.userRequest?.trim() ? 'medium' : 'low',
    reasonCodes: ['UNKNOWN_SCOPE', 'BROAD_TO_NARROW'],
    guidance: 'Start with a focused repository search, then read the best candidate. Do not guess line ranges.',
    constrainSafe: false,
  });
}

function detectTrajectoryCycle(trajectory: TrajectoryStep[]): {
  detected: boolean;
  pattern?: string;
  reason: string;
  suggestedRecoveryTool: string;
} {
  const recent = trajectory.slice(-4);
  const toolNames = recent.map((s) => s.toolName);

  // 1. Repeated identical tool calls (>= 3 times)
  if (
    toolNames.length >= 3
    && toolNames[toolNames.length - 1] === toolNames[toolNames.length - 2]
    && toolNames[toolNames.length - 2] === toolNames[toolNames.length - 3]
  ) {
    const tool = toolNames[toolNames.length - 1];
    return {
      detected: true,
      pattern: `${tool} x 3`,
      reason: 'REPEATED_IDENTICAL_TOOL_CALLS',
      suggestedRecoveryTool: tool === 'search_text' ? 'read_file' : 'search_text',
    };
  }

  // 2. Ping-pong oscillation between two tools (A -> B -> A -> B)
  if (
    toolNames.length >= 4
    && toolNames[0] === toolNames[2]
    && toolNames[1] === toolNames[3]
    && toolNames[0] !== toolNames[1]
  ) {
    return {
      detected: true,
      pattern: `${toolNames[0]} <-> ${toolNames[1]}`,
      reason: 'PING_PONG_OSCILLATION',
      suggestedRecoveryTool: 'read_file',
    };
  }

  return { detected: false, reason: '', suggestedRecoveryTool: 'search_text' };
}

export class ReliableToolOrchestrationTelemetry {
  private decisions = 0;
  private followed = 0;
  private fallbackSelections = 0;
  private failOpenDecisions = 0;
  private exactBodyRoundTrips = 0;
  private invalidCycles = 0;
  private cyclesDetected = 0;
  private abstentionDecisions = 0;
  private readonly stageCounts = new Map<string, number>();
  private readonly transitionCounts = new Map<string, number>();
  private previousStage?: RetrievalStage;
  private previousTool?: string;

  recordDecision(decision: ToolRouteDecision): void {
    this.decisions++;
    this.increment(this.stageCounts, decision.stage);
    if (decision.failOpen) this.failOpenDecisions++;
    if (decision.cycleDetected) this.cyclesDetected++;
    if (decision.abstainRetrieval) this.abstentionDecisions++;
    if (this.previousStage) this.increment(this.transitionCounts, `${this.previousStage}->${decision.stage}`);
    this.previousStage = decision.stage;
  }

  recordExecution(decision: ToolRouteDecision, actualTool: string, result?: any): void {
    if (actualTool === decision.selectedTool) this.followed++;
    else if (decision.fallbackTools.includes(actualTool)) this.fallbackSelections++;
    if (this.previousTool === 'read_file' && actualTool === 'read_file' && !result?.symbol) this.exactBodyRoundTrips++;
    if (decision.stage === 'ready_for_mutation' && RELIABLE_CONTEXT_TOOL_NAMES.has(actualTool) && actualTool !== 'read_file') {
      this.invalidCycles++;
    }
    this.previousTool = actualTool;
  }

  snapshot(): ToolOrchestrationTelemetrySnapshot {
    return {
      decisions: this.decisions,
      followed: this.followed,
      fallbackSelections: this.fallbackSelections,
      failOpenDecisions: this.failOpenDecisions,
      exactBodyRoundTrips: this.exactBodyRoundTrips,
      invalidCycles: this.invalidCycles,
      cyclesDetected: this.cyclesDetected,
      abstentionDecisions: this.abstentionDecisions,
      stageCounts: Object.fromEntries(this.stageCounts),
      transitionCounts: Object.fromEntries(this.transitionCounts),
    };
  }

  private increment(target: Map<string, number>, key: string): void {
    target.set(key, (target.get(key) || 0) + 1);
  }
}

function selectVisible(input: ToolRouteInput, partial: Omit<ToolRouteDecision, 'selectedTool' | 'failOpen'>): ToolRouteDecision {
  const visible = input.visibleToolNames ? new Set(input.visibleToolNames) : undefined;
  const candidates = [partial.preferredTool, ...partial.fallbackTools].filter((tool): tool is string => Boolean(tool));
  const selectedTool = visible ? candidates.find((tool) => visible.has(tool)) : partial.preferredTool;

  let preferredTool = partial.preferredTool;
  let fallbackTools = partial.fallbackTools;
  let guidance = partial.guidance;

  if (visible) {
    if (selectedTool) {
      preferredTool = selectedTool;
    }
    fallbackTools = partial.fallbackTools.filter((tool) => visible.has(tool) && tool !== preferredTool);
    if (partial.preferredTool && !visible.has(partial.preferredTool) && selectedTool) {
      guidance = guidance.replace(new RegExp(`\\b${partial.preferredTool}\\b`, 'g'), selectedTool);
    }
  }

  return {
    ...partial,
    preferredTool,
    fallbackTools,
    guidance,
    ...(selectedTool ? { selectedTool } : {}),
    failOpen: Boolean(visible && !selectedTool),
    constrainSafe: partial.constrainSafe && Boolean(selectedTool),
  };
}

function extractBestSymbolHit(result: any): { path: string; symbol?: string } | undefined {
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  for (const hit of hits) {
    const path = stringValue(hit?.path);
    if (!path) continue;
    const symbol = stringValue(hit?.symbol);
    if (symbol) return { path, symbol };
  }
  const firstPath = extractPaths(result)[0];
  return firstPath ? { path: firstPath } : undefined;
}

function extractPaths(result: any): string[] {
  const candidates = [
    ...(Array.isArray(result?.hits) ? result.hits : []),
    ...(Array.isArray(result?.segments) ? result.segments : []),
    ...(Array.isArray(result?.files) ? result.files : []),
  ];
  return [...new Set(candidates.map((item) => stringValue(item?.path)).filter((value): value is string => Boolean(value)))];
}

function firstOutlineSymbol(result: any): string | undefined {
  const symbols = Array.isArray(result?.symbols) ? result.symbols : Array.isArray(result?.outline) ? result.outline : [];
  const first = symbols.find((symbol: any) => stringValue(symbol?.qualifiedName || symbol?.name));
  return first ? stringValue(first.qualifiedName || first.name) : undefined;
}

function recoveryTool(lastToolName?: string): string {
  return lastToolName === 'search_text' ? 'read_file' : 'search_text';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
