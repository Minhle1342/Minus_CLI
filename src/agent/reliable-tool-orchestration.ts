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
  'search_codebase_fast',
  'read_compressed_code',
  'get_symbol_context_360',
  'read_file',
  'analyze_impact',
  'query_call_graph',
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
    allowedContextTools.delete('search_codebase_fast');
    allowedContextTools.delete('read_compressed_code');
  }

  // LATS Cycle break: prune cycling tool from allowed set
  if (decision.cycleDetected && decision.selectedTool !== 'search_codebase_fast') {
    allowedContextTools.delete('search_codebase_fast');
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
      preferredTool: 'analyze_impact',
      fallbackTools: ['replace_text', 'run_command', 'get_diagnostics'],
      confidence: 'high',
      reasonCodes: ['EVIDENCE_SUFFICIENT_ABSTAIN_RETRIEVAL', 'ENTER_MUTATION_PHASE'],
      guidance: '[Repoformer Abstention] Sufficient codebase evidence acquired. Broad discovery is locked to avoid attention dilution. Proceed directly to impact check, mutation, and verification.',
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
        fallbackTools: ['get_symbol_context_360', 'read_file', 'analyze_impact'],
        confidence: 'high',
        reasonCodes: ['SEMANTIC_CYCLE_DETECTED', cycle.reason],
        guidance: `[LATS Cycle Break] Repetitive tool loop detected (${cycle.pattern}). Pivot immediately to ${cycle.suggestedRecoveryTool} or inspect structural symbols directly without repeating searches.`,
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
      fallbackTools: ['search_codebase_fast', 'read_file', 'get_symbol_context_360'],
      confidence: 'medium',
      reasonCodes: ['LAST_TOOL_FAILED', 'FAIL_OPEN_RECOVERY'],
      guidance: 'The last retrieval step failed. Recover with an independent evidence source and preserve the full tool set if none is available.',
      constrainSafe: false,
    });
  }

  if (lastToolName === 'search_codebase_fast') {
    const hit = extractBestSymbolHit(result);
    if (hit?.symbol) {
      return selectVisible(input, {
        stage: 'symbol_context',
        preferredTool: 'get_symbol_context_360',
        fallbackTools: ['read_compressed_code', 'read_file'],
        suggestedArgs: { symbol: hit.symbol, path: hit.path },
        confidence: 'high',
        reasonCodes: ['SEARCH_FOUND_SYMBOL', 'GRAPH_BEFORE_BODY'],
        guidance: `Search localized ${hit.symbol} in ${hit.path}. Fetch callers, callees, dependencies, and related tests before opening the implementation body.`,
        constrainSafe: true,
      });
    }
    const paths = extractPaths(result);
    return selectVisible(input, {
      stage: 'candidate_localization',
      preferredTool: paths.length > 1 ? 'read_compressed_code' : 'read_file',
      fallbackTools: paths.length > 1 ? ['read_file', 'get_symbol_context_360'] : ['read_compressed_code', 'search_codebase_fast'],
      suggestedArgs: paths.length > 1
        ? { paths: paths.slice(0, 12), fidelity: 'adaptive' }
        : paths[0] ? { path: paths[0], outlineOnly: true } : undefined,
      confidence: paths.length > 0 ? 'high' : 'low',
      reasonCodes: paths.length > 1 ? ['MULTI_FILE_CANDIDATES', 'COMPRESS_BEFORE_DETAIL'] : ['NO_EXACT_SYMBOL', 'OUTLINE_BEFORE_DETAIL'],
      guidance: paths.length > 1
        ? `Search found ${paths.length} candidate files. Read their contracts together with an adaptive compressed bundle.`
        : 'Search did not identify a unique symbol. Inspect a candidate outline or broaden the query without guessing line ranges.',
      constrainSafe: paths.length > 0,
    });
  }

  if (lastToolName === 'read_compressed_code') {
    const segment = extractBestSegment(result);
    if (segment?.symbol) {
      return selectVisible(input, {
        stage: 'symbol_context',
        preferredTool: 'get_symbol_context_360',
        fallbackTools: ['read_file', 'query_call_graph'],
        suggestedArgs: { symbol: segment.symbol, path: segment.path },
        confidence: 'high',
        reasonCodes: ['COMPRESSED_FOUND_FOCUS', 'GRAPH_BEFORE_BODY'],
        guidance: `The multi-file bundle localized ${segment.symbol}. Resolve its blast radius and tests in one graph query.`,
        constrainSafe: true,
      });
    }
    const paths = extractPaths(result);
    return selectVisible(input, {
      stage: 'candidate_localization',
      preferredTool: 'read_file',
      fallbackTools: ['search_codebase_fast', 'get_symbol_context_360'],
      suggestedArgs: paths[0] ? { path: paths[0], outlineOnly: true } : undefined,
      confidence: paths.length > 0 ? 'medium' : 'low',
      reasonCodes: ['COMPRESSED_NO_FOCUS_SYMBOL', 'LOCALIZE_WITH_OUTLINE'],
      guidance: 'The bundle established contracts but no unique focus symbol. Read one candidate outline before selecting an implementation body.',
      constrainSafe: paths.length > 0,
    });
  }

  if (lastToolName === 'get_symbol_context_360') {
    const context = result?.context360 || result;
    const symbol = stringValue(context?.symbol);
    const path = stringValue(context?.file || context?.path);
    return selectVisible(input, {
      stage: 'exact_implementation',
      preferredTool: 'read_file',
      fallbackTools: ['inspect_symbol', 'query_call_graph'],
      suggestedArgs: symbol && path ? { path, symbol } : undefined,
      confidence: symbol && path ? 'high' : 'low',
      reasonCodes: symbol && path ? ['GRAPH_CONTEXT_ACQUIRED', 'READ_EXACT_BODY'] : ['GRAPH_CONTEXT_INCOMPLETE', 'FAIL_OPEN_RECOVERY'],
      guidance: symbol && path
        ? `Graph context is available. Read only the exact ${symbol} declaration in ${path}; avoid reopening the whole file.`
        : 'The graph response lacks a resolvable definition. Fall back to symbol inspection or search.',
      constrainSafe: Boolean(symbol && path),
    });
  }

  if (lastToolName === 'read_file' && stringValue(result?.symbol)) {
    const symbol = stringValue(result.symbol)!;
    const path = stringValue(result.path);
    return selectVisible(input, {
      stage: 'ready_for_mutation',
      preferredTool: 'analyze_impact',
      fallbackTools: ['query_call_graph', 'get_diagnostics', 'replace_text'],
      suggestedArgs: { target: symbol, ...(path ? { path } : {}), direction: 'upstream' },
      confidence: result?.completeDeclaration === false ? 'medium' : 'high',
      reasonCodes: ['EXACT_BODY_ACQUIRED', 'IMPACT_BEFORE_MUTATION'],
      guidance: `The exact ${symbol} body is now available. Check upstream impact once, then mutate and run the related tests; do not cycle back to discovery without new evidence.`,
      constrainSafe: true,
      abstainRetrieval: true,
    });
  }

  if (lastToolName === 'read_file') {
    const path = stringValue(result?.path);
    const candidate = firstOutlineSymbol(result);
    return selectVisible(input, {
      stage: candidate ? 'symbol_context' : 'candidate_localization',
      preferredTool: candidate ? 'get_symbol_context_360' : 'search_codebase_fast',
      fallbackTools: candidate ? ['read_file', 'query_call_graph'] : ['read_compressed_code', 'get_symbol_context_360'],
      suggestedArgs: candidate ? { symbol: candidate, ...(path ? { path } : {}) } : undefined,
      confidence: candidate ? 'high' : 'low',
      reasonCodes: candidate ? ['OUTLINE_FOUND_SYMBOL', 'GRAPH_BEFORE_BODY'] : ['RANGE_READ_NO_SYMBOL', 'RELOCALIZE'],
      guidance: candidate
        ? `The outline exposed ${candidate}. Acquire graph context before its exact body.`
        : 'A range read did not establish a unique symbol. Relocalize instead of scrolling through arbitrary line windows.',
      constrainSafe: Boolean(candidate),
    });
  }

  return selectVisible(input, {
    stage: 'broad_discovery',
    preferredTool: 'search_codebase_fast',
    fallbackTools: ['get_architecture_topology', 'read_compressed_code', 'get_symbol_context_360'],
    suggestedArgs: input.userRequest?.trim() ? { query: input.userRequest.trim(), contextMode: 'adaptive_bundle' } : undefined,
    confidence: input.userRequest?.trim() ? 'medium' : 'low',
    reasonCodes: ['UNKNOWN_SCOPE', 'BROAD_TO_NARROW'],
    guidance: 'Start with repository-wide localization. Use a multi-file compressed view only after candidate paths exist, then narrow through symbol graph context to one exact body.',
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
      suggestedRecoveryTool: tool === 'search_codebase_fast' ? 'get_symbol_context_360' : 'read_file',
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
      suggestedRecoveryTool: 'get_symbol_context_360',
    };
  }

  return { detected: false, reason: '', suggestedRecoveryTool: 'search_codebase_fast' };
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
    if (decision.stage === 'ready_for_mutation' && RELIABLE_CONTEXT_TOOL_NAMES.has(actualTool) && actualTool !== 'analyze_impact' && actualTool !== 'query_call_graph') {
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
  return {
    ...partial,
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

function extractBestSegment(result: any): { path: string; symbol?: string } | undefined {
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const ranked = [...segments].sort((left, right) => fidelityRank(right?.fidelity) - fidelityRank(left?.fidelity));
  for (const segment of ranked) {
    const path = stringValue(segment?.path);
    if (!path) continue;
    return { path, symbol: stringValue(segment?.symbol) };
  }
  return undefined;
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

function fidelityRank(value: unknown): number {
  if (value === 'full') return 3;
  if (value === 'preview') return 2;
  if (value === 'fold') return 1;
  return 0;
}

function recoveryTool(lastToolName?: string): string {
  if (lastToolName === 'get_symbol_context_360') return 'read_file';
  if (lastToolName === 'read_file') return 'search_codebase_fast';
  return 'search_codebase_fast';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
