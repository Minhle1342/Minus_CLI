import path from 'node:path';
import fs from 'node:fs';
import { ToolRegistry, ToolScope } from '../tools/registry.js';
import { ToolProvider } from '../tools/registry.js';
import { ToolRunner, type ToolExecutionResult } from '../tools/tool-runner.js';
import { validateSchemaValue } from '../tools/schema-validator.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';
import { computeRequestValueDigest } from '../session/session-invariants.js';
import { hasCompletedTurnPressure, hasMaterialCompletedTurnSavings, resolveCompletedTurnCompactionPolicy } from './completed-turn-compaction-policy.js';
import { AgentLoopOptions } from './types.js';
import { CheckpointManager } from '../workspace/checkpoint.js';
import { CLI, UICollapsePreferences, DEFAULT_COLLAPSE_PREFERENCES } from '../ui/cli-ui.js';
import { ContextCompactor } from './context-compactor.js';
import { ContextGuardian, ContextAgent, TurnMemoryRetriever, PlaybookReflector, PlaybookCurator } from '../context/index.js';
import { PlanManager } from './plan-manager.js';
import { ReflectionEngine } from './reflection-engine.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import type { MemoryRecord } from '../memory/types.js';
import { AgentKernel, KernelContext } from '../kernel/kernel.js';
import { SessionPersistence } from '../session/session-persistence.js';
import { GoalManager } from './goal-manager.js';
import { AgentHookContext, AgentHookRegistry } from './agent-hooks.js';
import { AgentInbox, AgentInboxItem, AgentInputSource } from './agent-inbox.js';
import { PromptAssembler } from '../llm/prompt-assembler.js';
import { DEFAULT_PROMPT_SECTIONS, detectPromptContext, resolveSubagentPromptSections, resolvePhaseDynamicGuidance, buildPhaseToolAuthorityDirective, SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR } from '../llm/prompts.js';
import { AgentRegistry, AgentStatus } from './agent-registry.js';
import { SubagentManager, SubagentOptions } from './subagent-manager.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { EffectLedger } from './effect-ledger.js';
import { LoopProgressGuard } from './loop-progress-guard.js';
import { ProcessFailureDetector } from './process-failure-detector.js';
import { DomainIntentGuardian } from './domain-intent-guardian.js';
import { getTurnCompletionState, hasObservedMutation, observedMutationFiles } from './completion-observations.js';
import { buildCompletionRecoveryPrompt, selectFinalAnswer } from './completion-response.js';
import { FinalAnswerGuard, detectArchitectureAnalysisIntent, detectAnalysisOrInvestigationIntent, isCompletionStub, stripSystemPromptEcho, type FinalAnswerGuardDecision } from './final-answer-guard.js';
import { createDelegateAgentTool, createSpawnAgentTool, createWaitAgentTool, createGetAgentResultTool, createResumeAgentTool, createStopAgentTool, createAllocateAgentTaskTool, createBrainstormDesignTool, createVerifySubagentQualityTool, createScheduleDagParallelTool } from '../tools/subagent-tools.js';
import { classifyGitCommand } from '../tools/git-command-policy.js';
import { CompletionEvidenceGate, extractCommandString, isCompletionEvidenceGateEnabled, isToolResultFailure, isVerificationCommand, isUserExplicitlyExemptingTests, isNonExecutableFile } from './completion-evidence.js';
import { VerificationPolicy, isScratchPath, isCommentOnlyChange } from '../skills/verification-policy.js';
import { shouldPersistReasoning } from './reasoning-persistence.js';
import { type LLMRequestOptions } from '../llm/gemini.js';
import { getModelTokenProfile } from '../llm/token-config.js';
import { HypothesisTracker, type BlastRadiusRisk } from './hypothesis-tracker.js';
import { SpeculativeBranchManager } from './speculative-branch-manager.js';
import { EpistemicInvestigationEngine } from './epistemic-investigation-engine.js';
import { CriticGate, type ExplorationSufficiencyDecision } from './critic-gate.js';
import { registerSubmitSolutionTool } from '../tools/submit-solution.js';
import { registerReportFindingsTool } from '../tools/report-findings.js';
import { WorkspaceStateVerifier } from '../workspace/workspace-state-verifier.js';
import { HypothesisRollbackOrchestrator } from './hypothesis-rollback-orchestrator.js';
import { AdaptiveReasoningController } from './adaptive-reasoning-controller.js';
import {
  generateFallbackStepSummary,
} from './step-summarizer.js';
import { classifyLLMError } from '../llm/error-handling.js';
import { ToolSynergyAdvisor, detectBugReportIntent } from './tool-synergy-advisor.js';
import { GraphRankedRepositoryMap } from './graph-ranked-repository-map.js';
import { CitationValidatedRepositoryMemory } from '../memory/repository-memory.js';
import { ClassificationEngine } from '../control/classification-engine.js';
import type { ClassificationDecision, ToolControlMode } from '../control/classification-types.js';
import { ThisTurnToolGate, createToolSurface, hashAllowedToolSet } from '../control/this-turn-tool-gate.js';
import { EDIT_TOOL_NAMES } from '../control/tool-descriptor-registry.js';
import { ToolControlTelemetry } from '../control/tool-control-telemetry.js';
import { isReadOnlyRequest } from '../control/request-intent.js';
import { getOrCreateTypeScriptService, disposeSharedTypeScriptService } from '../tools/inspect-symbol.js';
import type { VerificationFailureItem } from '../skills/verification-baseline.js';
import { LatencyOrchestrator } from './latency-orchestrator.js';
import { DynamicContextCache } from './dynamic-context-cache.js';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';
import { partitionToolCalls, type ScheduledToolCall, type ToolCallPartition } from './tool-execution-scheduler.js';
import { PipelinedToolDispatcher, extractThoughtPaths, predictObservationCandidates } from './pipelined-tool-dispatcher.js';
import { CognitiveHarness, detectLeadingQuery } from './cognitive-harness.js';
import { ContextSnapshotManager, type TaskContextSnapshot } from '../session/context-snapshot-manager.js';
import { isMutationTool } from '../tools/diff-generator.js';
import { sanitizeToolResultPayload } from '../tools/tool-output-sanitizer.js';
import { generateWarmStartTopology } from './warm-start-topomap.js';
import { detectWorkspaceTestCommand, detectWorkspaceBuildCommand, detectWorkspaceIntegrationTestCommand, touchesIntegrationLayer } from '../testing/test-engineering-harness.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';
import { StepRetrievalQueryBuilder } from './step-retrieval-query-builder.js';
import { hasCodeGraphIndexSync } from '../search/codegraph-client.js';
import { resolveEllipticalFollowUp } from './ellipsis-resolver.js';
import { isSensitivePath } from './verify-tier-resolver.js';
import {
  diffReadSnapshots,
  extractReadTargets,
  formatSnapshotNudge,
  snapshotReadTargets,
  type ReadSnapshot,
} from './read-batch-snapshot.js';
import { ContextQualityEvaluator } from './context-quality-evaluator.js';
import { ExactTokenizer } from './exact-tokenizer.js';
import { StepPromptPolicy, resolveStepPromptGatingMode } from './step-prompt-policy.js';
import { assessParetoEvidence } from './pareto-evidence-policy.js';
import { buildPhaseContextHandoff } from './phase-context-handoff.js';
import { attributeCommandFailure, captureCommandBaseline } from './command-regression-evidence.js';
import {
  applyPhaseAuthority,
  applyPhaseLifecycle,
  invalidatePhaseOnMutation,
  getPhaseTransitionRecoveryGuidance,
  recordImplementationCompleted,
  recordVerificationOutcome,
  requestPhaseTransition,
} from './phase-lifecycle.js';
import type { OcrGateDecision, OcrReviewService } from '../review/open-code-review.js';
import {
  ReliableToolOrchestrationTelemetry,
  applyReliableToolRouteToDeclarations,
  decideReliableToolRoute,
  resolveReliableToolOrchestrationMode,
  type TrajectoryStep,
} from './reliable-tool-orchestration.js';
import { AciGuardrails, resolveAciGuardrailMode } from './aci-guardrails.js';
import { ContextBudgetManager, resolveContextManagementMode, type CompactionStateV1, type ModelRequestEnvelope } from './context-budget-manager.js';
import { resolveRequestBudget } from './request-budget.js';
import { selectReplacedObservationIds } from './observation-retention-policy.js';
import { readCoverageReport, type FileCoverage } from './coverage-report-reader.js';
import { buildFailureInvestigationBrief, type FailureInvestigationMutation } from './failure-investigation-mode.js';

export function isScratchFilePath(filePath: string): boolean {
  return isScratchPath(filePath);
}

function configuredEvidenceGateMode(): 'off' | 'observe' | 'enforce' | undefined {
  const mode = process.env.MINUS_EVIDENCE_GATE_MODE?.trim().toLowerCase();
  return mode === 'off' || mode === 'observe' || mode === 'enforce' ? mode : undefined;
}

function envFeatureEnabled(name: string, defaultValue = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return !['0', 'false', 'off', 'disabled'].includes(value);
}

function envFiniteNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : undefined;
}

function hypothesisBlastRadiusRisk(
  hypotheses: Array<{ blastRadius?: string }>,
): 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | undefined {
  const mapped = hypotheses.map((hypothesis) => (
    hypothesis.blastRadius === 'CRITICAL' ? 'R5'
      : hypothesis.blastRadius === 'HIGH' ? 'R3'
        : hypothesis.blastRadius === 'MEDIUM' ? 'R2'
          : hypothesis.blastRadius === 'LOW' ? 'R1'
            : 'R0'
  ));
  const rank = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 } as const;
  return mapped.sort((a, b) => rank[b] - rank[a])[0];
}

function isComprehensiveSubmissionSummary(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 200 || trimmed.split(/\s+/).length < 25) {
    return false;
  }
  // Yêu cầu có cấu trúc phân tích (danh sách, định dạng markdown, hoặc ít nhất 2 câu phân tách)
  return /[-*•\d]\.\s|###|\*\*|(?:\n\n)/.test(trimmed);
}

/**
 * Trích anchor paths từ prompt đã được PromptAttachmentProcessor mở rộng.
 * Header có dạng `[Attached File: <path> (<n> lines ...)]`,
 * `[Attached Binary File: <path> (<n> KB)]`, `[Attached Directory: <path>/ (<n> entries)]`.
 * Trả về [] khi turn không có attach.
 */
function detectAttachmentAnchors(text: string): string[] {
  if (!text || !text.includes('[User Attached Workspace Context]')) return [];
  const anchors = new Set<string>();
  let match: RegExpExecArray | null;
  const filePattern = /\[Attached (?:Binary )?File: (.+?) \(\d+(?:\.\d+)? (?:lines|KB)/g;
  while ((match = filePattern.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (candidate) anchors.add(candidate);
  }
  const dirPattern = /\[Attached Directory: (.+?) \(\d+ entries/g;
  while ((match = dirPattern.exec(text)) !== null) {
    const candidate = match[1].trim().replace(/\/+$/, '');
    if (candidate) anchors.add(candidate);
  }
  return [...anchors];
}

/**
 * Extract the [REQUEST ANALYSIS] block the model opens its reasoning with
 * (goal, scope, ambiguities, plan, risk — see CORE_SYSTEM_PROMPT §3). Returns undefined
 * when the model did not include one.
 */
export function extractRequestAnalysis(reasoning: string | undefined | null): string | undefined {
  if (!reasoning) return undefined;
  const match = /\[REQUEST ANALYSIS\]([\s\S]*?)(?:\[\/REQUEST ANALYSIS\]|$)/i.exec(reasoning);
  if (!match) return undefined;
  const block = match[1].trim();
  return block ? block : undefined;
}

export interface RequestAnalysisFields {
  goal?: string;
  scope?: string;
  ambiguities?: string;
  plan?: string;
  risk?: string;
}

/**
 * Parses a [REQUEST ANALYSIS] block into structured fields.
 * Backward compatible: old 3-field blocks (goal/scope/ambiguities) still parse;
 * missing plan/risk simply stay undefined.
 */
export function parseRequestAnalysisFields(block: string | undefined | null): RequestAnalysisFields {
  if (!block?.trim()) return {};
  const fields: RequestAnalysisFields = {};
  let current: keyof RequestAnalysisFields | undefined;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    const m = /^(goal|scope|ambiguit(?:y|ies)|plan|risk)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const value = (m[2] ?? '').trim();
      if (key.startsWith('goal')) { current = 'goal'; fields.goal = value; }
      else if (key.startsWith('scope')) { current = 'scope'; fields.scope = value; }
      else if (key.startsWith('ambig')) { current = 'ambiguities'; fields.ambiguities = value; }
      else if (key.startsWith('plan')) { current = 'plan'; fields.plan = value; }
      else if (key.startsWith('risk')) { current = 'risk'; fields.risk = value; }
    } else if (current && line) {
      fields[current] = ((fields[current] ?? '') + '\n' + line).trim();
    }
  }
  for (const k of Object.keys(fields) as Array<keyof RequestAnalysisFields>) {
    if (!fields[k]?.trim()) delete fields[k];
  }
  return fields;
}

export interface RuntimeHarnessProfile {
  profileName: 'strict-verification' | 'velocity-first' | 'read-only-guard' | 'balanced-default';
  /** @deprecated Kept for profile API compatibility; evidence policy decides whether reproduction is required. */
  enforceScratchTest: boolean;
  criticStrictness: 'strict' | 'standard' | 'lenient';
  compactionRatioBias: number;
  guidance: string;
}

export function resolveRuntimeHarnessProfile(taskClass?: string, phase?: string): RuntimeHarnessProfile {
  const isBugfixOrSecurity = taskClass === 'bugfix' || taskClass === 'security';
  const isExploration = phase === 'explore' || taskClass === 'exploration' || taskClass === 'docs';
  const isScaffoldOrFeature = taskClass === 'feature' || taskClass === 'scaffold' || taskClass === 'greenfield';

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

/**
 * AgentLoop - Trái tim điều phối vòng đời của Coding Agent (DeepSeek-Harness Ready)
 * 
 * Vòng lặp vận hành theo kiến trúc Plugin & Micro-Kernel:
 * 1. Warm-Start: Nạp Project Knowledge Digest từ bộ nhớ dài hạn.
 * 2. Tối ưu hoá Token và nén ngữ cảnh (Context Compactor).
 * 3. Gửi Session messages + Tools cho LLM (Real-time Streaming).
 * 4. System 2: Bóc tách và hiển thị Deep Reasoning / CoT Internal Monologue.
 * 5. System 1: Điều phối gọi Tool qua 5-stage pipeline an toàn.
 * 6. Continuation Protocol: Tự động phát hiện và khôi phục khi LLM trả về turn rỗng (chống dừng sớm).
 * 7. Reflection Engine: Kích hoạt Debugging Protocol khi gặp lỗi.
 */
export class AgentLoop {
  private llm: any;
  private toolRegistry: ToolRegistry;
  private toolProvider: ToolProvider;
  private toolRunner: ToolRunner;
  private _workspace: Workspace;
  readonly maxSteps: number;
  readonly checkpointManager: CheckpointManager;
  readonly contextCompactor: ContextCompactor;
  private lastRequestEnvelope?: { sessionId: string; envelope: Omit<ModelRequestEnvelope, 'history'> };
  private rejectedTurnCandidateKey?: string;
  readonly contextGuardian: ContextGuardian;
  readonly contextAgent: ContextAgent;
  readonly turnMemoryRetriever: TurnMemoryRetriever;
  readonly planManager: PlanManager;
  readonly goalManager: GoalManager;
  readonly agentHooks: AgentHookRegistry;
  readonly inbox: AgentInbox;
  readonly promptAssembler: PromptAssembler;
  readonly agentRegistry: AgentRegistry;
  readonly agentId: string;
  readonly subagentManager: SubagentManager;
  readonly orchestrator: AgentOrchestrator;
  readonly effectLedger: EffectLedger;
  readonly progressGuard = new LoopProgressGuard();
  readonly processFailureDetector = new ProcessFailureDetector();
  readonly domainIntentGuardian = new DomainIntentGuardian();
  readonly finalAnswerGuard = new FinalAnswerGuard();
  readonly completionEvidenceGate = new CompletionEvidenceGate();
  readonly verificationPolicy: VerificationPolicy;
  readonly reflectionEngine: ReflectionEngine;
  readonly memoryManager: ProjectMemoryManager;
  readonly hypothesisTracker = new HypothesisTracker();
  readonly epistemicEngine = new EpistemicInvestigationEngine();
  readonly criticGate: CriticGate;
  readonly speculativeManager: SpeculativeBranchManager;
  readonly adaptiveReasoning = new AdaptiveReasoningController();
  readonly rollbackOrchestrator: HypothesisRollbackOrchestrator;
  readonly workspaceVerifier: WorkspaceStateVerifier;
  readonly cognitiveHarness = new CognitiveHarness();
  readonly contextSnapshotManager: ContextSnapshotManager;
  private targetFilesModifiedInTurn = new Set<string>();
  private editToolCallsInTurn = 0;
  private ephemeralScratchFiles = new Set<string>();
  readonly kernel?: AgentKernel;
  private sessionPersistence?: SessionPersistence;
  private _isGoalMode: boolean = false;
  private drainingInbox = false;
  private drainingSessionId?: string;
  private drainScheduled = false;
  private runQueues = new Map<string, Promise<string>>();
  readonly MAX_CIRCUIT_BREAKER_RETRIES = 5;
  private circuitBreakerRetriesBySession = new Map<string, number>();

  private getCircuitBreakerRetries(sessionId: string): number {
    return this.circuitBreakerRetriesBySession.get(sessionId) || 0;
  }

  private setCircuitBreakerRetries(sessionId: string, count: number): void {
    if (count <= 0) {
      this.circuitBreakerRetriesBySession.delete(sessionId);
    } else {
      this.circuitBreakerRetriesBySession.set(sessionId, count);
    }
  }
  private circuitBreakerTrippedTools = new Set<string>();
  private sessionInspectedFiles = new Set<string>();
  private activeSession?: Session;
  private loopOptions?: AgentLoopOptions;
  readonly toolAdvisor = new ToolSynergyAdvisor();
  readonly repositoryMap: GraphRankedRepositoryMap;
  readonly repositoryMemory: CitationValidatedRepositoryMemory;
  private lastToolExecution?: { toolName: string; result: any; guardianDiagnosis?: any };
  private lastMutationForInvestigation?: FailureInvestigationMutation;
  readonly classificationEngine = new ClassificationEngine();
  readonly thisTurnToolGate = new ThisTurnToolGate();
  readonly toolControlTelemetry = new ToolControlTelemetry();
  readonly latencyOrchestrator: LatencyOrchestrator;
  readonly contextBudgetManager: ContextBudgetManager;
  readonly dynamicContextCache = new DynamicContextCache<{
    repositoryMemoryContext: string;
    repositoryMemoryRecords: Awaited<ReturnType<CitationValidatedRepositoryMemory['recall']>>['records'];
    repositoryContext: string;
  }>();
  readonly dynamicContextArbiter: DynamicContextArbiter;
  readonly stepRetrievalQueryBuilder = new StepRetrievalQueryBuilder();
  readonly contextQualityEvaluator = new ContextQualityEvaluator();
  readonly reliableToolOrchestrationTelemetry = new ReliableToolOrchestrationTelemetry();
  readonly aciGuardrails = new AciGuardrails();
  readonly trajectorySteps: TrajectoryStep[] = [];
  private lastCommandExecutionState?: {
    command: string;
    success: boolean;
    exitCode?: number;
    commandOutcome?: string;
    filesModifiedSince: number;
  };

  private isEvidenceSufficient(): boolean {
    const last = this.lastToolExecution;
    if (!last || last.result?.error || last.result?.success === false) return false;

    if (last.toolName === 'read_file' && last.result?.symbol && last.result?.completeDeclaration) {
      return true;
    }
    if (this.verificationPolicy.hasReproduction()) {
      return true;
    }
    const targetFile = this.hypothesisTracker.getLatestHypothesis()?.targetFiles?.[0];
    if (targetFile && last.toolName === 'read_file' && last.result?.path) {
      const normalizedTarget = targetFile.replace(/\\/g, '/').toLowerCase();
      const normalizedPath = String(last.result.path).replace(/\\/g, '/').toLowerCase();
      if (normalizedPath.endsWith(normalizedTarget) || normalizedTarget.endsWith(normalizedPath)) {
        return true;
      }
    }
    return false;
  }
  readonly stepPromptPolicy = new StepPromptPolicy();
  private stepDynamicSuffixes = new Map<number, string>();
  /** One-shot nudge when a concurrent read batch observed a mid-flight FS change. */
  private pendingSnapshotNudge: string | undefined;
  /** Latched cascade-repair freeze: set when ≥3 fails share one error signature. */
  private cascadeFreeze: { signature: string; count: number } | undefined;
  /** Turn-measured edit impact for the verify gate (never LLM-declared). */
  private editTouchedCallers = false;
  private maxEditBlastRisk: string | undefined;
  readonly pipelinedDispatcher = new PipelinedToolDispatcher();
  private _latestReasoning?: { thought: string; timestamp: string; step: number; turn: number };
  private _collapsePreferences: UICollapsePreferences = { ...DEFAULT_COLLAPSE_PREFERENCES };
  private cachedTurnNumber?: number;
  private cachedTurnToolDeclarations?: any[];
  private cachedTurnToolProviderSize?: number;
  private cachedTurnToolPhase?: string;
  private cachedTurnToolPhaseVersion?: number;
  private cachedHasPlan?: boolean;

  get latestReasoning(): { thought: string; timestamp: string; step: number; turn: number } | undefined {
    return this._latestReasoning;
  }

  /**
   * Persist a model thought as a projection-excluded session event.
   * Reasoning records never enter getHistory()/model context — persistence
   * is purely additive to the event log (no token cost). Selection follows
   * shouldPersistReasoning: failure > high-risk > explicit debug mode.
   */
  private persistStepReasoning(
    session: Session,
    thought: string | undefined,
    ctx: {
      failure?: boolean;
      failureTrigger?: string;
      highRisk?: boolean;
      highRiskTrigger?: string;
      debugLogEnabled?: boolean;
      step?: number;
      turn?: number;
    },
  ): void {
    const { step, turn, ...selection } = ctx;
    const decision = shouldPersistReasoning({ thought: thought || '', ...selection });
    if (!decision.persist || !decision.kind || !thought) return;
    session.addReasoning(thought, { kind: decision.kind, step, turn, trigger: decision.trigger });
  }

  get collapsePreferences(): UICollapsePreferences {
    return this._collapsePreferences;
  }

  setCollapsePreferences(prefs: Partial<UICollapsePreferences>): void {
    this._collapsePreferences = { ...this._collapsePreferences, ...prefs };
  }

  constructor(
    kernelOrLLM: AgentKernel | any,
    toolRegistry?: ToolRegistry,
    options?: AgentLoopOptions
  ) {
    this.loopOptions = options;
    if (kernelOrLLM instanceof AgentKernel) {
      this.kernel = kernelOrLLM;
      this.llm = this.kernel.ctx.llm;
      this.toolRegistry = this.kernel.ctx.tools;
      this._workspace = this.kernel.ctx.workspace;
      this.toolProvider = options?.toolScope || this.toolRegistry;
      this.toolRunner = options?.toolScope
        ? new ToolRunner(this.toolProvider, this._workspace, this.kernel.ctx.permissions, this.kernel.ctx.compose)
        : this.kernel.ctx.toolRunner;
      this.checkpointManager = this.kernel.ctx.checkpoints;
      this.contextCompactor = this.kernel.ctx.compactor;
      this.planManager = this.kernel.ctx.plan;
      this.goalManager = this.kernel.ctx.goal;
      this.agentHooks = this.kernel.ctx.agentHooks;
      this.inbox = this.kernel.ctx.inbox;
      this.promptAssembler = this.kernel.ctx.systemPrompt;
      this.agentRegistry = options?.agentRegistry || this.kernel.ctx.agents;
      this.agentId = options?.agentId || 'coding-agent';
      this.reflectionEngine = this.kernel.ctx.reflection;
      this.memoryManager = this.kernel.ctx.memory;
      this.repositoryMemory = this.kernel.ctx.repositoryMemory;
      this.effectLedger = new EffectLedger();
      this.verificationPolicy = this.kernel.ctx.verification || new VerificationPolicy();
      this.verificationPolicy.setWorkspaceRoot(this._workspace.rootDir);
      this.criticGate = this.kernel.ctx.critic || new CriticGate(this.completionEvidenceGate);
      this.speculativeManager = new SpeculativeBranchManager(this._workspace.rootDir);
      this.workspaceVerifier = new WorkspaceStateVerifier(this._workspace);
      this.rollbackOrchestrator = new HypothesisRollbackOrchestrator(this.checkpointManager, this.speculativeManager);
      this.repositoryMap = new GraphRankedRepositoryMap(this._workspace);
      this.contextSnapshotManager = new ContextSnapshotManager(this._workspace.rootDir);
      this.contextSnapshotManager.init().catch(() => { });
      this.contextGuardian = options?.contextGuardian ?? new ContextGuardian(this._workspace.rootDir);
      this.contextAgent = options?.contextAgent ?? new ContextAgent(this._workspace.rootDir);
      this.turnMemoryRetriever = new TurnMemoryRetriever(this._workspace.rootDir);
      this.turnMemoryRetriever.init().catch(() => { });
      this.maxSteps = options?.maxSteps ?? Infinity;
      this.sessionPersistence = options?.sessionPersistence;
      registerSubmitSolutionTool(this.toolRegistry, this._workspace);
      registerReportFindingsTool(this.toolRegistry, this._workspace);
      this.toolRegistry.attachHypothesisTracker(this.hypothesisTracker, this._workspace);
      this.toolRegistry.attachGitTools(this._workspace);
      this.kernel.init().catch(() => { });
    } else {
      this.llm = kernelOrLLM;
      this._workspace = options?.workspace ?? new Workspace();
      this.toolRegistry = toolRegistry ?? new ToolRegistry();
      this.toolProvider = options?.toolScope || this.toolRegistry;
      this.toolRunner = new ToolRunner(this.toolProvider, this._workspace);
      this.maxSteps = options?.maxSteps ?? Infinity;
      this.checkpointManager = options?.checkpointManager ?? new CheckpointManager(this._workspace.rootDir);
      this.contextCompactor = options?.contextCompactor ?? new ContextCompactor();
      this.contextGuardian = options?.contextGuardian ?? new ContextGuardian(this._workspace.rootDir);
      this.contextAgent = options?.contextAgent ?? new ContextAgent(this._workspace.rootDir);
      this.turnMemoryRetriever = new TurnMemoryRetriever(this._workspace.rootDir);
      this.turnMemoryRetriever.init().catch(() => { });
      this.planManager = new PlanManager();
      this.goalManager = new GoalManager();
      this.agentHooks = new AgentHookRegistry();
      this.inbox = new AgentInbox();
      this.promptAssembler = new PromptAssembler();
      const sectionsToRegister = options?.promptSections || DEFAULT_PROMPT_SECTIONS;
      for (const section of sectionsToRegister) {
        this.promptAssembler.register(section);
      }
      this.agentRegistry = options?.agentRegistry || new AgentRegistry();
      this.agentId = options?.agentId || 'coding-agent';
      this.reflectionEngine = new ReflectionEngine();
      this.memoryManager = new ProjectMemoryManager(this._workspace.rootDir);
      this.repositoryMemory = new CitationValidatedRepositoryMemory(this._workspace);
      this.effectLedger = new EffectLedger();
      this.verificationPolicy = new VerificationPolicy();
      this.verificationPolicy.setWorkspaceRoot(this._workspace.rootDir);
      this.criticGate = new CriticGate(this.completionEvidenceGate);
      this.speculativeManager = new SpeculativeBranchManager(this._workspace.rootDir);
      this.workspaceVerifier = new WorkspaceStateVerifier(this._workspace);
      this.rollbackOrchestrator = new HypothesisRollbackOrchestrator(this.checkpointManager, this.speculativeManager);
      this.repositoryMap = new GraphRankedRepositoryMap(this._workspace);
      this.contextSnapshotManager = new ContextSnapshotManager(this._workspace.rootDir);
      this.contextSnapshotManager.init().catch(() => { });
      this.sessionPersistence = options?.sessionPersistence;

      // Đăng ký các planning và memory tools vào toolRegistry
      this.toolRegistry.attachPlanManager(this.planManager);
      this.toolRegistry.attachMemoryManager(this.memoryManager);
      this.toolRegistry.attachRepositoryMemory(this.repositoryMemory);
      registerSubmitSolutionTool(this.toolRegistry, this._workspace);
      registerReportFindingsTool(this.toolRegistry, this._workspace);
      this.toolRegistry.attachHypothesisTracker(this.hypothesisTracker, this._workspace);
      this.toolRegistry.attachGitTools(this._workspace);

      this.checkpointManager.init().catch(() => { });
      this.memoryManager.init(this._workspace).catch(() => { });
      this.repositoryMemory.init().catch(() => { });
    }

    // Bảo tồn KV-Cache Prefix của OpenAI Codex trong suốt vòng lặp
    this.contextCompactor.setConfig({ preservePrefixCache: true });
    this.contextBudgetManager = new ContextBudgetManager(this.contextCompactor, {
      mode: resolveContextManagementMode(options?.contextManagementMode || process.env.MINUS_CONTEXT_MANAGEMENT_MODE),
      triggerRatio: options?.requestCompactionRatio
        ?? envFiniteNumber('MINUS_REQUEST_COMPACTION_RATIO'),
    });
    const dynamicBudget = options?.dynamicContextBudget ?? (process.env.MINUS_DYNAMIC_CONTEXT_BUDGET ? parseInt(process.env.MINUS_DYNAMIC_CONTEXT_BUDGET, 10) : 2000);
    this.dynamicContextArbiter = new DynamicContextArbiter(dynamicBudget);
    this.latencyOrchestrator = new LatencyOrchestrator({
      enabled: options?.enableLatencyOptimization
        ?? envFeatureEnabled('MINUS_LATENCY_OPTIMIZATION'),
      softStepTargetMs: options?.softStepTargetMs
        ?? envFiniteNumber('MINUS_SOFT_STEP_TARGET_MS'),
      requestBudgetRatio: options?.requestCompactionRatio
        ?? envFiniteNumber('MINUS_REQUEST_COMPACTION_RATIO'),
    });

    this.agentRegistry.register(this.agentId, this.agentId);
    this.agentRegistry.registerBenchmarkSpecialists();
    this.subagentManager = new SubagentManager(
      this.agentRegistry,
      (agentId, session, subagentOptions, signal) => this.createSubagentLoop(agentId, session, subagentOptions, signal),
      (session) => this.persistSession(session),
    );
    this.orchestrator = new AgentOrchestrator(this.agentRegistry, this.subagentManager);
    this.orchestrator.bindPlanManager(this.planManager);
    if (options?.enableSubagents !== false) {
      this.toolRegistry.register(createDelegateAgentTool(this.subagentManager));
      this.toolRegistry.register(createSpawnAgentTool(this.subagentManager));
      this.toolRegistry.register(createWaitAgentTool(this.subagentManager));
      this.toolRegistry.register(createGetAgentResultTool(this.subagentManager));
      this.toolRegistry.register(createStopAgentTool(this.subagentManager));
      this.toolRegistry.register(createResumeAgentTool(this.subagentManager));
      this.toolRegistry.register(createAllocateAgentTaskTool(this.orchestrator));
      this.toolRegistry.register(createBrainstormDesignTool());
      this.toolRegistry.register(createVerifySubagentQualityTool(this.orchestrator));
      this.toolRegistry.register(createScheduleDagParallelTool(this.orchestrator));
    }

    if (typeof (this.toolRegistry as any).registerGameTools === 'function') {
      try {
        const ctx = detectPromptContext(this._workspace);
        if (ctx.isUnity) {
          (this.toolRegistry as any).registerGameTools().catch(() => {});
        }
      } catch { }
    }
  }

  get workspace(): Workspace {
    return this._workspace;
  }

  get isGoalMode(): boolean {
    return this._isGoalMode;
  }

  setGoalMode(enabled: boolean): void {
    this._isGoalMode = enabled;
  }

  setWorkspace(workspace: Workspace) {
    this._workspace = workspace;
    this.verificationPolicy.setWorkspaceRoot(workspace.rootDir);
    this.dynamicContextCache.invalidate();
    this.repositoryMap.setWorkspace(workspace);
    this.repositoryMemory.setWorkspace(workspace);
    if (typeof (this.toolRegistry as any).registerGameTools === 'function') {
      try {
        const ctx = detectPromptContext(workspace);
        if (ctx.isUnity) {
          (this.toolRegistry as any).registerGameTools().catch(() => {});
        }
      } catch { }
    }
    if (this.kernel) {
      this.kernel.ctx.setWorkspace(workspace);
      (this as any).checkpointManager = this.kernel.ctx.checkpoints;
      (this as any).memoryManager = this.kernel.ctx.memory;
      (this as any).repositoryMemory = this.kernel.ctx.repositoryMemory;
      if (this.toolProvider === this.toolRegistry) {
        this.toolRunner = this.kernel.ctx.toolRunner;
      } else {
        this.toolRunner = new ToolRunner(this.toolProvider, workspace, this.kernel.ctx.permissions, this.kernel.ctx.compose);
      }
    } else {
      this.toolRunner = new ToolRunner(this.toolProvider, this._workspace, this.toolRunner.getPermissionManager?.());
      (this as any).checkpointManager = new CheckpointManager(workspace.rootDir);
      (this as any).memoryManager = new ProjectMemoryManager(workspace.rootDir);
      this.toolRegistry.attachMemoryManager(this.memoryManager);
      this.checkpointManager.init().catch(() => { });
      this.memoryManager.init(workspace).catch(() => { });
      this.repositoryMemory.init().catch(() => { });
    }
    (this as any).speculativeManager = new SpeculativeBranchManager(this._workspace.rootDir);
    (this as any).workspaceVerifier = new WorkspaceStateVerifier(this._workspace);
    (this as any).rollbackOrchestrator = new HypothesisRollbackOrchestrator(this.checkpointManager, this.speculativeManager);
    (this as any).contextSnapshotManager = new ContextSnapshotManager(this._workspace.rootDir);
    this.contextSnapshotManager.init().catch(() => { });
    (this as any).contextGuardian = new ContextGuardian(this._workspace.rootDir);
    (this as any).contextAgent = new ContextAgent(this._workspace.rootDir);
    (this as any).turnMemoryRetriever = new TurnMemoryRetriever(this._workspace.rootDir);
    this.turnMemoryRetriever.init().catch(() => { });
    this.toolRegistry.attachHypothesisTracker(this.hypothesisTracker, this._workspace);
    registerSubmitSolutionTool(this.toolRegistry, this._workspace);
    registerReportFindingsTool(this.toolRegistry, this._workspace);
  }

  setLLM(llm: any, modelName?: string) {
    this.llm = llm;
    if (this.kernel) {
      this.kernel.ctx.setLLM(llm, modelName);
    }
    if (llm && typeof llm.getTokenConfig === 'function') {
      const tokenConfig = llm.getTokenConfig();
      if (tokenConfig?.maxInputTokens) {
        this.contextCompactor.setMaxInputTokens(tokenConfig.maxInputTokens);
      }
    }
  }

  getTokenConfig(): import('../llm/token-config.js').TokenConfig | undefined {
    let baseConfig: import('../llm/token-config.js').TokenConfig | undefined = undefined;
    if (this.llm && typeof this.llm.getTokenConfig === 'function') {
      baseConfig = { ...this.llm.getTokenConfig() };
    }
    const currentDynamicBudget = this.dynamicContextArbiter?.getBudget();
    if (currentDynamicBudget !== undefined) {
      baseConfig = {
        ...(baseConfig || {}),
        dynamicContextBudget: currentDynamicBudget,
      };
    }
    return baseConfig;
  }

  setTokenConfig(config: Partial<import('../llm/token-config.js').TokenConfig>): void {
    if (this.llm && typeof this.llm.setTokenConfig === 'function') {
      this.llm.setTokenConfig(config);
    }
    if (config.maxInputTokens) {
      this.contextCompactor.setMaxInputTokens(config.maxInputTokens);
    }
    if (config.dynamicContextBudget && this.dynamicContextArbiter) {
      this.dynamicContextArbiter.setBudget(config.dynamicContextBudget);
      process.env.MINUS_DYNAMIC_CONTEXT_BUDGET = String(config.dynamicContextBudget);
    }
  }

  /**
   * Hoàn tác hành động sửa đổi gần nhất (/undo)
   */
  async rollback(session?: Session): Promise<{ success: boolean; message: string }> {
    const targetSession = session || this.activeSession;
    if (targetSession) this.effectLedger.bindSession(targetSession);
    const result = await this.checkpointManager.rollbackLast();
    if (result.success && result.checkpoint && targetSession) {
      this.effectLedger.rollbackByCheckpoint(result.checkpoint.id);
      await this.persistSession(targetSession);
    }
    return result;
  }

  private async runInternalWithCircuitBreakerRetry(
    session: Session,
    options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal; isCircuitBreakerRetry?: boolean; isRecoveryResume?: boolean },
  ): Promise<string> {
    while (true) {
      try {
        const retries = this.getCircuitBreakerRetries(session.id);
        const result = await this.runInternal(session, {
          ...options,
          isCircuitBreakerRetry: retries > 0,
        });
        this.setCircuitBreakerRetries(session.id, 0);
        return result;
      } catch (error: any) {
        // Check if this failure was due to user cancellation (AbortSignal, SIGINT, Ctrl+C, Esc)
        const isCancelled = options?.signal?.aborted
          || error?.name === 'AbortError'
          || (typeof error?.message === 'string' && (
            error.message.includes('cancellation requested') ||
            error.message.includes('COMMAND_CANCELLED') ||
            error.message.includes('aborted')
          ));

        if (isCancelled) {
          this.setCircuitBreakerRetries(session.id, 0);
          throw error;
        }

        const errClassification = classifyLLMError(error);
        const isQuotaOrRateLimit = errClassification.kind === 'HARD_QUOTA_EXHAUSTED' || errClassification.kind === 'TRANSIENT_RATE_LIMIT';
        const isServerError = errClassification.kind === 'SERVER_ERROR';
        const isRetryableLLMError = isQuotaOrRateLimit || isServerError;
        const currentRetries = this.getCircuitBreakerRetries(session.id);

        if (isRetryableLLMError && currentRetries < this.MAX_CIRCUIT_BREAKER_RETRIES) {
          const nextRetries = currentRetries + 1;
          this.setCircuitBreakerRetries(session.id, nextRetries);

          // 1. Phục hồi an toàn session invariants (đóng open step/turn)
          try {
            if (session.recoverInterrupted()) {
              await this.persistSession(session);
            }
          } catch { }

          // 2. Tự động gửi ngầm prompt "Continue" cho LLM (ẩn với người dùng bằng source='system')
          session.addUserMessage('Continue', 'system');
          try {
            await this.persistSession(session);
          } catch { }

          // 3. Backoff delay trước khi gọi lại LLM (môi trường test delay cực ngắn)
          const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(this.llm?.constructor?.name?.includes('Mock'));
          const backoffMs = isTestEnv
            ? 5
            : (errClassification.retryAfterMs ?? Math.min(1500 * Math.pow(1.5, nextRetries - 1), 8000));

          const sleepResult = await this.sleepWithWakeup(session.id, backoffMs, options?.signal);
          if (sleepResult.aborted || options?.signal?.aborted) {
            throw new Error('Agent stopped: cancellation requested.');
          }

          // Ẩn thông báo CIRCUIT_BREAKER_TRIGGERED và tự động lặp tiếp tục turn dở dang
          continue;
        }

        if (isRetryableLLMError && currentRetries >= this.MAX_CIRCUIT_BREAKER_RETRIES) {
          const detailMsg = isServerError
            ? `LLM provider is overloaded or unavailable: the system has automatically sent the "Continue" prompt 5 times but the LLM server still reports an error (${errClassification.kind}: ${errClassification.message || 'Model temporarily under high load / 503 UNAVAILABLE'}). Please wait a few minutes and retry, or switch to another model with the /model command.`
            : `LLM quota exhausted: the system has automatically sent the "Continue" prompt 5 times but the LLM still reports a quota error (${errClassification.kind}: ${errClassification.message || 'API quota depleted or continuously rate-limited'}). Please switch to another model with the /model command or check your billing plan.`;
          const quotaExhaustedError = new Error(detailMsg);
          (quotaExhaustedError as any).isQuotaExhausted = isQuotaOrRateLimit;
          (quotaExhaustedError as any).isServerUnavailable = isServerError;
          (quotaExhaustedError as any).originalClassification = errClassification;
          this.setCircuitBreakerRetries(session.id, 0);
          throw quotaExhaustedError;
        }

        this.setCircuitBreakerRetries(session.id, 0);
        throw error;
      }
    }
  }

  async run(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal; isCircuitBreakerRetry?: boolean; isRecoveryResume?: boolean }): Promise<string> {
    const previous = this.runQueues.get(session.id) || Promise.resolve('');
    const current = previous.then(
      () => this.runInternalWithCircuitBreakerRetry(session, options),
      () => this.runInternalWithCircuitBreakerRetry(session, options),
    ).catch(async (error) => {
      // Check if this failure was due to user cancellation (AbortSignal, SIGINT, Ctrl+C, Esc)
      const isCancelled = options?.signal?.aborted
        || error?.name === 'AbortError'
        || (typeof error?.message === 'string' && (error.message.includes('cancellation requested') || error.message.includes('COMMAND_CANCELLED') || error.message.includes('aborted')));

      if (isCancelled) {
        this.goalManager.pause('Task execution cancelled by user.');
        session.append('goal/change', {
          reason: 'cancelled',
          goal: this.goalManager.getState(),
        });
        this.subagentManager.stopAll();
        this.pipelinedDispatcher.resetTurn();
        try {
          if (session.recoverInterrupted()) {
            await this.persistSession(session);
          }
        } catch { }
        this.setAgentStatus('idle', session);
        await CLI.renderExecutionStopped(
          'Agent stopped: cancellation requested.',
          'CANCELLED' as any,
        );
        return 'Task stopped at the request of the user.';
      }

      // Preserve an auditable, balanced lifecycle even when a provider, hook,
      // persistence adapter, or tool pipeline throws unexpectedly.
      const errClassification = (error as any)?.originalClassification || classifyLLMError(error);
      const isQuotaOrRateLimit = (error as any)?.isQuotaExhausted
        || errClassification.kind === 'HARD_QUOTA_EXHAUSTED'
        || errClassification.kind === 'TRANSIENT_RATE_LIMIT';
      const isServerUnavailable = (error as any)?.isServerUnavailable
        || errClassification.kind === 'SERVER_ERROR';
      const isCircuitBreakerSuspension = isQuotaOrRateLimit || isServerUnavailable;

      if (isCircuitBreakerSuspension) {
        try {
          await this.checkpointManager.createCheckpoint('Suspended: LLM Quota, Rate Limit, or Server Unavailable reached', {
            isTaskCheckpoint: true,
            taskId: this.planManager.getActiveTask()?.id ? `task-${this.planManager.getActiveTask()?.id}` : undefined,
          });
        } catch { }

        this.goalManager.pause(`LLM ${errClassification.kind}: ${errClassification.message}`);
        session.append('goal/change', {
          reason: isServerUnavailable ? 'suspended_server_unavailable' : 'suspended_quota_limit',
          goal: this.goalManager.getState(),
        });
      } else {
        this.goalManager.disarm();
      }

      try {
        if (session.recoverInterrupted()) {
          await this.persistSession(session);
        }
      } catch {
        // Keep the original failure as the rejection reason.
      }

      this.setAgentStatus(isCircuitBreakerSuspension ? 'idle' : 'error', session);
      const detail = error instanceof Error ? error.message : String(error);
      try {
        if (isCircuitBreakerSuspension) {
          const suspensionAdvice = (error as any)?.isQuotaExhausted || (error as any)?.isServerUnavailable
            ? error.message
            : (isQuotaOrRateLimit
                ? (errClassification.kind === 'HARD_QUOTA_EXHAUSTED'
                    ? `LLM quota exhausted (API quota depleted). You can switch to another model with the /model command, or check your billing plan before continuing.`
                    : `LLM Rate Limit Exceeded (429 frequency limit). The system has automatically saved plan progress. You can wait a few minutes and then use /goal resume or /plan resume.`)
                : `LLM Provider Server Unavailable (server overload 503). The system has automatically saved plan progress. You can wait a few minutes and then use /goal resume, or switch models with the /model command.`);
          await CLI.renderExecutionStopped(
            `Agent suspended: ${suspensionAdvice}\nDetails: ${detail}`,
            'CIRCUIT_BREAKER_TRIGGERED',
          );
        } else {
          await CLI.renderExecutionStopped(
            `Agent stopped because an unexpected execution error occurred: ${detail}`,
            'EXECUTION_ERROR',
          );
        }
      } catch {
        // Rendering must never replace or hide the original execution error.
      }
      throw error;
    });
    this.runQueues.set(session.id, current);
    try {
      return await current;
    } finally {
      if (this.runQueues.get(session.id) === current) {
        this.runQueues.delete(session.id);
      }
    }
  }

  private async runInternal(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal; isCircuitBreakerRetry?: boolean; isRecoveryResume?: boolean }): Promise<string> {
    this.activeSession = session;
    const turnUserEvent = [...session.getEvents()].reverse().find(
      (event) => event.type === 'user/message' && event.data.source !== 'system',
    );
    const turnUserRequest = turnUserEvent?.data.content?.parts
      ?.map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n') || (options?.isRecoveryResume ? '[RESUME INTERRUPTED SESSION]' : '');
    // @-attached files are investigation anchors: expand scope to their 2-hop
    // neighborhood (resolved upstream by PromptAttachmentProcessor) instead of
    // letting the model fixate on anchor content alone.
    const attachmentAnchors = detectAttachmentAnchors(turnUserRequest);
    const hasAttachmentAnchors = attachmentAnchors.length > 0;
    // Explicit ellipsis resolution: short follow-ups ("còn trang B thì sao")
    // inherit the previous turn's topic for classification/retrieval only.
    // The original wording stays untouched for plan goals, prompts, snapshots.
    const previousUserPrompts = [...session.getEvents()]
      .filter((event) => event.type === 'user/message' && event.data.source !== 'system')
      .map((event) => event.data.content?.parts
        ?.map((part: any) => typeof part?.text === 'string' ? part.text : '')
        .filter(Boolean)
        .join('\n') || '')
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (previousUserPrompts.at(-1) === turnUserRequest.replace(/\s+/g, ' ').trim()) {
      previousUserPrompts.pop();
    }
    const ellipsisResolution = resolveEllipticalFollowUp({
      current: turnUserRequest,
      previousUserPrompts: previousUserPrompts.slice(-3),
      archivedTurns: this.turnMemoryRetriever.getRecentArchivedTurns(3),
    });
    const retrievalUserRequest = ellipsisResolution.applied
      ? ellipsisResolution.expandedQuery
      : turnUserRequest;
    this.planManager.bindSession(session);
    this.goalManager.bindSession(session);
    this.memoryManager.bindSession(session);
    this.repositoryMemory.bindSession(session);
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    this.reflectionEngine.reset();
    this.progressGuard.reset();
    this.processFailureDetector.reset();
    this.processFailureDetector.initTaskKeywords(retrievalUserRequest);
    this.domainIntentGuardian.reset();
    this.domainIntentGuardian.extractAndFreezeContract(turnUserRequest);
    this.finalAnswerGuard.reset();
    this.verificationPolicy.reset();
    this.cognitiveHarness.reset();
    this.cleanupEphemeralScratchFiles();
    this.targetFilesModifiedInTurn.clear();
    this.circuitBreakerTrippedTools.clear();
    this.editTouchedCallers = false;
    this.maxEditBlastRisk = undefined;
    this.lastMutationForInvestigation = undefined;
    this.editToolCallsInTurn = 0;
    this.stepDynamicSuffixes.clear();
    this.pendingSnapshotNudge = undefined;
    this.cascadeFreeze = undefined;
    const isGoal = options?.isGoalMode ?? this._isGoalMode;
    const baseMaxSteps = options?.maxSteps ?? this.maxSteps;
    const initialTurnClassification = this.classificationEngine.classify({
      request: retrievalUserRequest,
      hasPlan: this.planManager.hasPlan(),
    });
    const isReadOnlyAnswerTask = isReadOnlyRequest(retrievalUserRequest)
      || initialTurnClassification.reversibility === 'read-only'
      || (!initialTurnClassification.requiredCapabilities.includes('edit')
        && !initialTurnClassification.requiredCapabilities.includes('git-write')
        && !initialTurnClassification.reasonCodes.some(reason => [
          'WORKSPACE_MUTATION_INTENT', 'REFACTOR_INTENT', 'PARETO_UNCERTAINTY_REQUIRES_EVIDENCE',
        ].includes(reason)));
    const taskComplexity = calculateTaskComplexity(retrievalUserRequest, initialTurnClassification.taskClass);
    const effectiveMaxSteps = Number.isFinite(baseMaxSteps)
      ? (baseMaxSteps > 5 ? Math.max(1, Math.round(baseMaxSteps * taskComplexity.scaleFactor)) : baseMaxSteps)
      : baseMaxSteps;
    const turn = session.getEvents().filter((event) => event.type === 'turn/start').length + 1;
    const isContinuationOrGoal = isGoal
      || Boolean(options?.isCircuitBreakerRetry)
      || Boolean(options?.isRecoveryResume)
      || turnUserRequest.includes('[RESUME INCOMPLETE PLAN]')
      || turnUserRequest.includes('[GOAL CONTINUATION]');
    this.planManager.beginTurn(turn, turnUserRequest, { preserveIncompletePlan: isContinuationOrGoal });
    if (isGoal && !this.planManager.hasPlan()) {
      this.planManager.setPlanRequired(true, 'goal-mode-active');
    }
    let consecutiveEmptyTurns = 0;
    let consecutiveIncompleteFinals = 0;
    let consecutivePlanCompletionRejects = 0;
    let consecutiveIncompleteFinishes = 0;
    let consecutiveNoProgressStrategyChanges = 0;
    let hasSubmittedSolution = false;
    let submittedSolutionSummary: string | undefined;
    let hasReportedFindings = false;
    let reportedFindingsMarkdown: string | undefined;
    let previousClassification: ClassificationDecision | undefined;
    const configuredControlMode = this.loopOptions?.toolControlMode || process.env.MINUS_TOOL_CONTROL_MODE || 'shadow';
    const toolControlMode: ToolControlMode = ['off', 'shadow', 'enforce'].includes(configuredControlMode)
      ? configuredControlMode as ToolControlMode
      : 'shadow';
    const batchPersistenceEnabled = this.loopOptions?.enableBatchSessionPersistence
      ?? envFeatureEnabled('MINUS_BATCH_SESSION_PERSISTENCE');
    if (toolControlMode === 'enforce') {
      const activeTask = this.planManager.getActiveTask();
      const targetFiles = [
        ...(activeTask?.writeSet || []),
        ...(activeTask?.readSet || []),
      ];
      const baselineDiagnostics = this.collectVerificationDiagnostics(targetFiles);
      if (baselineDiagnostics) {
        try {
          await this.verificationPolicy.getBaselineManager().captureBaseline(this._workspace, baselineDiagnostics);
        } catch {
          // Baseline enrichment must not make the main control plane unavailable.
        }
      }
    }
    const maxEmptyRetries = 2;
    const maxIncompleteFinishRetries = 3;
    const maxIncompleteFinalRetries = 3;
    const maxPlanCompletionRetries = 3;
    const maxNoProgressStrategyChanges = 3;
    const claimedSteerItems: AgentInboxItem[] = [];
    const resolveSteerItems = (answer: string) => {
      while (claimedSteerItems.length > 0) {
        const item = claimedSteerItems.shift();
        try {
          item?.resolve(answer);
        } catch { }
      }
    };
    const rejectSteerItems = (err: unknown) => {
      while (claimedSteerItems.length > 0) {
        const item = claimedSteerItems.shift();
        try {
          item?.reject(err);
        } catch { }
      }
    };

    const onAbort = () => {
      this.subagentManager.stopAll();
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        this.subagentManager.stopAll();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      this.setAgentStatus('running', session, turn);

    const isRootAgent = this.agentId === 'root'
      || this.agentId === 'main'
      || this.agentId === 'primary'
      || this.agentId === 'interactive-agent'
      || this.agentId === 'coding-agent'
      || this.agentId === 'delegation-parent'
      || this.agentId === 'delegation-recovery-parent';
    const isSubagent = !isRootAgent || this.loopOptions?.enableSubagents === false || Boolean(this.agentId?.startsWith('subagent-'));
    this.latencyOrchestrator.resetTurn();

    session.append('turn/start', { turn });
    if (!batchPersistenceEnabled) {
      await this.persistSession(session);
    }
    const turnStartDecision = await this.agentHooks.run('agent/turn-start', {
      session,
      turn,
      maxSteps: effectiveMaxSteps,
      isGoalMode: isGoal,
      metadata: {},
    });
    if (!turnStartDecision.allow) {
      const rejectionMessage = `Agent turn rejected: ${turnStartDecision.reason || 'turn hook rejected execution.'}`;
      await CLI.renderExecutionStopped(rejectionMessage, 'TURN_REJECTED');
      await this.endTurn(session, turn, effectiveMaxSteps, isGoal, turnStartDecision.reason || 'turn-rejected');
      this.goalManager.disarm();
      rejectSteerItems(new Error(rejectionMessage));
      return rejectionMessage;
    }

    // 0. Context Drift & Inter-Task Semantic Handoff (context-management-context-save)
    const latestSnapshot = await this.contextSnapshotManager.getLatestSnapshot().catch(() => undefined);
    if (latestSnapshot) {
      const drift = await this.contextSnapshotManager.detectDrift(latestSnapshot).catch(() => undefined);
      if (drift?.hasDrift) {
        CLI.renderContextDriftWarning(drift);
      }
    }

    // 1. Warm-Start: Nạp tóm tắt trí nhớ Repo vào đầu Session nếu là phiên mới
    const history = session.getHistory();
    if (history.length === 1 && history[0].role === 'user') {
      const userText = history[0].parts?.[0]?.text || '';
      if (!userText.includes('[PROJECT KNOWLEDGE BASE')) {
        const digest = this.memoryManager.getProjectDigest({ query: userText });
        const relevantMemory = this.memoryManager
          .getRelevantMemory(userText, session, 4)
          .filter((item) => item.scope !== 'project');
        const scopedMemory = relevantMemory.length > 0
          ? `\n[SESSION / GOAL MEMORY - RETRIEVED BY RELEVANCE]\n${relevantMemory
            .map((item) => `- [${item.scope}/${item.key}; confidence=${item.confidence.toFixed(2)}] ${item.insight}`)
            .join('\n')}\n`
          : '';
        let prefix = `${digest}\n\n`;
        prefix += scopedMemory;
        if (latestSnapshot) {
          prefix += `${this.contextSnapshotManager.generateHandoffDigest([latestSnapshot])}\n\n`;
        }
        if (isGoal) {
          prefix += `[AUTONOMOUS GOAL MODE ACTIVE - UNLIMITED STEPS]:\nYou are operating in autonomous Goal Mode without step limits. Continue executing tools, inspecting, decomposing plans, writing/modifying code, and verifying results until the entire goal is completely achieved. Only return your final response once all steps and empirical verifications have succeeded.\n\n`;
        } else if (!isFinite(effectiveMaxSteps)) {
          prefix += `[DYNAMIC CONVERGENCE ACTIVE - UNBOUNDED EXECUTION]:\nYou are operating in dynamic convergence mode without arbitrary step limits. Continue executing tools, inspecting, coding, and verifying results until the task is completely achieved and empirically verified. Do not stop prematurely.\n\n`;
        }
        if (resolveStepPromptGatingMode(this.loopOptions?.stepPromptGatingMode) !== 'enforce') {
          const initialScaffold = this.cognitiveHarness.createScaffold({
            request: userText,
            phase: 'explore',
            hasAttachments: hasAttachmentAnchors,
            anchorPaths: attachmentAnchors,
          });
          prefix += `${this.cognitiveHarness.formatScaffoldForPrompt(initialScaffold)}\n\n`;
        }
        const rewrittenHistory = history.map((message, index) =>
          index === 0
            ? { ...message, parts: [{ text: `${prefix}[USER INSTRUCTION]:\n${userText}` }] }
            : message
        );
        session.replaceHistory(rewrittenHistory, 'warm-start');
        if (!batchPersistenceEnabled) {
          await this.persistSession(session);
        }
      }
    }

    for (let step = 1; step <= effectiveMaxSteps; step++) {
      if (options?.signal?.aborted) {
        const cancellationMessage = 'Agent stopped: cancellation requested.';
        this.subagentManager.stopAll();
        await CLI.renderExecutionStopped(cancellationMessage, 'CANCELLED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'cancelled');
        this.goalManager.disarm();
        rejectSteerItems(new Error(cancellationMessage));
        // NOTE: queued (not yet claimed) steering messages are preserved when a
        // drain loop owns this session, so the post-turn drain can execute them
        // with a fresh signal. Without a drainer (direct run), clear to avoid
        // hanging promises.
        if (!this.drainingInbox || this.drainingSessionId !== session.id) {
          this.inbox.clear(session.id, cancellationMessage);
        }
        return cancellationMessage;
      }

      // Mid-Turn Steerability (Google Antigravity Queued Messages Standard)
      // Check if user submitted a queued steering message while the loop was executing
      const steerItem = this.inbox.claimSteerMessage(session.id, this.drainingInbox);
      if (steerItem) {
        claimedSteerItems.push(steerItem);
        const steerPrompt = `[USER QUEUED MESSAGE (MID-TURN STEERING)]:\n${steerItem.text}`;
        session.addUserMessage(steerPrompt, steerItem.source, steerItem.id);
        session.append('input/claimed', {
          inputId: steerItem.id,
          isSteering: true,
          step,
          turn,
        });
        await this.persistSession(session);
        CLI.renderSteeringNotice(steerItem.text);
        this.kernel?.ctx.events.emit('model:steered', {
          sessionId: session.id,
          inputId: steerItem.id,
          text: steerItem.text,
          step,
          turn,
        });
        consecutiveEmptyTurns = 0;
        consecutiveIncompleteFinals = 0;
        consecutivePlanCompletionRejects = 0;
        consecutiveIncompleteFinishes = 0;
        consecutiveNoProgressStrategyChanges = 0;
      }

      session.append('step/start', { turn, step });
      if (!batchPersistenceEnabled) {
        await this.persistSession(session);
      }
      this.setAgentStatus('running', session, turn, step);
      const hookContext: AgentHookContext = {
        session,
        turn,
        step,
        maxSteps: effectiveMaxSteps,
        isGoalMode: isGoal,
        metadata: {},
      };
      const preStepDecision = await this.agentHooks.run('agent/pre-step', hookContext);
      if (!preStepDecision.allow) {
        const rejectionMessage = `Agent step rejected: ${preStepDecision.reason || 'pre-step hook rejected execution.'}`;
        session.append('step/end', { turn, step, reason: preStepDecision.reason || 'pre-step-rejected' });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: preStepDecision.reason || 'pre-step-rejected',
        });
        await CLI.renderExecutionStopped(rejectionMessage, 'PRE_STEP_REJECTED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, preStepDecision.reason || 'pre-step-rejected');
        this.goalManager.disarm();
        return rejectionMessage;
      }
      // A single whole-request budget gate runs immediately before the provider
      // call, after tools and dynamic context are known.
      const userConfiguredInput = typeof this.llm?.getTokenConfig === 'function'
        ? this.llm.getTokenConfig()?.maxInputTokens
        : undefined;
      const maxBudget = userConfiguredInput || this.contextCompactor.getConfig().maxTotalHistoryTokens || 32000;
      // Tự động căn chỉnh workingHistoryBudget theo tỷ lệ 75% cấu hình người dùng (từ /token low/medium/high/max)
      const workingHistoryBudget = userConfiguredInput
        ? Math.floor(userConfiguredInput * 0.75)
        : Math.min(maxBudget, 24000);

      const requestDecision = await this.agentHooks.run('agent/request', hookContext);
      if (!requestDecision.allow) {
        const rejectionMessage = `Agent request rejected: ${requestDecision.reason || 'request hook rejected execution.'}`;
        session.append('step/end', { turn, step, reason: requestDecision.reason || 'request-rejected' });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: requestDecision.reason || 'request-rejected',
        });
        CLI.renderStepFooter();
        await CLI.renderExecutionStopped(rejectionMessage, 'REQUEST_REJECTED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, requestDecision.reason || 'request-rejected');
        this.goalManager.disarm();
        return rejectionMessage;
      }

      // 3. Gửi session hiện tại cho LLM (ưu tiên Real-time Streaming)
      // Dynamic Tool Retrieval: Duy trì Tool Declarations ổn định (Stable Prefix) theo chuẩn OpenAI Codex
      const activeTask = this.planManager.getActiveTask();
      const validatedHypotheses = this.hypothesisTracker.getValidatedHypotheses();
      const supportedHypotheses = this.hypothesisTracker.getSupportedHypotheses();
      const hasValidatedHypothesis = validatedHypotheses.length > 0;
      const supportedHypothesisCount = supportedHypotheses.length;
      const minimumHypothesisRisk = hypothesisBlastRadiusRisk([
        ...validatedHypotheses,
        ...supportedHypotheses,
      ]);
      const priorClassification = previousClassification;
      const classificationInput = {
        request: retrievalUserRequest,
        activeTask: activeTask?.title,
        activeAcceptance: activeTask?.acceptanceCriteria,
        hasPlan: this.planManager.hasPlan(),
        hasUnverifiedChanges: this.verificationPolicy.hasPendingModifications(),
        lastToolName: this.lastToolExecution?.toolName,
        lastToolFailed: Boolean(this.lastToolExecution && isToolResultFailure(this.lastToolExecution.result || {})),
        previous: previousClassification,
        hasValidatedHypothesis,
        minimumRisk: minimumHypothesisRisk,
      };
      const provisionalClassification = this.classificationEngine.classify(classificationInput);
      let paretoEvidence = assessParetoEvidence({
        session,
        turn,
        taskClass: provisionalClassification.taskClass,
        risk: provisionalClassification.risk,
        validatedHypothesisCount: validatedHypotheses.length,
        supportedHypothesisCount,
      });
      let inspectedLowRiskFastPath = ['R0', 'R1', 'R2'].includes(provisionalClassification.risk)
        && paretoEvidence.inspectedFiles.length > 0;
      const classified = this.classificationEngine.classify({
        ...classificationInput,
        hasDirectEvidence: paretoEvidence.hasSufficientEvidence || inspectedLowRiskFastPath,
        evidenceScore: paretoEvidence.score,
        evidenceThreshold: paretoEvidence.threshold,
      });
      const lifecycleClassification = applyPhaseLifecycle(classified, session, turn);
      const classification = applyPhaseAuthority(lifecycleClassification, session, turn);
      const exploreCompletedNow = false;
      previousClassification = classification;

      const configuredReproMode = configuredEvidenceGateMode()
        || (process.env.MINUS_REPRODUCTION_GATE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'observe');

      // Cập nhật ngữ cảnh Cổng Pareto 80/20 Thích Ứng & Reproduction Verification cho ToolUseGuardian
      this.toolRunner.guardian.setPreMutationGateContext({
        isBugfixTask: classification.taskClass === 'bugfix',
        taskIntent: classification.taskClass,
        taskClass: classification.taskClass,
        phase: classification.phase,
        hasPlan: this.planManager.hasPlan(),
        evidenceGateMode: configuredEvidenceGateMode() || 'enforce',
        hasValidatedHypothesis,
        supportedHypothesisCount,
        targetFiles: [
          ...validatedHypotheses,
          ...supportedHypotheses,
        ].flatMap((h) => h.targetFiles || []),
        validatedTargetFiles: validatedHypotheses.flatMap((h) => h.targetFiles || []),
        risk: classification.risk,
        evidenceScore: paretoEvidence.score,
        evidenceThreshold: paretoEvidence.threshold,
        evidenceReasons: paretoEvidence.reasons,
        inspectedFiles: Array.from(new Set([
          ...(paretoEvidence.inspectedFiles || []),
          ...this.sessionInspectedFiles,
        ])),
        hasEmpiricalEvidence: paretoEvidence.hasEmpiricalEvidence,
        hasSubmittedSolution,
        cascadeFrozen: this.cascadeFreeze !== undefined,
        ...(this.cascadeFreeze
          ? { cascadeReason: `${this.cascadeFreeze.count} consecutive failures share one error signature: ${this.cascadeFreeze.signature.slice(0, 200)}` }
          : {}),
        allMutationsAreNonExecutable: this.completionEvidenceGate.hasOnlyNonExecutableMutations(session, turn),
        userExplicitlyExemptsTesting: isUserExplicitlyExemptingTests(retrievalUserRequest),
        reproductionStatus: {
          enforceReproductionPass: configuredReproMode === 'enforce' && classification.taskClass === 'bugfix',
          hasPostFixPass: this.completionEvidenceGate.hasPostFixReproductionPass(session, turn),
          hasPreFixRepro: paretoEvidence.hasFailureEvidence || hasValidatedHypothesis,
        },
      });

      const activeTargetFile = activeTask?.writeSet?.[0]
        || validatedHypotheses[0]?.targetFiles?.[0]
        || supportedHypotheses[0]?.targetFiles?.[0]
        || paretoEvidence.inspectedFiles?.[0]
        || (typeof this.lastToolExecution?.result?.path === 'string' ? this.lastToolExecution.result.path : undefined)
        || (typeof this.lastToolExecution?.result?.filePath === 'string' ? this.lastToolExecution.result.filePath : undefined);

      let activeCallGraphContext: { symbol?: string; callers?: string[]; callees?: string[] } | undefined;
      const lastRes = this.lastToolExecution?.result;
      if (lastRes) {
        if (lastRes.symbol) {
          activeCallGraphContext = {
            symbol: lastRes.symbol,
            callers: Array.isArray(lastRes.callers) ? lastRes.callers.map((c: any) => typeof c === 'string' ? c : c.name || c.symbol).filter(Boolean) : undefined,
            callees: Array.isArray(lastRes.callees) ? lastRes.callees.map((c: any) => typeof c === 'string' ? c : c.name || c.symbol).filter(Boolean) : undefined,
          };
        } else if (lastRes.blastRadius?.modifiedSymbols?.length > 0) {
          activeCallGraphContext = {
            symbol: lastRes.blastRadius.modifiedSymbols[0],
            callers: Array.isArray(lastRes.blastRadius.directConsumers) ? lastRes.blastRadius.directConsumers : undefined,
          };
        }
      }
      if (!activeCallGraphContext) {
        const hypSymbol = (validatedHypotheses[0] as any)?.symbol || (supportedHypotheses[0] as any)?.symbol;
        if (hypSymbol) {
          activeCallGraphContext = { symbol: hypSymbol };
        }
      }

      const adviceInfo = this.toolAdvisor.advise({
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        hasErrors: this.lastToolExecution?.result?.error !== undefined,
        activeTaskTitle: activeTask?.title,
        hasSubmittedSolution,
        lastTargetFile: activeTargetFile,
        callGraphContext: activeCallGraphContext,
      });

      // Hiển thị Step Header kèm Workflow Pipeline breadcrumb
      if (!this._collapsePreferences.compactSteps) {
        CLI.renderStepHeader(step, effectiveMaxSteps, {
          phase: classification.phase,
          activeTask: activeTask?.title,
          playbook: adviceInfo.playbook,
          risk: classification.risk,
          isGoal,
        });
      }

      this.kernel?.ctx.events.emit('step:before', step, effectiveMaxSteps, classification.phase);
      this.verificationPolicy.setRequiredRisk(classification.risk);
      const recommendedToolDecision = this.thisTurnToolGate.decide(classification, this.toolProvider.getAll(), {
        workspaceDir: this._workspace.rootDir,
        userRequest: turnUserRequest,
      });
      const gateToolSurface = recommendedToolDecision.toolSurface;
      this.toolControlTelemetry.recordDecision(classification, recommendedToolDecision);
      const candidateProvider = toolControlMode === 'enforce'
        ? new ToolScope(`turn-${turn}-step-${step}-candidates`, this.toolProvider, gateToolSurface.authorizedToolNames)
        : this.toolProvider;
      const dynamicRetrievalEnabled = this.loopOptions?.enableDynamicToolRetrieval !== false
        && (toolControlMode === 'enforce' || candidateProvider.getAll().length >= 10);
      const providerSize = candidateProvider.getAll().length;
      const currentHypothesis = this.hypothesisTracker.getActiveHypothesis()
        || this.hypothesisTracker.getSupportedHypotheses().slice(-1)[0]
        || this.hypothesisTracker.getValidatedHypotheses().slice(-1)[0];
      const retrievalState = this.stepRetrievalQueryBuilder.build({
        userRequest: retrievalUserRequest,
        activeTask,
        phase: classification.phase,
        taskClass: classification.taskClass,
        hypothesis: currentHypothesis,
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        allowedToolNames: toolControlMode === 'enforce'
          ? gateToolSurface.authorizedToolNames
          : candidateProvider.getAll().map((tool) => tool.name),
      });
      const activeStepQuery = retrievalState.query;
      const stepCompletionState = getTurnCompletionState(session, turn);

      const canRequestPhaseTransition = ['explore', 'plan'].includes(classification.phase)
        && ['bugfix', 'feature', 'refactor', 'question', 'exploration'].includes(classification.taskClass);

      let activeToolDeclarations: any[];
      if (hasSubmittedSolution) {
        // Post-Submission Tool Stripping: Khi đã submit_solution thành công, tước bỏ toàn bộ tools để model chỉ sinh text thuần
        activeToolDeclarations = [];
      } else if (
        this.cachedTurnNumber === turn
        && this.cachedTurnToolDeclarations
        && this.cachedTurnToolProviderSize === providerSize
        && this.cachedTurnToolPhase === classification.phase
        && this.cachedTurnToolPhaseVersion === classification.phaseVersion
        && this.cachedHasPlan === this.planManager.hasPlan()
      ) {
        // KV Cache Preservation: Tái sử dụng 100% Tool Declarations cố định của phase trong turn này,
        // ngăn chặn việc re-retrieval sau mỗi tool call làm thay đổi thứ tự/danh sách tool prefix token.
        activeToolDeclarations = [...this.cachedTurnToolDeclarations];
      } else {
        activeToolDeclarations = (dynamicRetrievalEnabled && typeof candidateProvider.getRelevantTools === 'function')
          ? candidateProvider.getRelevantTools({
              query: retrievalState.query,
              denseQuery: retrievalState.denseQuery,
              lexicalQuery: retrievalState.lexicalQuery,
              lastToolName: this.lastToolExecution?.toolName,
              lastToolResult: this.lastToolExecution?.result,
              phase: classification.phase,
              codegraphIndexed: hasCodeGraphIndexSync(this._workspace.rootDir),
            })
          : candidateProvider.getFunctionDeclarations();

        // Strict Phase-Based Tool Masking (Claude Code Plan Mode Pattern - Mechanism 2):
        // In explore and plan phases, mutation tools are withheld from model-visible schemas so LLM physically cannot mutate
        // before requesting a phase transition to implement.
        if (toolControlMode !== 'off' && ['explore', 'plan'].includes(classification.phase)) {
          activeToolDeclarations = activeToolDeclarations.filter((tool: any) => !EDIT_TOOL_NAMES.has(tool.name));
        }

        // A transition request is a control primitive, not a retrieved task tool.
        // Keep it visible whenever the current coding phase can accept one so the
        // model never has to guess an unauthorized edit to advance its workflow.
        if (!canRequestPhaseTransition) {
          activeToolDeclarations = activeToolDeclarations.filter((tool: any) => tool.name !== 'request_phase_transition');
        } else if (
          candidateProvider.get('request_phase_transition')
          && !activeToolDeclarations.some((tool: any) => tool.name === 'request_phase_transition')
        ) {
          const transitionDeclaration = candidateProvider.getFunctionDeclarations()
            .find((tool: any) => tool.name === 'request_phase_transition');
          if (transitionDeclaration) activeToolDeclarations.push(transitionDeclaration);
        }

        if (this.planManager.hasPlan() && candidateProvider.get('update_plan_task')) {
          const hasUpdatePlan = activeToolDeclarations.some((tool: any) => tool.name === 'update_plan_task');
          if (!hasUpdatePlan) {
            const updatePlanDecl = candidateProvider.getFunctionDeclarations().find((d) => d.name === 'update_plan_task');
            if (updatePlanDecl) {
              activeToolDeclarations.push(updatePlanDecl);
            }
          }
          // One-way state transition: Once a plan exists, hide create_plan so the model
          // updates existing tasks with update_plan_task instead of overwriting the whole plan.
          activeToolDeclarations = activeToolDeclarations.filter((tool: any) => tool.name !== 'create_plan');
        }

        // Planning is opt-in, but once the user explicitly enters the plan
        // phase without an existing plan, create_plan must be model-visible and runtime-authorized. Pin
        // it after route filtering so declaration visibility and ToolScope stay
        // aligned instead of producing an authorization loop.
        if (classification.phase === 'plan' && !this.planManager.hasPlan() && candidateProvider.get('create_plan')
          && !activeToolDeclarations.some((tool: any) => tool.name === 'create_plan')) {
          const createPlanDeclaration = candidateProvider.getFunctionDeclarations()
            .find((tool: any) => tool.name === 'create_plan');
          if (createPlanDeclaration) activeToolDeclarations.push(createPlanDeclaration);
        }

        // Keep a small, phase-appropriate exploration set visible even when
        // relevance retrieval ranks it below task-specific tools.
        if (gateToolSurface.visibleToolNames.length > 0) {
          const declarationsByName = new Map(
            candidateProvider.getFunctionDeclarations().map((tool: any) => [tool.name, tool]),
          );
          for (const name of gateToolSurface.visibleToolNames) {
            const declaration = declarationsByName.get(name);
            if (declaration && !activeToolDeclarations.some((tool: any) => tool.name === name)) {
              activeToolDeclarations.push(declaration);
            }
          }
        }

        // Ensure no mutation tools leak through gateToolSurface during explore/plan phase
        if (toolControlMode !== 'off' && ['explore', 'plan'].includes(classification.phase)) {
          activeToolDeclarations = activeToolDeclarations.filter((tool: any) => !EDIT_TOOL_NAMES.has(tool.name));
        }

        // Tool-Level Circuit Breaker: Hide external tools that tripped rate limits or quota exhaustion in this turn
        if (this.circuitBreakerTrippedTools.size > 0) {
          activeToolDeclarations = activeToolDeclarations.filter(
            (tool: any) => !this.circuitBreakerTrippedTools.has(tool.name),
          );
        }

        // Canonical alphabetical sort: Đảm bảo thứ tự tool schemas luôn nhất quán tuyệt đối,
        // bảo tồn nguyên vẹn KV Cache prefix qua từng step.
        activeToolDeclarations.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));

        this.cachedTurnNumber = turn;
        this.cachedTurnToolDeclarations = [...activeToolDeclarations];
        this.cachedTurnToolProviderSize = providerSize;
        this.cachedTurnToolPhase = classification.phase;
        this.cachedTurnToolPhaseVersion = classification.phaseVersion;
        this.cachedHasPlan = this.planManager.hasPlan();
      }

      // Verification State tracking:
      const hasVerifiedTests = this.verificationPolicy.canComplete().allowed
        && stepCompletionState.hasMutations
        && !hasSubmittedSolution;

      const reliableToolOrchestrationMode = resolveReliableToolOrchestrationMode();
      const reliableRouteDecision = decideReliableToolRoute({
        userRequest: turnUserRequest,
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        visibleToolNames: activeToolDeclarations.map((tool: any) => String(tool.name)).filter(Boolean),
        trajectory: this.trajectorySteps,
        evidenceSufficient: this.isEvidenceSufficient(),
      });
      this.reliableToolOrchestrationTelemetry.recordDecision(reliableRouteDecision);
      this.kernel?.ctx.events.emit('router:decision', reliableRouteDecision);
      activeToolDeclarations = applyReliableToolRouteToDeclarations(
        activeToolDeclarations,
        reliableRouteDecision,
        reliableToolOrchestrationMode,
      );

      // Completion is a control primitive, not an optional relevance match.
      // Pin the same declaration on every pre-submission step (cache-stable),
      // including read-only investigation and plan phases.
      if (!hasSubmittedSolution && candidateProvider.get('submit_solution')
        && !activeToolDeclarations.some((tool: any) => tool.name === 'submit_solution')) {
        const declaration = candidateProvider.getFunctionDeclarations()
          .find((tool: any) => tool.name === 'submit_solution');
        if (declaration) activeToolDeclarations.push(declaration);
        activeToolDeclarations.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
      }

      const retrievedVisibleToolNames = activeToolDeclarations.map((tool: any) => String(tool.name)).filter(Boolean).sort();
      const expectedToolNames = gateToolSurface.authorizedToolNames.filter((name) => {
        if (hasSubmittedSolution) return false;
        return true;
      });
      this.contextQualityEvaluator.recordToolRetrieval(retrievedVisibleToolNames, expectedToolNames);
      // P1: runtime authorization uses the gate allowlist + control pins, not the
      // retrieval-pruned visible subset. Retrieval stays a soft relevance hint for
      // the model; hard denial only applies to tools the gate never authorized
      // (or to intentional hard locks below). This removes allowed-vs-visible
      // desync that previously wasted a model step on TOOL_NOT_ALLOWED_THIS_TURN.
      const reliableConstrainsScope = reliableToolOrchestrationMode === 'enforce'
        && reliableRouteDecision.constrainSafe
        && !reliableRouteDecision.failOpen;
      let runtimeAuthorizedToolNames: string[];
      if (hasSubmittedSolution) {
        runtimeAuthorizedToolNames = [];
      } else if (reliableConstrainsScope) {
        runtimeAuthorizedToolNames = [...retrievedVisibleToolNames];
      } else {
        const authorizedSet = new Set<string>(gateToolSurface.authorizedToolNames);
        for (const name of retrievedVisibleToolNames) authorizedSet.add(name);
        runtimeAuthorizedToolNames = [...authorizedSet].filter((name) => candidateProvider.get(name) !== undefined).sort();
        if (runtimeAuthorizedToolNames.length === 0) runtimeAuthorizedToolNames = [...retrievedVisibleToolNames];
      }
      const toolSurface = createToolSurface(runtimeAuthorizedToolNames, retrievedVisibleToolNames);
      const { authorizedToolNames: authorizedToolNames, visibleToolNames } = toolSurface;
      const activeToolSetHash = hashAllowedToolSet(authorizedToolNames);
      const activeDecisionId = `${recommendedToolDecision.id}-p${classification.phaseVersion}-${activeToolSetHash.slice(0, 8)}`;
      const hasRuntimeToolScope = toolControlMode === 'enforce'
        || reliableConstrainsScope;
      const stepToolProvider = hasRuntimeToolScope
        ? new ToolScope(`turn-${turn}-step-${step}-runtime`, candidateProvider, authorizedToolNames)
        : this.toolProvider;
      const stepToolRunner = hasRuntimeToolScope
        ? this.toolRunner.createScoped(stepToolProvider)
        : this.toolRunner;
      if (toolControlMode !== 'off') {
        session.append('control/decision', {
          turn,
          step,
          controlDecision: {
            mode: toolControlMode,
            classification,
            paretoEvidence,
            toolDecision: {
              ...recommendedToolDecision,
              toolSurface,
              id: activeDecisionId,
              phaseVersion: classification.phaseVersion,
              visibleToolNames,
              authorizedToolNames,
              allowedToolNames: authorizedToolNames,
              allowedToolSetHash: activeToolSetHash,
            },
          },
        });
      }
      if (reliableToolOrchestrationMode !== 'off') {
        session.append('control/decision', {
          turn,
          step,
          controlDecision: {
            kind: 'reliable-tool-orchestration',
            mode: reliableToolOrchestrationMode,
            route: reliableRouteDecision,
            visibleToolNames,
            metrics: this.reliableToolOrchestrationTelemetry.snapshot(),
          },
        });
      }

      const consecutiveFails = this.reflectionEngine.getConsecutiveFailures();
      const activeScaffold = this.cognitiveHarness.createScaffold({
        request: turnUserRequest,
        phase: classification.phase,
        activeTask: activeTask?.title,
        consecutiveFailures: consecutiveFails,
        hasAttachments: hasAttachmentAnchors,
        anchorPaths: attachmentAnchors,
      });
      const compactScaffoldPrompt = this.cognitiveHarness.formatScaffoldForCompactPrompt(activeScaffold);
      const legacyScaffoldPrompt = step === 1 || consecutiveFails > 1
        ? compactScaffoldPrompt
        : '';
      const legacyPlanContext = this.planManager.renderExecutionContext();
      const planRequirements = this.planManager.getRequirements();
      const stepPlanBlocker = this.planManager.getCompletionBlocker();
      const planBlocked = Boolean(stepPlanBlocker?.includes('graph-blocked'));
      const stepPlanContext = this.planManager.renderStepPromptContext({
        phase: classification.phase,
        includeFull: classification.phase === 'plan'
          || planBlocked
          || this.planManager.getReadyTasks().length > 1,
      });
      const candidateAdvicePrompt = this.toolAdvisor.formatAdvicePrompt({
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        hasErrors: this.lastToolExecution?.result?.error !== undefined,
        activeTaskTitle: activeTask?.title,
        activeTaskAcceptance: activeTask?.acceptanceCriteria,
        guardianDiagnosis: this.lastToolExecution?.guardianDiagnosis,
        userRequest: turnUserRequest,
        hasSubmittedSolution,
        trajectory: this.trajectorySteps,
        evidenceSufficient: this.isEvidenceSufficient(),
        repairCyclesExhausted: this.verificationPolicy.isRepairExhausted(),
        lastTargetFile: activeTargetFile,
        callGraphContext: activeCallGraphContext,
      });
      const harnessProfile = resolveRuntimeHarnessProfile(classification.taskClass, classification.phase);
      const stepPromptMode = resolveStepPromptGatingMode(this.loopOptions?.stepPromptGatingMode);
      const promptDecision = this.stepPromptPolicy.decide({
        activeStepQuery,
        fingerprint: retrievalState.fingerprint,
        failureSignature: this.lastToolExecution && isToolResultFailure(this.lastToolExecution.result || {})
          ? `${this.lastToolExecution.toolName}:failed`
          : undefined,
        classification,
        previousPhase: priorClassification?.phase,
        activeTask,
        hasPlan: this.planManager.hasPlan(),
        planRequired: planRequirements.required,
        planIncomplete: this.planManager.hasPlan() && !this.planManager.isAllTasksCompleted(),
        planBlocked,
        readyTaskCount: this.planManager.getReadyTasks().length,
        visibleToolNames,
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        consecutiveFailures: consecutiveFails,
        hasValidatedHypothesis,
        paretoEvidenceSufficient: paretoEvidence.hasSufficientEvidence,
        paretoUncertainty: paretoEvidence.uncertainty,
        hasSubmittedSolution,
        hasVerifiedTests,
        activeAgentCount: this.agentRegistry.list().filter((agent) => (
          agent.id !== this.agentId && ['running', 'waiting'].includes(agent.status)
        )).length,
        hasAttachments: hasAttachmentAnchors,
        harnessProfileName: harnessProfile.profileName,
        cascadeFrozen: this.cascadeFreeze !== undefined,
        cascadeReason: this.cascadeFreeze
          ? `${this.cascadeFreeze.count} consecutive failures share one error signature: ${this.cascadeFreeze.signature.slice(0, 200)}`
          : undefined,
        evidenceScore: paretoEvidence.score,
        evidenceThreshold: paretoEvidence.threshold,
        evidenceReasons: paretoEvidence.reasons,
        reproductionEnforced: this.completionEvidenceGate.hasPostFixReproductionPass(session, turn) === false
          && classification.taskClass === 'bugfix'
          && (process.env.MINUS_REPRODUCTION_GATE?.trim().toLowerCase() === 'enforce'
            || configuredEvidenceGateMode() === 'enforce'),
        hasPostFixPass: this.completionEvidenceGate.hasPostFixReproductionPass(session, turn),
        candidates: {
          legacyPlanContext,
          stepPlanContext,
          advicePrompt: candidateAdvicePrompt,
          advicePlaybook: adviceInfo.playbook,
          harnessGuidance: harnessProfile.guidance,
          scaffoldPrompt: compactScaffoldPrompt,
          legacyScaffoldPrompt,
        },
      }, stepPromptMode);
      session.append('control/decision', {
        turn,
        step,
        controlDecision: {
          stepPromptDecision: {
            requestedMode: promptDecision.requestedMode,
            effectiveMode: promptDecision.effectiveMode,
            conservativeFallback: promptDecision.conservativeFallback,
            reasonCodes: promptDecision.reasonCodes,
            selectedPlaybooks: promptDecision.selectedPlaybooks,
            selectedGitPlaybook: promptDecision.selectedGitPlaybook,
            fingerprint: retrievalState.fingerprint,
            estimatedTokensBefore: promptDecision.estimatedTokensBefore,
            estimatedTokensAfter: promptDecision.estimatedTokensAfter,
            estimatedTokensSaved: promptDecision.estimatedTokensSaved,
            injectedEstimatedTokens: promptDecision.injectedEstimatedTokens,
          },
        },
      });
      if (promptDecision.scaffoldPrompt && !this._collapsePreferences.compactSteps) {
        CLI.renderCognitiveScaffold(this.cognitiveHarness.formatScaffoldForUI(activeScaffold));
      }

      let response;
      // Keep the static prefix cacheable. Enforced step playbooks are selected below and
      // placed in the budgeted dynamic suffix; off/shadow retain the legacy section.
      const promptAssemblyCtx = {
        ...detectPromptContext(this._workspace, this.toolProvider, turnUserRequest),
        includeStaticToolPlaybooks: promptDecision.includeStaticToolPlaybooks,
      };
      const assembledSystemPrompt = this.promptAssembler.assembleForContext(promptAssemblyCtx);
      const rawPlanContext = promptDecision.planContext;
      const advicePrompt = promptDecision.advicePrompt;
      const cognitiveScaffoldText = promptDecision.scaffoldPrompt;
      // Intent-Gated Memory Retrieval:
      // Tự động phân bổ ngân sách token dựa theo phân loại tác vụ (Classification Phase & Complexity):
      // - Phase 'implement' / 'verify' hoặc complexity 'trivial' / 'small' -> Tác vụ cục bộ:
      //   + Tắt Graph Repository Map (tiết kiệm 1.600 tokens)
      //   + Thu nhỏ ngân sách Repository Memory xuống ~300 tokens
      //   + Giảm số lượng relevantMemory xuống tối đa 2
      // - Phase 'explore' / 'plan' hoặc complexity 'large' -> Tác vụ bao quát: Nạp đầy đủ ngân sách
      const isLocalizedExecution = classification.phase === 'implement'
        || classification.phase === 'verify'
        || classification.phase === 'release'
        || classification.complexity === 'trivial'
        || classification.complexity === 'small'
        || classification.fastPath;

      const configuredRepoMemTokens = this.loopOptions?.repositoryMemoryTokens ?? 1_000;
      const configuredRepoMapTokens = this.loopOptions?.repositoryMapTokens ?? 1_600;

      const explicitRepoMap = this.loopOptions?.enableGraphRepositoryMap === true;
      const explicitRepoMem = this.loopOptions?.enableRepositoryMemory === true;

      // Step 1 Adaptive Footprint:
      // Tại step 1 của turn, agent chưa khoanh vùng được file/symbol mục tiêu.
      // Dù tác vụ non-localized, việc bung toàn bộ 1.600 tokens Graph Map hoặc 1.000 tokens Repo Mem là quá sớm và gây nghẽn ngân sách.
      // Cấp soft footprint: Graph Map tối đa 400 tokens, Repo Mem tối đa 300 tokens ở Step 1.
      // Khi step >= 2 hoặc khi chuyển sang phase 'plan' (cần DAG đa file), bung đầy đủ ngân sách cấu hình.
      const isStepOneExploration = step === 1 && classification.phase === 'explore';

      const effectiveRepoMemTokens = (isLocalizedExecution && !explicitRepoMem)
        ? Math.min(300, configuredRepoMemTokens)
        : (isStepOneExploration && !explicitRepoMem)
          ? Math.min(300, configuredRepoMemTokens)
          : configuredRepoMemTokens;
      const effectiveRepoMapTokens = (isLocalizedExecution && !explicitRepoMap)
        ? 0
        : (isStepOneExploration && !explicitRepoMap)
          ? Math.min(400, configuredRepoMapTokens)
          : configuredRepoMapTokens;

      const mockModel = Boolean(this.llm?.constructor?.name?.includes('Mock') || process.env.NODE_ENV === 'test');
      const shouldRecallRepoMem = explicitRepoMem
        ? (effectiveRepoMemTokens > 0)
        : (this.loopOptions?.enableRepositoryMemory !== false && effectiveRepoMemTokens > 0);
      const shouldRenderRepoMap = explicitRepoMap
        ? (effectiveRepoMapTokens > 0)
        : (this.loopOptions?.enableGraphRepositoryMap !== false && !mockModel && effectiveRepoMapTokens > 0);

      const memoryLimit = isLocalizedExecution ? 2 : 4;
      const relevantMemory = this.memoryManager.getRelevantMemory(activeStepQuery, session, memoryLimit);
      const memoryPrompt = relevantMemory.length > 0
        ? [
          '[VERIFIED RELEVANT PROJECT MEMORY]',
          ...relevantMemory.map((item) => `- [${item.key}; confidence=${item.confidence.toFixed(2)}] ${item.insight}`),
        ].join('\n')
        : '';
      const composeContext = this.kernel?.ctx.compose.renderExecutionContext() || '';
      const composeState = this.kernel?.ctx.compose.getState();
      let repositoryMemoryContext = '';
      let repositoryMemoryRecords: Awaited<ReturnType<CitationValidatedRepositoryMemory['recall']>>['records'] = [];
      let repositoryContext = '';
      const dynamicCacheEnabled = this.loopOptions?.enableDynamicContextCache
        ?? envFeatureEnabled('MINUS_DYNAMIC_CONTEXT_CACHE');
      const dynamicCacheKey = JSON.stringify({
        workspace: this._workspace.rootDir,
        // Source acquisition is stable across read-only steps. Query-specific
        // ranking remains in the lightweight arbitration/retrieval layer.
        taskIntent: turnUserRequest,
        activeTask: activeTask ? {
          id: activeTask.id,
          writeSet: activeTask.writeSet,
          symbols: activeTask.symbols,
        } : undefined,
        registeredFiles: composeState?.registeredFiles || [],
        repositoryMemoryEnabled: shouldRecallRepoMem,
        repositoryMemoryTokens: effectiveRepoMemTokens,
        repositoryMapEnabled: shouldRenderRepoMap,
        repositoryMapTokens: effectiveRepoMapTokens,
      });
      const cachedDynamicContext = dynamicCacheEnabled
        ? this.dynamicContextCache.get(dynamicCacheKey)
        : undefined;
      if (cachedDynamicContext) {
        repositoryMemoryContext = cachedDynamicContext.repositoryMemoryContext;
        repositoryMemoryRecords = cachedDynamicContext.repositoryMemoryRecords;
        repositoryContext = cachedDynamicContext.repositoryContext;
      } else {
        // Tối ưu hóa Latency: Thực thi song song Repository Memory Recall và Repository Map Render
        const repoMemPromise = shouldRecallRepoMem
          ? this.repositoryMemory.recall(activeStepQuery, {
              limit: isLocalizedExecution && !explicitRepoMem ? 4 : 12,
              maxTokens: effectiveRepoMemTokens,
            }).catch(() => ({ rendered: '', records: [] }))
          : Promise.resolve({ rendered: '', records: [] });

        const baseRepoQuery = [
          activeStepQuery,
          ...relevantMemory.map((item) => item.insight),
        ].filter(Boolean).join('\n');

        const baseSeedFiles = [
          ...(activeTask?.readSet || []),
          ...(activeTask?.writeSet || []),
          ...(currentHypothesis?.targetFiles || []),
          ...retrievalState.discoveredFiles,
          ...(composeState?.registeredFiles || []),
          // @-attached anchors steer the graph map toward the attachment neighborhood.
          ...attachmentAnchors,
        ];

        const baseSeedSymbols = [
          ...(activeTask?.symbols || []),
          ...retrievalState.discoveredSymbols,
        ];

        const repoMapPromise = shouldRenderRepoMap
          ? this.repositoryMap.renderContext(baseRepoQuery, {
              maxTokens: effectiveRepoMapTokens,
              seedFiles: baseSeedFiles,
              seedSymbols: baseSeedSymbols,
            }).catch((error: any) => `[GRAPH-RANKED REPOSITORY MAP DEGRADED]\n${error?.message || String(error)}`)
          : Promise.resolve('');

        const [recalled, renderedMap] = await Promise.all([repoMemPromise, repoMapPromise]);

        repositoryMemoryContext = recalled.rendered;
        repositoryMemoryRecords = recalled.records;
        repositoryContext = renderedMap;

        if (dynamicCacheEnabled) {
          this.dynamicContextCache.set(dynamicCacheKey, {
            repositoryMemoryContext,
            repositoryMemoryRecords,
            repositoryContext,
          });
        }
      }
      // Selective Re-injection: Truy hồi các turn cũ, observation đã bị mask hoặc anti-pattern nếu có độ tương đồng cao với query bước hiện tại
      let recalledTurnContext = '';
      if (
        this.turnMemoryRetriever.getArchivedTurnCount() > 0 ||
        this.turnMemoryRetriever.getMaskedObservationCount() > 0 ||
        this.turnMemoryRetriever.getAntiPatternCount() > 0 ||
        this.turnMemoryRetriever.getLivingPlaybook().getBulletCount() > 0
      ) {
        try {
          recalledTurnContext = await this.turnMemoryRetriever.retrieveContextSnippet(activeStepQuery, {
            topK: 2,
            minScore: 0.65,
            activeFiles: [
              ...(activeTask?.readSet || []),
              ...(activeTask?.writeSet || []),
              ...(currentHypothesis?.targetFiles || []),
              ...retrievalState.discoveredFiles,
            ],
          });
        } catch {
          // Fail-open
        }
      }
      const activeTokenConfig = typeof this.llm.getTokenConfig === 'function'
        ? (this.llm.getTokenConfig() || {})
        : {};
      const activeModelName = this.llm?.getActiveProvider?.()?.name
        || this.llm?.modelName
        || this.llm?.constructor?.name
        || 'unknown';

      // Tier 2: Dynamic Phase Guidance (Pareto 80/20 & Cache-Safe Dynamic Tail Injection)
      const phaseGuidance = resolvePhaseDynamicGuidance(classification.phase, {
        taskClass: classification.taskClass,
        risk: classification.risk,
        reversibility: classification.reversibility,
        hasValidatedHypothesis,
        hasSupportedHypothesis: supportedHypothesisCount > 0,
        evidenceSufficient: paretoEvidence.hasSufficientEvidence,
        evidenceScore: paretoEvidence.score,
        evidenceThreshold: paretoEvidence.threshold,
        targetFile: activeTargetFile,
      });

      // Phase 3/4: Cognitive Task Scaffolding, Dynamic Reflection & Strategic Pivot (Layer 2 & 1)
      const phaseTransitionRecovery = this.lastToolExecution?.toolName === 'request_phase_transition'
        ? this.lastToolExecution.result?._system_phase_transition_recovery
        : undefined;
      // P2: surface the cheap authorization-denial recovery on the next step
      // without counting it as a consecutive failure.
      const authorizationRecovery = this.lastToolExecution?.result?._system_tool_authorization_recovery;
      const rawReflection = [
        phaseTransitionRecovery,
        authorizationRecovery,
        this.reflectionEngine.getLastReflectionPrompt(),
      ].filter(Boolean).join('\n\n');
      let strategicPivotGuidance: string | undefined;
      if (consecutiveFails >= 2) {
        strategicPivotGuidance = `🛑 [STRATEGIC PIVOT DIRECTIVE]: ${consecutiveFails} consecutive failures provide feedback that the current approach is weak. Do not repeat the same action. Inspect the newest failure, compare it with the current hypothesis, run the smallest discriminating check, then revise or replace the hypothesis before another mutation.`;
      }
      if (consecutiveFails >= 3) {
        // Tự động đúc kết lỗi lặp lại thành Anti-Pattern lưu vào bộ nhớ dài hạn
        this.turnMemoryRetriever.recordAntiPattern({
          id: `ap-${turn}-${step}`,
          triggerPattern: turnUserRequest.slice(0, 80),
          failedApproach: `Consecutive failures (${consecutiveFails}) in phase ${classification.phase} while handling: ${turnUserRequest.slice(0, 60)}`,
          negativeConstraint: 'Avoid repeated unverified edits; verify each hypothesis with isolated test reproduction first.',
          taskClass: classification.taskClass,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
      const snapshotNudge = this.pendingSnapshotNudge;
      this.pendingSnapshotNudge = undefined;
      const reflectionContext = [rawReflection, strategicPivotGuidance, snapshotNudge].filter(Boolean).join('\n\n');

      // Phase 4: Auto-Convergence Directive when all verification tests passed
      let completionDirective: string | undefined;
      if (hasVerifiedTests) {
        completionDirective = `🎯 [VERIFICATION SUCCESSFUL]: All unit test checks passed with Exit Code 0. Code modifications are empirically verified. Do NOT make any more code changes. Call "submit_solution" immediately to conclude the task.`;
      } else if (isReadOnlyAnswerTask && !stepCompletionState.hasMutations && !hasSubmittedSolution) {
        completionDirective = '[STRONG ADVISORY — READ-ONLY SUBMIT]: When the answer is ready, call submit_solution as the final tool with the actual user-facing answer in summary, resolutionType="investigation_only", filesModified=[], and verificationMethod="not_applicable" unless actual verification occurred. No code edit or test is required. report_investigation_findings and plain text do not replace submission. After successful submission, call no further tools; return the submitted answer in the user\'s language.';
      }

      // Epistemic Investigation Engine: Dual Thesis vs Antithesis + Lightweight Speculative Rollout
      // Gated to prevent context dilution and latency/accuracy degradation
      const activeHypothesis = this.hypothesisTracker.getActiveHypothesis();
      const baselineRisk: BlastRadiusRisk =
        (classification.risk === 'R5' || classification.risk === 'R4') ? 'CRITICAL' :
        classification.risk === 'R3' ? 'HIGH' :
        classification.risk === 'R2' ? 'MEDIUM' : 'LOW';
      const effectiveEpistemicRisk: BlastRadiusRisk = activeHypothesis?.blastRadius
        || (consecutiveFails >= 2 ? (baselineRisk === 'CRITICAL' ? 'CRITICAL' : 'HIGH') : baselineRisk);

      const isInvestigativeExplore = (classification.phase === 'explore' || (classification.phase as string) === 'investigate') && (
        detectAnalysisOrInvestigationIntent(turnUserRequest).isAnalysisQuery
        || detectLeadingQuery(turnUserRequest).isLeading
        || classification.reasonCodes.includes('SYMBOL_TOPOLOGY_EXPLORATION_REQUIRED')
      );

      const epistemicResult = this.epistemicEngine.investigate({
        hypothesis: activeHypothesis,
        phase: classification.phase === 'release' ? 'verify' : classification.phase,
        risk: effectiveEpistemicRisk,
        consecutiveFailures: consecutiveFails,
        recentError: rawReflection || undefined,
        targetFiles: activeHypothesis?.targetFiles,
        proposedFixSummary: activeHypothesis?.proposedFix,
        workspaceRoot: this._workspace.rootDir,
        skepticalCriticActive: isInvestigativeExplore,
      });

      if (epistemicResult.activated) {
        if (epistemicResult.dialecticalVerdict) {
          this.hypothesisTracker.attachEpistemicVerdict(
            activeHypothesis?.id,
            epistemicResult.dialecticalVerdict,
            epistemicResult.speculativeRollout,
          );
        }
        if (process.env.MINUS_SHOW_EPISTEMIC === 'true' || process.env.MINUS_SHOW_EPISTEMIC === '1') {
          CLI.renderEpistemicProgress({
            hypothesisId: activeHypothesis?.id,
            targetFiles: activeHypothesis?.targetFiles,
            dialecticalVerdict: epistemicResult.dialecticalVerdict,
            speculativeRollout: epistemicResult.speculativeRollout,
            distilledTokens: epistemicResult.dialecticalVerdict?.distilledTokens,
          });
        }
      }
      const epistemicVerdictContext = epistemicResult.activated ? epistemicResult.distilledContext : undefined;

      const hypothesisContext = this.hypothesisTracker.toScratchpad();
      const hypothesisGuidance = this.hypothesisTracker.toPromptGuidance();
      const domainContractContext = this.domainIntentGuardian.formatContractForPromptContext();
      // Retain the handoff across subsequent steps: a boundary compaction can mask
      // the underlying observations in model history, while the phase event remains durable.
      const phaseHandoff = buildPhaseContextHandoff(
        session,
        turn,
        classification.phase,
        this.hypothesisTracker.getLatestHypothesis(),
        this.verificationPolicy.getPendingTargetedTests(),
      );
      const phaseJustChanged = exploreCompletedNow
        || Boolean(priorClassification && priorClassification.phase !== classification.phase);

      // Khử trùng lặp chéo giữa history[0] (Warm-Start) và Dynamic Tail ở Step 1:
      const historyZeroText = session.getHistory()[0]?.parts?.[0]?.text || '';
      const historyHasWarmScaffold = historyZeroText.includes('[COGNITIVE SCAFFOLD ACTIVE');
      const historyHasWarmMemory = historyZeroText.includes('[SESSION / GOAL MEMORY');

      // 1. Khử trùng lặp Cognitive Scaffold: Nếu history[0] đã chứa khung System 2 từ Warm-Start
      // và không có lỗi liên tiếp (consecutiveFails < 2), thì tại Step 1 không nạp lại ở đuôi dynamic context.
      const effectiveScaffoldText = (step === 1 && historyHasWarmScaffold && consecutiveFails < 2)
        ? undefined
        : cognitiveScaffoldText;

      // 2. Khử trùng lặp Project Memory: Nếu history[0] đã chứa [SESSION / GOAL MEMORY],
      // thì tại Step 1 các mục memory insight đã được nạp ở đầu tin nhắn.
      const effectiveMemoryPrompt = (step === 1 && historyHasWarmMemory)
        ? ''
        : memoryPrompt;

      // 3. Step 1 Tool Advice Gating: Khi chưa có tool nào chạy và người dùng không báo lỗi,
      // lời khuyên discovery chỉ lặp lại Core System Prompt và Phase Explore Guidance. Bỏ qua ở Step 1.
      const hasInitialBugIntent = !this.lastToolExecution?.toolName && detectBugReportIntent(turnUserRequest);
      const effectiveAdvicePrompt = (step === 1 && !this.lastToolExecution?.toolName && !hasInitialBugIntent)
        ? undefined
        : advicePrompt;

      // Khối prompt khuyến khích LLM chạy lệnh test thông qua run_command trong các trường hợp cần thiết
      // (khi LLM gọi các công cụ Edit chỉ 1 đến 2 lần thì không truyền khối prompt này)
      let testVerificationEncouragement: string | undefined;
      if (this.editToolCallsInTurn > 2 && !hasVerifiedTests && this.targetFilesModifiedInTurn.size > 0) {
        if (classification.risk === 'R1') {
          testVerificationEncouragement = `💡 [VERIFICATION RECOMMENDED]: You have made ${this.editToolCallsInTurn} source-code edits. For localized R1 changes, run \`get_diagnostics\` to empirically verify type/syntax cleanliness before finishing the task or calling "submit_solution".`;
        } else {
          const [detectedCmd, detectedBuildCmd, detectedIntegrationCmd] = await Promise.all([
            detectWorkspaceTestCommand(this._workspace.rootDir),
            detectWorkspaceBuildCommand(this._workspace.rootDir),
            detectWorkspaceIntegrationTestCommand(this._workspace.rootDir),
          ]);
          const cmdHint = detectedCmd ? ` (e.g.: \`${detectedCmd}\`)` : '';
          const buildHint = detectedBuildCmd ? ` (e.g.: \`${detectedBuildCmd}\`)` : '';
          const touchesIntegration = touchesIntegrationLayer(this.targetFilesModifiedInTurn);

          let integrationGuidance = '';
          if (detectedIntegrationCmd) {
            integrationGuidance = `\n🔗 [INTEGRATION TEST RECOMMENDED]: Workspace contains an integration/E2E test suite (\`${detectedIntegrationCmd}\`). Since your changes touch multi-component or integration layers, run this command via "run_command" to empirically verify cross-service/module integrity before calling "submit_solution".`;
          } else if (touchesIntegration) {
            integrationGuidance = `\n🔗 [INTEGRATION VERIFICATION RECOMMENDED]: Your modifications touch integration components (API/routes/database/server/service). Please perform an integration-level verification: run an end-to-end verification script, or start the service in background via "run_command" (with WaitMsBeforeAsync=5000) and probe endpoints (using curl or a test probe) to prove integration correctness before calling "submit_solution".`;
          }

          testVerificationEncouragement = `💡 [VERIFICATION LADDER RECOMMENDED]: You have made ${this.editToolCallsInTurn} source-code edits. Per the Verification Ladder: if the project has a project-specific build command (not "npm run build" or "tsc"), check \`package.json\` (scripts section) or run \`get_diagnostics\` before running the full test suite. You are encouraged to run static type-checking/build${buildHint} or the project's tests via the "run_command" tool${cmdHint} to empirically verify the changes and ensure no regressions before finishing the task or calling "submit_solution".${integrationGuidance}`;
        }
      }

      // Every model-visible dynamic block enters one arbiter. A preliminary pass
      // provides the footprint used by latency guidance; the final pass includes it.
      const dynamicBudgetTokens = isLocalizedExecution ? 1200 : 1600;
      // P0: phase/tool authority directive rides inside the non-truncatable P1.5
      // phaseGuidance slot so the model always sees the exact authorized list.
      const phaseToolDirective = buildPhaseToolAuthorityDirective(classification.phase, visibleToolNames, {
        canRequestPhaseTransition,
        hasSubmittedSolution,
        isReadOnly: classification.risk === 'R0' || classification.reversibility === 'read-only',
      });
      const effectivePhaseGuidance = [phaseGuidance, phaseToolDirective].filter(Boolean).join('\n');
      let paretoGateReminder: string | undefined;
      if (['bugfix', 'refactor', 'security'].includes(classification.taskClass)) {
        const inTransitionPhase = ['explore', 'plan'].includes(classification.phase);
        const transitionNotice = inTransitionPhase
          ? ' In explore/plan, request_phase_transition before editing and wait for the next model response.'
          : '';
        if (classification.risk === 'R1') {
          paretoGateReminder = `[PRE-MUTATION GATE]: Turn evidence ${paretoEvidence.score}/${paretoEvidence.threshold}; inspect target with read_file before editing.${transitionNotice}`;
        } else if (classification.risk === 'R2') {
          paretoGateReminder = `[PRE-MUTATION GATE]: Turn evidence ${paretoEvidence.score}/${paretoEvidence.threshold}; inspect target with read_file and run diagnostics before editing.${transitionNotice}`;
        } else {
          paretoGateReminder = `[PRE-MUTATION GATE]: Turn evidence ${paretoEvidence.score}/${paretoEvidence.threshold}; inspect each exact target (including every file in apply_patch).${transitionNotice} R3 bugfix/security need observed reproduction; a planned R3 refactor may proceed after target inspection.`;
        }
      }
      let warmStartTopoMap: string | undefined;
      if (step === 1 && !this._collapsePreferences.compactSteps) {
        try {
          const topoResult = await generateWarmStartTopology({
            workspaceRootDir: this._workspace.rootDir,
            userPrompt: turnUserRequest,
            maxFiles: 4,
            maxTokens: 220,
          });
          if (topoResult.rendered) {
            warmStartTopoMap = topoResult.rendered;
          }
        } catch {
          // Graceful fallback
        }
      }

      const arbitrationInputs = {
        instructionHierarchyAnchor: SECTION_INSTRUCTION_HIERARCHY_SUFFIX_ANCHOR,
        responseLanguageDirective: '[RESPONSE LANGUAGE]: Respond to the user in the same natural language as their current request. This applies to every user-facing explanation and the final answer. Do not let the language of system instructions, tool output, source code, or prior assistant messages override the current user request. Keep code, commands, paths, identifiers, and quoted external text unchanged unless translation is explicitly requested.',
        completionDirective,
        advicePrompt: effectiveAdvicePrompt,
        testVerificationEncouragement,
        reflectionContext,
        strongAdvisory: promptDecision.strongAdvisoryPrompt,
        cognitiveScaffold: effectiveScaffoldText,
        warmStartTopoMap,
        toolPlaybooks: promptDecision.toolPlaybookPrompt,
        gitPlaybook: promptDecision.gitPlaybookPrompt,
        harnessGuidance: [
          promptDecision.harnessGuidance,
          classification.reasonCodes.includes('SYMBOL_TOPOLOGY_EXPLORATION_REQUIRED')
            ? '💡 [GITNEXUS TOPOLOGY GUIDANCE]: The user query explores specific symbols. Use GitNexus tools (context({name: "symbolName"}), query) or inspect_symbol to inspect 360-degree callers and callees before concluding, avoiding single-file confirmation bias.'
            : undefined,
        ].filter(Boolean).join('\n'),
        epistemicVerdictContext,
        hypothesisContext,
        hypothesisGuidance,
        domainContractContext,
        paretoGateReminder,
        phaseGuidance: effectivePhaseGuidance,
        phaseHandoff: phaseHandoff?.text,
        rawPlanContext,
        recalledTurnContext,
        memoryPrompt: effectiveMemoryPrompt,
        composeContext,
        repositoryMemoryContext,
        repositoryContext,
      };
      const arbitrationOptions = {
        maxBudgetTokens: dynamicBudgetTokens,
        modelName: activeModelName,
        consecutiveFailures: consecutiveFails,
        retrievalQuery: activeStepQuery,
        existingHistoryContext: historyZeroText,
        risk: classification.risk,
        minRepoMapFloorTokens: (classification.risk === 'R3' || classification.taskClass === 'refactor') ? 350 : undefined,
      };
      // Single-pass arbitration (KV-cache stable): arbitrate once without latency
      // guidance, reserving headroom for it when it will certainly be appended
      // (step > 1). The guidance is appended verbatim instead of re-arbitrating
      // the whole context, so the dynamic prefix stays byte-identical and the
      // second full arbitrate (dedup + recounts) is skipped.
      const LATENCY_GUIDANCE_RESERVE_TOKENS = 150;
      const latencyGuidanceReserved = step > 1;
      const baseArbitration = this.dynamicContextArbiter.arbitrate(
        arbitrationInputs,
        latencyGuidanceReserved
          ? { ...arbitrationOptions, maxBudgetTokens: Math.max(300, dynamicBudgetTokens - LATENCY_GUIDANCE_RESERVE_TOKENS) }
          : arbitrationOptions,
      );
      // One history projection per step: getHistory() rebuilds + clones the full
      // event log, so capture once and reuse for footprint + budget input.
      // No session appends affecting the projection happen before the request.
      const preCompactionHistory = session.getHistory();
      const latencyProfile = this.latencyOrchestrator.getModelProfile(activeModelName, activeTokenConfig);
      const preliminaryFootprint = this.latencyOrchestrator.estimateRequest({
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: preCompactionHistory,
        dynamicContext: baseArbitration.renderedContext,
        maxInputTokens: activeTokenConfig.maxInputTokens,
        maxOutputTokens: activeTokenConfig.maxOutputTokens,
      });
      const shouldIncludeLatencyGuidance = step > 1
        || preliminaryFootprint.estimatedInputTokens > (activeTokenConfig.maxInputTokens || 128000) * 0.7;
      const latencyGuidance = shouldIncludeLatencyGuidance
        ? this.latencyOrchestrator.buildGuidance({
            step,
            footprint: preliminaryFootprint,
            modelName: activeModelName,
            tokenConfig: activeTokenConfig,
            phase: classification.phase,
            verificationReady: this.verificationPolicy.canComplete().allowed
              && (!this.planManager.hasPlan() || this.planManager.isAllTasksCompleted()),
          })
        : undefined;
      let arbitration = baseArbitration;
      let dynamicExecutionContext = baseArbitration.renderedContext;
      if (latencyGuidance) {
        if (!latencyGuidanceReserved) {
          // Rare path (step 1 under high pressure, no reserve): fall back to a
          // second budgeted pass so the guidance still fits without overflow.
          const finalArbitrationInputs = { ...arbitrationInputs, latencyGuidance };
          arbitration = this.dynamicContextArbiter.arbitrate(finalArbitrationInputs, arbitrationOptions);
          dynamicExecutionContext = arbitration.renderedContext;
        } else {
          dynamicExecutionContext = baseArbitration.renderedContext
            ? `${baseArbitration.renderedContext}\n\n${latencyGuidance}`
            : latencyGuidance;
          const guidanceTokens = ExactTokenizer.countTokens(latencyGuidance, activeModelName);
          arbitration = {
            ...baseArbitration,
            renderedContext: dynamicExecutionContext,
            totalTokens: baseArbitration.totalTokens + guidanceTokens,
            sourcesIncluded: [...baseArbitration.sourcesIncluded, 'Latency Guidance (P1.49)'],
            stats: {
              ...baseArbitration.stats,
              afterTokens: baseArbitration.stats.afterTokens + guidanceTokens,
            },
          };
        }
      }
      this.contextQualityEvaluator.recordContextArbitration({
        sourceCount: Object.values({ ...arbitrationInputs, latencyGuidance }).filter((value) => typeof value === 'string' && value.trim().length > 0).length,
        retainedSourceCount: arbitration.sourcesIncluded.length,
        beforeTokens: arbitration.stats.beforeTokens,
        afterTokens: arbitration.stats.afterTokens,
      });
      // The pre-compaction projection captured above is reused for footprint +
      // budget input, so the pre-compaction digest below describes exactly
      // what compaction consumed.
      let requestFootprint = this.latencyOrchestrator.estimateRequest({
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: preCompactionHistory,
        dynamicContext: dynamicExecutionContext,
        maxInputTokens: activeTokenConfig.maxInputTokens,
        maxOutputTokens: activeTokenConfig.maxOutputTokens,
      });

      // Budget the complete serialized request once all dynamic inputs are known.
      const previousCompactionState = session.findLatestEventOfType(
        'session/compaction',
        (event) => Boolean(event.data.compactionState),
      )?.data.compactionState as CompactionStateV1 | undefined;
      const requestEnvelope: ModelRequestEnvelope = {
        provider: this.llm?.constructor?.name || 'unknown',
        model: activeModelName,
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: preCompactionHistory,
        dynamicContext: dynamicExecutionContext,
        maxInputTokens: Math.max(1, activeTokenConfig.maxInputTokens || maxBudget),
        targetInputTokens: workingHistoryBudget,
        outputReserveTokens: Math.max(0, activeTokenConfig.maxOutputTokens || 0),
      };
      const { history: _requestHistory, ...requestMetadata } = requestEnvelope;
      this.lastRequestEnvelope = { sessionId: session.id, envelope: requestMetadata };
      const contextPreparation = await this.contextBudgetManager.prepareRequest(requestEnvelope, {
        mutatedFiles: Array.from(this.targetFilesModifiedInTurn),
        cognitivePhase: classification.phase === 'release' ? 'verify' : classification.phase,
        enableObservationMasking: true,
        protectActiveTurn: true,
        replacedObservationIds: selectReplacedObservationIds(preCompactionHistory),
        protectedMessages: session.getProjectionWithTurns()
          .filter((entry) => entry.turn === turn).map((entry) => entry.message),
        protectedPaths: [
          ...(this.planManager.getActiveTask()?.readSet || []),
          ...(this.planManager.getActiveTask()?.writeSet || []),
          ...this.targetFilesModifiedInTurn,
        ],
        previousState: previousCompactionState,
        onCompactionStart: () => CLI.startCompaction('step'),
        ...(phaseJustChanged && phaseHandoff && arbitration.sourcesIncluded.includes('Phase Handoff (P1.5)')
          ? { phaseTransition: {} }
          : {}),
      });
      const compactionStats = contextPreparation.compactionStats;
      if (!contextPreparation.changed) CLI.finishCompaction(contextPreparation.failureReason ? 'failed' : 'skipped');
      const observationsToArchive = [
        ...(contextPreparation.checkpointObservations || []),
        ...(compactionStats?.maskedObservations || []),
      ];
      // Archive + guardian persistence (KV-cache safe). The synchronous
      // extraction prefix inside protectPreCompaction runs immediately at
      // invocation, so the background task is launched BEFORE setHistory to
      // snapshot pre-compaction state. Disk I/O then overlaps the request
      // path instead of blocking it. context/snapshot events never enter the
      // model history projection, so late arrival cannot break prefix cache
      // or replay invariants; originals remain in the append-only event log.
      // Opt out with MINUS_BG_GUARDIAN=off.
      const archiveStatus: Record<string, unknown> = {};
      let didCompactThisStep = false;
      // Archive-only checkpoints may overlap the request; destructive history
      // replacement must wait for durable archives and the original event log.
      const backgroundGuardianEnabled = !contextPreparation.changed && process.env.MINUS_BG_GUARDIAN !== 'off';
      let guardianTask: Promise<void> | undefined;
      if (!backgroundGuardianEnabled) {
        if (observationsToArchive.length > 0) {
          try {
            archiveStatus.maskedObservations = await this.turnMemoryRetriever.archiveMaskedObservations(observationsToArchive);
          } catch (error) {
            const message = String((error as Error)?.message || error);
            archiveStatus.maskedObservations = { error: message };
            CLI.renderArchiveWarning({ scope: 'Masked-observation', error: message });
            if (contextPreparation.changed) throw error;
          }
        }
      }
      if (contextPreparation.changed && compactionStats) {
        await this.persistSession(session);
        didCompactThisStep = true;
        if (backgroundGuardianEnabled) {
          // Launch BEFORE setHistory: the synchronous extraction prefix inside
          // protectPreCompaction runs immediately at invocation, snapshotting
          // pre-compaction state, while saveSnapshot + archive I/O overlap the
          // request path in the background.
          let guardianPromise: ReturnType<ContextGuardian['protectPreCompaction']> | undefined;
          try {
            guardianPromise = this.contextGuardian.protectPreCompaction(session, {
              mutatedFiles: Array.from(this.targetFilesModifiedInTurn),
              projectPhase: `Turn ${turn} ${classification.phase}`,
            });
          } catch {}
          guardianTask = (async () => {
            const bgArchiveStatus: Record<string, unknown> = {};
            if (observationsToArchive.length > 0) {
              try {
                bgArchiveStatus.maskedObservations = await this.turnMemoryRetriever.archiveMaskedObservations(observationsToArchive);
              } catch (error) {
                const message = String((error as Error)?.message || error);
                bgArchiveStatus.maskedObservations = { error: message };
                CLI.renderArchiveWarning({ scope: 'Masked-observation', error: message });
              }
            }
            try {
              const guardianResult = guardianPromise ? await guardianPromise : undefined;
              if (guardianResult) {
                if (compactionStats.archivedTurns?.length) {
                  try {
                    bgArchiveStatus.archivedTurns = await this.turnMemoryRetriever.archiveTurns(compactionStats.archivedTurns);
                  } catch (error) {
                    const message = String((error as Error)?.message || error);
                    bgArchiveStatus.archivedTurns = { error: message };
                    CLI.renderArchiveWarning({ scope: 'Archived-turn', error: message });
                  }
                }
                session.append('context/snapshot', {
                  reason: 'Context Guardian captured evidence before whole-request compaction.',
                  snapshotId: guardianResult.snapshotId,
                  contextFingerprint: contextPreparation.state?.sourceFingerprint,
                  archiveStatus: bgArchiveStatus,
                });
              }
            } catch {}
          })().catch(() => {});
          archiveStatus.deferred = true;
        } else {
          try {
            const guardianResult = await this.contextGuardian.protectPreCompaction(session, {
              mutatedFiles: Array.from(this.targetFilesModifiedInTurn),
              projectPhase: `Turn ${turn} ${classification.phase}`,
            });
            session.append('context/snapshot', {
              reason: 'Context Guardian captured evidence before whole-request compaction.',
              snapshotId: guardianResult.snapshotId,
              contextFingerprint: contextPreparation.state?.sourceFingerprint,
            });
          } catch {}
          if (compactionStats.archivedTurns?.length) {
            try {
              archiveStatus.archivedTurns = await this.turnMemoryRetriever.archiveTurns(compactionStats.archivedTurns);
            } catch (error) {
              const message = String((error as Error)?.message || error);
              archiveStatus.archivedTurns = { error: message };
              CLI.renderArchiveWarning({ scope: 'Archived-turn', error: message });
              throw error;
            }
          }
        }
        session.setHistory(
          contextPreparation.history,
          `context-budget-${contextPreparation.mode}`,
          { ...(contextPreparation.state as unknown as Record<string, unknown> | undefined), archiveStatus } as unknown as Record<string, unknown> | undefined,
        );
        await this.persistSession(session);
        CLI.renderAutoCompactionNotice(compactionStats.tokensSaved, compactionStats.compactedTokens);
        requestFootprint = this.latencyOrchestrator.estimateRequest({
          systemPrompt: assembledSystemPrompt,
          tools: activeToolDeclarations,
          history: session.getHistory(),
          dynamicContext: dynamicExecutionContext,
          maxInputTokens: activeTokenConfig.maxInputTokens,
          maxOutputTokens: activeTokenConfig.maxOutputTokens,
        });
      }
      if (contextPreparation.failureReason) {
        // Kiểm tra giới hạn phần cứng thực tế của Model Provider (Gemini 1M, Claude 200k, GPT 128k)
        const modelProfile = getModelTokenProfile(activeModelName);
        const hardwareLimit = modelProfile?.maxSupportedInputTokens || 128000;
        const actualEstimatedInput = contextPreparation.after.inputTokens;

        if (actualEstimatedInput < hardwareLimit && didCompactThisStep) {
          // Context chỉ vượt qua mức budget cấu hình mềm của người dùng (ví dụ: gói /token low 16K)
          // nhưng vẫn hoàn toàn nằm trong giới hạn chịu tải thực tế của Provider.
          // Tự động duy trì thực thi, cảnh báo nhẹ để không làm gián đoạn turn của người dùng.
          CLI.renderContextBudgetExceededNotice({
            currentTokens: actualEstimatedInput,
            configuredBudget: workingHistoryBudget,
            hardwareLimit,
            tier: activeTokenConfig.maxInputTokens ? `${activeTokenConfig.maxInputTokens} tokens` : 'Custom',
          });
        } else {
          // Chỉ dừng khi thực sự tràn giới hạn phần cứng của Model Provider
          const message = `Agent stopped: ${contextPreparation.failureReason} (${contextPreparation.after.upperBoundTokens}/${hardwareLimit} provider hardware limit exceeded).`;
          session.append('step/end', { turn, step, reason: contextPreparation.failureReason });
          await this.persistSession(session);
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, contextPreparation.failureReason);
          return message;
        }
      }

      session.recordRequestHeader({
        turn,
        step,
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        // Reuse the pre-compaction projection when history was not replaced;
        // identical content, skips a full event-log rebuild + clone.
        history: didCompactThisStep ? session.getHistory() : preCompactionHistory,
      }, {
        compactHistory: true,
        ...(didCompactThisStep ? {
          compaction: {
            preCompactionHistoryDigest: computeRequestValueDigest(preCompactionHistory),
            preCompactionMessages: preCompactionHistory.length,
            archivedTurns: compactionStats?.archivedTurns?.length ?? 0,
            maskedObservations: compactionStats?.maskedObservations?.length ?? 0,
            archiveStatus,
          },
        } : {}),
      });
      session.assertRuntimeInvariantsIncremental({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
      await this.persistSession(session);
      this.stepDynamicSuffixes.set(step, dynamicExecutionContext);
      const requestOptions: LLMRequestOptions = {
        systemPrompt: assembledSystemPrompt,
        dynamicContext: dynamicExecutionContext,
        turn,
        step,
        stepSuffixes: new Map(this.stepDynamicSuffixes),
        sessionId: session.id,
        promptCacheKey: session.id,
        enablePromptCaching: this.loopOptions?.enablePromptCaching !== false,
        signal: options?.signal,
        allowedFunctionNames: visibleToolNames,
        onRetry: (retryPayload: any) => {
          this.kernel?.ctx.events.emit('model:retry', retryPayload);
        },
      };
      const requestStartedAt = Date.now();
      let firstTokenAt: number | undefined;
      this.kernel?.ctx.events.emit('model:thinking:start', {
        agentId: this.agentId,
        turn,
        step,
        startedAt: requestStartedAt,
      });

      // PASTE: Inter-Step Pattern Prediction
      if (this.loopOptions?.enableStreamingDispatch !== false && !options?.signal?.aborted) {
        const speculativeCandidates = predictObservationCandidates(
          this.lastToolExecution?.toolName,
          this.lastToolExecution?.result,
          this._workspace.rootDir,
        );
        for (const candidate of speculativeCandidates) {
          this.pipelinedDispatcher.dispatchSpeculative(
            candidate.toolName,
            candidate.args,
            this.toolRunner,
            {
              sessionId: session.id,
              agentId: this.agentId,
              turn,
              userRequest: turnUserRequest,
              signal: options?.signal,
            },
            candidate.source,
          );
        }
      }

      let accumulatedThought = '';
      let thoughtTokenCount = 0;
      try {
        if (typeof this.llm.generateStream === 'function') {
          response = await this.llm.generateStream(session, activeToolDeclarations, {
            onRetry: (retryPayload: any) => {
              this.kernel?.ctx.events.emit('model:retry', retryPayload);
            },
            onThoughtToken: (token: string) => {
              if (firstTokenAt === undefined) {
                this.kernel?.ctx.events.emit('model:retry', null);
              }
              firstTokenAt ??= Date.now();
              this.kernel?.ctx.events.emit('model:thought', token);
              accumulatedThought += token;
              thoughtTokenCount++;
              if (thoughtTokenCount % 25 === 0 || token.includes('\n')) {
                if (this.loopOptions?.enableStreamingDispatch !== false && !options?.signal?.aborted) {
                  const candidatePaths = extractThoughtPaths(accumulatedThought, this._workspace.rootDir);
                  for (const candidatePath of candidatePaths) {
                    this.pipelinedDispatcher.dispatchSpeculative(
                      'read_file',
                      { path: candidatePath },
                      this.toolRunner,
                      {
                        sessionId: session.id,
                        agentId: this.agentId,
                        turn,
                        userRequest: turnUserRequest,
                        signal: options?.signal,
                      },
                      'thought-stream-intent',
                    );
                  }
                }
              }
            },
            onContentToken: (token: string) => {
              if (firstTokenAt === undefined) {
                this.kernel?.ctx.events.emit('model:retry', null);
              }
              firstTokenAt ??= Date.now();
              this.kernel?.ctx.events.emit('model:token', token);
            },
            onToolCallEarly: (earlyCall: any) => {
              if (this.loopOptions?.enableStreamingDispatch !== false && !options?.signal?.aborted) {
                const runContext = {
                  sessionId: session.id,
                  agentId: this.agentId,
                  turn,
                  userRequest: turnUserRequest,
                  signal: options?.signal,
                };
                this.pipelinedDispatcher.dispatchEarly(
                  earlyCall.name,
                  earlyCall.args,
                  this.toolRunner,
                  runContext,
                  earlyCall.id,
                );
              }
            },
          }, requestOptions);
        } else {
          response = await this.llm.generate(session, activeToolDeclarations, requestOptions);
        }
      } finally {
        this.kernel?.ctx.events.emit('model:retry', null);
        this.kernel?.ctx.events.emit('model:thinking:end', {
          agentId: this.agentId,
          turn,
          step,
          endedAt: Date.now(),
        });
      }
      this.setCircuitBreakerRetries(session.id, 0);
      const requestDurationMs = Date.now() - requestStartedAt;
      const timeToFirstTokenMs = firstTokenAt === undefined ? undefined : firstTokenAt - requestStartedAt;
      response.usage = {
        ...(response.usage || {}),
        requestDurationMs,
        ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
      };
      this.contextBudgetManager.observeActualUsage(
        activeModelName,
        contextPreparation.after.inputTokens,
        response.usage.promptTokens,
      );
      this.latencyOrchestrator.record({
        durationMs: requestDurationMs,
        timeToFirstTokenMs,
        promptTokens: response.usage.promptTokens,
        cachedTokens: response.usage.cachedTokens,
        profile: latencyProfile,
      });

      if (options?.signal?.aborted || response.finishReason === 'aborted') {
        const cancellationMessage = 'Agent stopped: cancellation requested.';
        this.pipelinedDispatcher.resetTurn();
        this.subagentManager.stopAll();
        session.append('step/end', { turn, step, reason: 'cancelled' });
        await this.persistSession(session);
        await CLI.renderExecutionStopped(cancellationMessage, 'CANCELLED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'cancelled');
        this.goalManager.pause('Task execution cancelled by user.');
        return cancellationMessage;
      }
      session.append('control/decision', {
        turn,
        step,
        controlDecision: {
          mode: 'soft-latency',
          requestDurationMs,
          timeToFirstTokenMs,
          estimatedInputTokens: requestFootprint.estimatedInputTokens,
          requestPressureRatio: requestFootprint.pressureRatio,
          modelName: activeModelName,
          latencyTier: latencyProfile.tier,
          softStepTargetMs: latencyProfile.targetMs,
          taskPhase: classification.phase,
          dynamicContextCache: this.dynamicContextCache.getStats(),
          dynamicContextCacheHit: Boolean(cachedDynamicContext),
          promptTokens: response.usage?.promptTokens,
          cachedTokens: response.usage?.cachedTokens,
          cacheCreationInputTokens: response.usage?.cacheCreationInputTokens,
          cacheReadInputTokens: response.usage?.cacheReadInputTokens,
          cacheHitRate: response.usage?.cacheHitRate,
          hardTimeoutApplied: false,
          contextManagementMode: contextPreparation.mode,
          contextInputUpperBound: contextPreparation.after.upperBoundTokens,
          contextWithinBudget: contextPreparation.withinBudget,
          shadowCandidateInputUpperBound: contextPreparation.candidateAfter?.upperBoundTokens,
          compactionStrategies: contextPreparation.compactionStats?.strategiesApplied,
        },
      });
      this.kernel?.ctx.events.emit('model:request_telemetry', {
        turn,
        step,
        requestDurationMs,
        timeToFirstTokenMs,
        requestFootprint,
        modelName: activeModelName,
        latencyProfile,
        taskPhase: classification.phase,
        dynamicContextCacheHit: Boolean(cachedDynamicContext),
        promptTokens: response.usage?.promptTokens,
        cachedTokens: response.usage?.cachedTokens,
        cacheHitRate: response.usage?.cacheHitRate,
        contextManagementMode: contextPreparation.mode,
        contextWithinBudget: contextPreparation.withinBudget,
        contextInputUpperBound: contextPreparation.after.upperBoundTokens,
      });

      // System 2: Tóm tắt hành vi/ý định suy luận của LLM trong step này dùng mistral/codestral-latest
      const isRootAgent = this.agentId === 'main'
        || this.agentId === 'interactive-agent'
        || this.agentId === 'coding-agent'
        || this.agentId === 'delegation-parent'
        || this.agentId === 'delegation-recovery-parent';
      const isSubagent = !isRootAgent || this.loopOptions?.enableSubagents === false || Boolean(this.agentId?.startsWith('subagent-'));
      const isMockLLM = Boolean(this.llm?.constructor?.name?.includes('Mock') || process.env.NODE_ENV === 'test');

      let userGoal: string | undefined = this.goalManager?.getState()?.objective;
      if (!userGoal) {
        const history = session.getHistory();
        for (let i = history.length - 1; i >= 0; i--) {
          const item = history[i];
          if (item?.role === 'user' && item.parts) {
            for (const p of item.parts) {
              if (p?.text) {
                userGoal = p.text;
                break;
              }
            }
            if (userGoal) break;
          }
        }
      }

      const stepSummary = generateFallbackStepSummary({
        step,
        userGoal,
        text: response.text,
        reasoningContent: response.reasoningContent,
        toolCalls: response.toolCalls,
      });
      // Case 4 — always-on intent line: one cheap sentence per step, kept
      // outside the model projection for timeline review and retrieval.
      session.addReasoning(stepSummary, { kind: 'intent', step, turn, trigger: 'step-summary' });

      if (!isSubagent && !this._collapsePreferences.compactSteps) {
        CLI.renderLLMThinking(stepSummary);
      }

      // Giám sát và hiển thị Prompt Cache Hit Rate / Token Telemetry
      if (response.usage) {
        this.kernel?.ctx.events.emit('model:usage', response.usage);
        if (!this._collapsePreferences.compactSteps) {
          CLI.renderCacheUsage(response.usage);
        }
      }

      // System 2: Hiển thị mạch suy luận nội tâm sâu (Deep Reasoning / CoT) nếu có
      if (response.reasoningContent) {
        this._latestReasoning = {
          thought: response.reasoningContent,
          timestamp: new Date().toLocaleTimeString(),
          step,
          turn: (session as any).turnsCount || 1,
        };
        // Case 3 — explicit audit mode only (MINUS_REASONING_LOG=1):
        // persist the full thought. Default off; routine thoughts stay ephemeral.
        if (envFeatureEnabled('MINUS_REASONING_LOG', false)) {
          this.persistStepReasoning(session, response.reasoningContent, { debugLogEnabled: true, step, turn });
        }
        // The [REQUEST ANALYSIS] block is short, high-signal, and explicitly
        // user-facing: always display it, even when step output is compacted.
        const requestAnalysis = extractRequestAnalysis(response.reasoningContent);
        if (requestAnalysis) {
          CLI.renderRequestAnalysis(requestAnalysis);
        } else if (!this._collapsePreferences.compactSteps) {
          CLI.renderReasoning(response.reasoningContent, { collapsed: this._collapsePreferences.thinking || this._collapsePreferences.compactSteps });
        }
        // Streaming providers already emitted each thought chunk. Emit the
        // aggregate only for non-streaming providers to avoid duplicating the
        // reasoning trace in reactive UIs.
        if (typeof this.llm.generateStream !== 'function') {
          this.kernel?.ctx.events.emit('model:thought', response.reasoningContent);
        }

        // Wink-Style Specification Drift & Goal Substitution Nudge
        const thoughtDrift = this.domainIntentGuardian.observeModelThoughts(response.reasoningContent);
        if (thoughtDrift) {
          CLI.renderReflectionAlert(1, `[Wink Course-Correction Nudge]: ${thoughtDrift.message}`);
        }
      }

      const hasToolCalls = Boolean(response.toolCalls && response.toolCalls.length > 0);
      const hasValidText = Boolean(response.text && response.text.trim().length > 0);
      const hasReasoning = Boolean(response.reasoningContent && response.reasoningContent.trim().length > 0);
      const hasExplicitFinishReason = typeof response.finishReason === 'string';
      const finishReason = response.finishReason
        || (hasToolCalls ? 'tool_calls' : hasValidText ? 'stop' : 'unknown');
      const recoverableIncompleteFinish = hasExplicitFinishReason
        && ['max_tokens', 'transport_eof', 'unknown'].includes(finishReason);
      const terminalIncompleteFinish = hasExplicitFinishReason
        && ['content_filter', 'error', 'aborted'].includes(finishReason);

      if (recoverableIncompleteFinish || terminalIncompleteFinish) {
        consecutiveIncompleteFinishes++;
        if (hasValidText) {
          // Persist only the visible text prefix. Partial/unconfirmed tool calls
          // must not enter history or execute.
          session.addModelMessage({ text: response.text });
        }

        const finishDetail = response.rawFinishReason
          ? `${finishReason} (${response.rawFinishReason})`
          : finishReason;
        const canRetry = recoverableIncompleteFinish
          && consecutiveIncompleteFinishes <= maxIncompleteFinishRetries;

        if (canRetry) {
          CLI.renderReflectionAlert(
            consecutiveIncompleteFinishes,
            `Model stream ended with ${finishDetail}; partial output was not accepted as final. Continuing the same user turn.`,
          );
          session.addUserMessage(
            `[SYSTEM STREAM CONTINUATION]: The previous model response ended with ${finishDetail} before a confirmed final answer. Continue from the preserved text prefix. Re-issue any intended tool call in full; no partial tool call was executed.`,
            'system',
          );
          await this.persistSession(session);
          CLI.renderStepFooter();
          const continuationReason = `${finishReason}-continuation`;
          session.append('step/end', { turn, step, reason: continuationReason });
          await this.persistSession(session);
          await this.agentHooks.run('agent/after-step', {
            ...hookContext,
            reason: continuationReason,
          });
          this.kernel?.ctx.events.emit('step:after', step);
          continue;
        }

        const incompleteMessage = terminalIncompleteFinish
          ? `Agent stopped: model response ended with ${finishDetail}. No partial response was accepted as completion.`
          : `Agent stopped: model response remained incomplete after ${maxIncompleteFinishRetries} continuation attempts (last reason: ${finishDetail}).`;
        CLI.renderReflectionAlert(consecutiveIncompleteFinishes, incompleteMessage);
        CLI.renderStepFooter();
        session.append('step/end', { turn, step, reason: `${finishReason}-terminal` });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: `${finishReason}-terminal`,
        });
        await CLI.renderExecutionStopped(incompleteMessage, 'INCOMPLETE_RESPONSE');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, `${finishReason}-terminal`);
        this.goalManager.disarm();
        return incompleteMessage;
      }
      consecutiveIncompleteFinishes = 0;

      // 4. Nếu model muốn gọi tool (System 1: Action)
      if (hasToolCalls) {
        consecutiveEmptyTurns = 0;
        if (!this._collapsePreferences.compactSteps) {
          CLI.renderModelAction('tool_call', `Requesting ${response.toolCalls.length} tool call(s)`);
        }

        const normalizedToolCalls = response.toolCalls.map((call: any) => ({
          ...call,
          name: typeof call?.name === 'string' && call.name.trim()
            ? call.name.trim()
            : '__invalid_tool_call__',
          args: call?.args ?? call?.arguments ?? {},
        }));
        const seenToolCallIds = new Set<string>();
        const toolCallIds = normalizedToolCalls.map((call: any, callIndex: number) => {
          let candidateId = (call as any).id || `call-${turn}-${step}-${callIndex}`;
          if (seenToolCallIds.has(candidateId)) {
            candidateId = `${candidateId}_${callIndex}`;
          }
          seenToolCallIds.add(candidateId);
          return candidateId;
        });
        const toolCallsWithIds = normalizedToolCalls.map((call: any, callIndex: number) => ({
          ...call,
          id: toolCallIds[callIndex],
        }));

        // Ghi lại phản hồi gọi tool của model vào Session
        session.addModelMessage({
          text: response.text,
          functionCalls: toolCallsWithIds,
          rawContent: response.rawContent,
        });
        await this.persistSession(session);
        const assistantSeq = session.lastEvent?.seq;
        const responseFunctionCallParts = (response.rawContent?.parts || [])
          .filter((part: any) => part.functionCall);

        const scheduledToolCalls: ScheduledToolCall[] = normalizedToolCalls.map((call: any, callIndex: number) => ({
          index: callIndex,
          id: toolCallIds[callIndex],
          name: call.name || '__invalid_tool_call__',
          args: (call.args as Record<string, unknown>) || {},
        }));
        const concurrentReadsEnabled = this.loopOptions?.enableConcurrentReadTools
          ?? envFeatureEnabled('MINUS_CONCURRENT_READ_TOOLS');
        const batchPersistenceEnabled = this.loopOptions?.enableBatchSessionPersistence
          ?? envFeatureEnabled('MINUS_BATCH_SESSION_PERSISTENCE');
        const toolPartitions = partitionToolCalls(scheduledToolCalls, concurrentReadsEnabled);
        const readPartitionByIndex = new Map<number, ToolCallPartition>();
        for (const partition of toolPartitions) {
          if (partition.mode === 'sequential') continue;
          for (const scheduled of partition.calls) readPartitionByIndex.set(scheduled.index, partition);
        }
        const preexecutedReadResults = new Map<number, ToolExecutionResult>();
        const startedConcurrentPartitions = new Set<number>();
        const readBatchDurationMs = new Map<number, number>();
        const readBatchToolDurationMs = new Map<number, number>();
        const readBatchSnapshotBefore = new Map<number, ReadSnapshot>();
        const readBatchSnapshotMismatch = new Map<number, string[]>();

        let strategyChangeRequired: { toolName: string; repetitionCount: number } | undefined;
        let toolBatchCancelled = false;
        let userDeniedPermission: { toolName: string; detail: string } | undefined;
        let postSubmissionBlocked = false;
        let phaseTransitionAcceptedInResponse = false;
        let parallelBatchCount = 0;
        let parallelTotalTools = 0;
        let parallelDurationMs = 0;
        let parallelSavedMs = 0;

        // Thực thi từng Tool Call thông qua ToolRunner (5-stage pipeline)
        for (const [callIndex, call] of normalizedToolCalls.entries()) {
          const readPartition = readPartitionByIndex.get(callIndex);
          const partitionStartIndex = readPartition?.calls[0]?.index;
          const partitionEndIndex = readPartition?.calls.at(-1)?.index;
          const deferReadPersistence = Boolean(
            batchPersistenceEnabled && readPartition && readPartition.calls.length > 1,
          );

          if (
            readPartition?.mode === 'concurrent-read'
            && partitionStartIndex === callIndex
            && !startedConcurrentPartitions.has(callIndex)
          ) {
            startedConcurrentPartitions.add(callIndex);
            if (hasSubmittedSolution) {
              for (const scheduled of readPartition.calls) {
                preexecutedReadResults.set(scheduled.index, {
                  toolName: scheduled.name,
                  args: scheduled.args,
                  durationMs: 0,
                  result: {
                    success: false,
                    submitted: true,
                    summary: submittedSolutionSummary || 'Task completed and submitted.',
                    nextAction: 'final_answer',
                    errorCode: 'POST_SUBMISSION_TOOL_CALL_BLOCKED',
                    message: 'Solution has already been submitted and verified. All tool calls are locked. Do not execute further tools; conclude your turn with your final response to the user immediately.',
                  },
                });
              }
            } else {
              for (const scheduled of readPartition.calls) {
                session.append('tool/call', {
                  turn,
                  step,
                  toolName: scheduled.name,
                  toolCallId: scheduled.id,
                  assistantSeq,
                  args: scheduled.args,
                  thoughtSignature: responseFunctionCallParts[scheduled.index]?.thoughtSignature,
                });
                this.kernel?.ctx.events.emit('tool:before', scheduled.name, scheduled.args);
                // Mirror the sequential path below: in compact mode the completion
                // one-liner (renderCompactOneLiner) already shows each tool, so
                // emitting the verbose call line here would render every
                // parallel tool twice.
                if (!this._collapsePreferences.compactSteps) {
                  CLI.renderToolCall(scheduled.name, scheduled.args);
                } else {
                  CLI.startToolDotSpinner(scheduled.name, scheduled.args);
                }
              }

              const batchStartedAt = Date.now();
              // Snapshot epoch: fingerprint read targets before dispatch so a
              // mid-flight external FS change can be flagged without locking.
              const snapshotTargets = extractReadTargets(readPartition.calls.map((scheduled) => ({
                name: scheduled.name,
                args: scheduled.args as Record<string, unknown>,
              })));
              const snapshotBefore = snapshotTargets.length > 0
                ? await snapshotReadTargets(this._workspace.rootDir, snapshotTargets).catch(() => undefined)
                : undefined;
              if (snapshotBefore) readBatchSnapshotBefore.set(callIndex, snapshotBefore);
              const settled = await Promise.allSettled(readPartition.calls.map(async (scheduled) => {
                const pipelinedOutcome = await this.pipelinedDispatcher.awaitOrExecute(
                  scheduled.name,
                  scheduled.args as Record<string, unknown>,
                  stepToolRunner,
                  {
                    sessionId: session.id,
                    agentId: this.agentId,
                    turn,
                    userRequest: turnUserRequest,
                    signal: options?.signal,
                    controlMode: toolControlMode,
                    ...(toolControlMode !== 'off' ? {
                      decisionId: activeDecisionId,
                      allowedToolNames: authorizedToolNames,
                      allowedToolSetHash: activeToolSetHash,
                      classificationPhase: classification.phase,
                      phaseVersion: classification.phaseVersion,
                      classificationRisk: classification.risk,
                      maxToolCalls: recommendedToolDecision.maxToolCalls,
                    } : {}),
                  },
                  scheduled.id,
                );
                return pipelinedOutcome.executionResult;
              }));
              readBatchDurationMs.set(callIndex, Date.now() - batchStartedAt);
              const batchSnapshotBefore = readBatchSnapshotBefore.get(callIndex);
              if (batchSnapshotBefore) {
                const snapshotAfterEpoch = await snapshotReadTargets(
                  this._workspace.rootDir,
                  Object.keys(batchSnapshotBefore.entries),
                ).catch(() => undefined);
                if (snapshotAfterEpoch) {
                  const changed = diffReadSnapshots(batchSnapshotBefore, snapshotAfterEpoch);
                  if (changed.length > 0) readBatchSnapshotMismatch.set(callIndex, changed);
                }
              }
              settled.forEach((outcome, resultIndex) => {
                const scheduled = readPartition.calls[resultIndex];
                preexecutedReadResults.set(scheduled.index, outcome.status === 'fulfilled'
                  ? outcome.value
                  : {
                    toolName: scheduled.name,
                    args: scheduled.args,
                    durationMs: 0,
                    result: {
                      error: outcome.reason?.message || String(outcome.reason),
                      errorCode: 'TOOL_EXECUTION_REJECTED',
                      retryable: true,
                    },
                  });
              });
            }
          }

          if (options?.signal?.aborted && !preexecutedReadResults.has(callIndex)) {
            // The assistant message already declared the entire batch. Record
            // explicit results for every call that will not be dispatched so
            // history remains valid and no call can look silently abandoned.
            for (let pendingIndex = callIndex; pendingIndex < normalizedToolCalls.length; pendingIndex++) {
              const pendingCall = normalizedToolCalls[pendingIndex];
              const pendingToolName = pendingCall.name || '__invalid_tool_call__';
              const pendingToolCallId = toolCallIds[pendingIndex];
              const pendingArgs = (pendingCall.args as Record<string, any>) || {};
              const abortedResult = {
                error: 'The tool call was not started because cancellation was requested before dispatch.',
                errorCode: 'ABORTED_BEFORE_DISPATCH',
                retryable: true,
              };
              session.append('tool/call', {
                turn,
                step,
                toolName: pendingToolName,
                toolCallId: pendingToolCallId,
                assistantSeq,
                args: pendingArgs,
                thoughtSignature: responseFunctionCallParts[pendingIndex]?.thoughtSignature,
                reason: 'aborted-before-dispatch',
              });
              session.addToolResultWithId(
                pendingToolName,
                abortedResult,
                pendingToolCallId,
                'aborted-before-dispatch',
              );
              CLI.renderToolResult(pendingToolName, 0, abortedResult);
              this.kernel?.ctx.events.emit('tool:error', pendingToolName, abortedResult);
            }
            await this.persistSession(session);
            toolBatchCancelled = true;
            break;
          }

          const toolName = call.name || '';
          const toolArgs = (call.args as Record<string, any>) || {};

          const toolCallId = toolCallIds[callIndex];
          if (readPartition?.mode !== 'concurrent-read') {
            session.append('tool/call', {
              turn,
              step,
              toolName,
              toolCallId,
              assistantSeq,
              args: toolArgs,
              thoughtSignature: responseFunctionCallParts[callIndex]?.thoughtSignature,
            });
          }
          if (!deferReadPersistence && readPartition?.mode !== 'concurrent-read') {
            await this.persistSession(session);
          }

          if (toolName === '__invalid_tool_call__') {
            const invalidResult = {
              error: 'The model emitted a tool call without a valid tool name.',
              errorCode: 'INVALID_TOOL_CALL',
              retryable: true,
            };
            session.addToolResultWithId(toolName, invalidResult, toolCallId, 'invalid-tool-call');
            if (!deferReadPersistence) await this.persistSession(session);
            this.kernel?.ctx.events.emit('tool:error', toolName, invalidResult);
            continue;
          }

          if (phaseTransitionAcceptedInResponse) {
            const blockedResult = {
              success: false,
              errorCode: 'PHASE_TRANSITION_REQUIRES_FRESH_MODEL_TURN',
              error: 'A phase transition was accepted earlier in this response. Re-issue this tool call after the Harness provides the new phase and tool set.',
              retryable: true,
            };
            session.addToolResultWithId(toolName, blockedResult, toolCallId, 'phase-transition-requires-fresh-turn');
            await this.persistSession(session);
            this.kernel?.ctx.events.emit('tool:error', toolName, blockedResult);
            continue;
          }


          const sideEffectConfig: Record<string, { reversible: boolean; checkpoint: boolean }> = {
            write_file: { reversible: true, checkpoint: true },
            replace_text: { reversible: true, checkpoint: true },
            apply_patch: { reversible: true, checkpoint: true },
            create_file: { reversible: true, checkpoint: true },
            delete_file: { reversible: true, checkpoint: true },
            move_file: { reversible: true, checkpoint: true },
            run_command: { reversible: false, checkpoint: true },
            git_add: { reversible: true, checkpoint: true },
            git_commit: { reversible: true, checkpoint: true },
            git_push: { reversible: false, checkpoint: true },
          };
          let sideEffect: { reversible: boolean; checkpoint: boolean } | undefined = sideEffectConfig[toolName];
          if (toolName === 'git_command') {
            const gitRisk = classifyGitCommand(
              String(toolArgs.subcommand || ''),
              Array.isArray(toolArgs.args) ? toolArgs.args.map(String) : [],
            ).risk;
            sideEffect = gitRisk === 'read'
              ? undefined
              : gitRisk === 'network'
                ? { reversible: false, checkpoint: true }
                : { reversible: true, checkpoint: true };
          }
          const effect = sideEffect
            ? this.effectLedger.prepare(toolName, toolCallId, sideEffect.reversible)
            : undefined;
          if (effect) await this.persistSession(session);

          // Tạo Shadow Git Checkpoint trước các thao tác sửa đổi file hoặc chạy lệnh
          if (effect && sideEffect?.checkpoint) {
            const checkpoint = await this.checkpointManager.createCheckpoint(`Tool ${toolName}: ${JSON.stringify(toolArgs)}`);
            this.effectLedger.attachCheckpoint(effect.id, checkpoint?.id);
            await this.persistSession(session);
          }

          const preexecutedReadResult = preexecutedReadResults.get(callIndex);
          if (!preexecutedReadResult) {
            this.kernel?.ctx.events.emit('tool:before', toolName, toolArgs);
            if (!this._collapsePreferences.compactSteps) {
              CLI.renderToolCall(toolName, toolArgs);
            } else {
              CLI.startToolDotSpinner(toolName, toolArgs);
            }
          }

          // Post-Submission Terminal Gate (OpenAI Codex CLI Standard):
          // Chặn toàn bộ các tool call dư thừa (kể cả read_file, run_command) nếu nhiệm vụ đã được submit_solution hoàn tất
          if (callIndex > 0 && (toolName === 'request_phase_transition' || isMutationTool(toolName))) {
            const validatedNow = this.hypothesisTracker.getValidatedHypotheses();
            paretoEvidence = assessParetoEvidence({
              session, turn, taskClass: classification.taskClass, risk: classification.risk,
              validatedHypothesisCount: validatedNow.length,
              supportedHypothesisCount: this.hypothesisTracker.getSupportedHypotheses().length,
            });
            inspectedLowRiskFastPath = ['R0', 'R1', 'R2'].includes(classification.risk)
              && paretoEvidence.inspectedFiles.length > 0;
            const configuredReproMode = configuredEvidenceGateMode()
              || (process.env.MINUS_REPRODUCTION_GATE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'observe');
            const previousGate = this.toolRunner.guardian.getPreMutationGateContext();
            this.toolRunner.guardian.setPreMutationGateContext({
              ...previousGate!,
              hasPlan: this.planManager.hasPlan(),
              hasValidatedHypothesis: validatedNow.length > 0,
              validatedTargetFiles: validatedNow.flatMap((hypothesis) => hypothesis.targetFiles || []),
              evidenceScore: paretoEvidence.score,
              evidenceThreshold: paretoEvidence.threshold,
              evidenceReasons: paretoEvidence.reasons,
              inspectedFiles: paretoEvidence.inspectedFiles,
              hasEmpiricalEvidence: paretoEvidence.hasEmpiricalEvidence,
              allMutationsAreNonExecutable: this.completionEvidenceGate.hasOnlyNonExecutableMutations(session, turn),
              userExplicitlyExemptsTesting: isUserExplicitlyExemptingTests(turnUserRequest || retrievalUserRequest),
              reproductionStatus: {
                ...previousGate?.reproductionStatus,
                enforceReproductionPass: configuredReproMode === 'enforce' && classification.taskClass === 'bugfix',
                hasPostFixPass: this.completionEvidenceGate.hasPostFixReproductionPass(session, turn),
                hasPreFixRepro: paretoEvidence.hasFailureEvidence || validatedNow.length > 0,
              },
            });
          }
          let executionResult: ToolExecutionResult;
          if (hasSubmittedSolution) {
            const redundantPayload = {
              success: false,
              submitted: true,
              summary: submittedSolutionSummary || 'Task completed and submitted.',
              nextAction: 'final_answer',
              errorCode: 'POST_SUBMISSION_TOOL_CALL_BLOCKED',
              message: 'Solution has already been submitted and verified. All tool calls are locked. Do not execute further tools; conclude your turn with your final response to the user immediately.',
            };
            executionResult = { toolName, args: toolArgs, durationMs: 0, result: redundantPayload };
          } else if (toolName === 'request_phase_transition') {
            const schema = this.toolProvider.get(toolName)?.parameters;
            const validation = validateSchemaValue(toolArgs, schema as any, '$', {
              rejectUnknownProperties: true,
            });
            if (!validation.valid) {
              const error = `Invalid arguments for tool "${toolName}": ${validation.errors.join('; ')}`;
              const recovery = getPhaseTransitionRecoveryGuidance('INVALID_ARGS', error);
              executionResult = {
                toolName,
                args: toolArgs,
                durationMs: 0,
                result: {
                  success: false,
                  error,
                  message: error,
                  errorCode: 'INVALID_ARGS',
                  validationErrors: validation.errors,
                  reason: error,
                  suggestion: recovery,
                  retryable: true,
                  _system_phase_transition_recovery: recovery,
                },
              };
            } else {
              const transition = requestPhaseTransition(session, turn, classification, {
                targetPhase: toolArgs.targetPhase,
                rationale: toolArgs.rationale,
                evidenceRefs: toolArgs.evidenceRefs,
              }, {
                hasPlan: this.planManager.hasPlan(),
                evidenceSufficient: this.hypothesisTracker.getValidatedHypotheses().length > 0
                  || paretoEvidence.hasSufficientEvidence || inspectedLowRiskFastPath,
              });
              const recovery = transition.accepted
                ? undefined
                : getPhaseTransitionRecoveryGuidance(transition.errorCode, transition.reason);
              executionResult = {
                toolName,
                args: toolArgs,
                durationMs: 0,
                result: {
                  success: transition.accepted,
                  phase: transition.phase,
                  phaseVersion: transition.phaseVersion,
                  reason: transition.reason,
                  ...(transition.errorCode ? { errorCode: transition.errorCode } : {}),
                  ...(!transition.accepted ? {
                    error: transition.reason,
                    message: transition.reason,
                    suggestion: recovery,
                    retryable: true,
                    _system_phase_transition_recovery: recovery,
                  } : {}),
                },
              };
              phaseTransitionAcceptedInResponse = transition.accepted;
            }
          } else if (preexecutedReadResult) {
            executionResult = preexecutedReadResult;
          } else {
            // Chạy tool qua pipeline an toàn
            const originalCodeChangeRequired = (initialTurnClassification.phase !== 'explore' && initialTurnClassification.requiredCapabilities.includes('edit'))
              || initialTurnClassification.reasonCodes.includes('WORKSPACE_MUTATION_INTENT')
              || initialTurnClassification.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE')
              || getTurnCompletionState(session, turn).hasMutations
              || this.verificationPolicy.hasPendingModifications()
              || Boolean(this.planManager.getTasks().some((task: any) => (task.writeSet || []).length > 0));
            let completionEvidence = toolName === 'submit_solution' && isCompletionEvidenceGateEnabled()
              ? this.completionEvidenceGate.evaluate(String(toolArgs.summary || ''), session, {
                turn,
                codeChangeRequired: originalCodeChangeRequired,
                userRequest: turnUserRequest,
                taskClass: classification.taskClass,
                resolutionType: typeof toolArgs.resolutionType === 'string' ? toolArgs.resolutionType : undefined,
              })
              : undefined;
            let policyCompletion = toolName === 'submit_solution'
              ? this.verificationPolicy.canComplete([], {
                changedFileCount: this.targetFilesModifiedInTurn.size,
                hasCallers: this.editTouchedCallers,
                blastRisk: this.maxEditBlastRisk,
                sensitivePathTouched: Array.from(this.targetFilesModifiedInTurn).some((file) => !isNonExecutableFile(file) && isSensitivePath(file)),
              }, { userExemptsTesting: isUserExplicitlyExemptingTests(turnUserRequest) })
              : undefined;

            let ocrCompletion: OcrGateDecision = {
              allow: true,
              reason: 'not-applicable',
              blockingFindings: [],
              advisoryFindings: [],
            };
            if (
              toolName === 'submit_solution'
              && policyCompletion?.allowed === true
              && completionEvidence?.allow === true
              && !isSubagent
              && !isMockLLM
            ) {
              const ocrReview = (this.kernel?.ctx as any)?.ocrReview as OcrReviewService | undefined;
              if (ocrReview) {
                const completionState = getTurnCompletionState(session, turn);
                ocrCompletion = await ocrReview.evaluateCompletion({
                  session,
                  filesModified: completionState.filesModified,
                  background: turnUserRequest,
                  signal: options?.signal,
                });
                await this.persistSession(session);
              }
            }
            // Phase 1 ACI Guardrails Pre-validation (SWE-agent)
            const aciValidation = this.aciGuardrails.validate({
              toolName,
              args: toolArgs,
              workspaceRoot: this._workspace.rootDir,
            }, resolveAciGuardrailMode());

            // Phase 3 Dual-Agent Exploration Sufficiency & Reproduction Gate (Agentless & AutoCodeRover & Dual-Agent Verifier)
            const targetFilePath = String(toolArgs?.path || toolArgs?.filePath || toolArgs?.file || toolArgs?.targetFile || toolArgs?.AbsolutePath || '');
            const isScratch = isScratchFilePath(targetFilePath);
            const reproductionMode = configuredEvidenceGateMode()
              || (process.env.MINUS_REPRODUCTION_GATE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'observe');

            const explorationSufficiency: ExplorationSufficiencyDecision = isMutationTool(toolName) && !isScratch
              ? this.criticGate.evaluateExplorationSufficiency({
                  taskClass: classification.taskClass,
                  session,
                  targetFilePath,
                  hasReproduction: this.verificationPolicy.hasReproduction(),
                  hypothesisTracker: this.hypothesisTracker,
                  domainGuardian: this.domainIntentGuardian,
                  userRequest: turnUserRequest,
                  gateMode: reproductionMode,
                  risk: classification.risk,
                })
              : { allowed: true, score: 100, reasons: [], inspectedFiles: [] };

            this.kernel?.ctx.events.emit('gate:exploration_sufficiency', explorationSufficiency);

            const reproductionCheck: { allowed: boolean; reason?: string; advisory?: string } = isMutationTool(toolName)
              ? this.verificationPolicy.canMutate(classification.taskClass, reproductionMode, {
                  targetFilePath,
                  isScratchFile: isScratch,
                  criticApproved: explorationSufficiency.allowed,
                  riskLevel: classification.risk,
                })
              : { allowed: true };
            if (reproductionCheck.allowed && reproductionCheck.advisory) {
              this.kernel?.ctx.events.emit('gate:reproduction_advisory', {
                turn,
                toolName,
                targetFilePath,
                advisory: reproductionCheck.advisory,
              });
            }

            const fixationCheck = isMutationTool(toolName) && !isScratch
              ? this.cognitiveHarness.fileFixationTracker.isFrozen(targetFilePath, turn)
              : { frozen: false };

            const submitGateBlocked = toolName === 'submit_solution' && (
              policyCompletion?.allowed !== true
              || (isCompletionEvidenceGateEnabled() && completionEvidence?.allow !== true)
              || !ocrCompletion.allow
            );
            if (submitGateBlocked) {
              const error = !ocrCompletion.allow
                ? ocrCompletion.continuationPrompt || 'OpenCodeReview must pass before submitting the solution.'
                : policyCompletion?.reason
                  || completionEvidence?.continuationPrompt
                  || 'Completion evidence is incomplete.';
              executionResult = {
                toolName,
                args: toolArgs,
                result: {
                  success: false,
                  error,
                  errorCode: !ocrCompletion.allow ? 'OCR_REVIEW_REQUIRED' : 'COMPLETION_EVIDENCE_REQUIRED',
                  retryable: true,
                  ocrRunId: ocrCompletion.run?.runId,
                  ocrArtifact: ocrCompletion.run?.artifactRef,
                },
                durationMs: 1,
              };
            } else if (!aciValidation.allowed) {
              executionResult = {
                toolName,
                args: toolArgs,
                result: {
                  success: false,
                  error: aciValidation.rejectionMessage,
                  reasonCode: aciValidation.reasonCode,
                  remediationHint: aciValidation.remediationHint,
                },
                durationMs: 1,
              };
            } else if (!explorationSufficiency.allowed) {
              executionResult = {
                toolName,
                args: toolArgs,
                result: {
                  success: false,
                  error: explorationSufficiency.critiquePrompt || explorationSufficiency.reasons.join('; '),
                  reasonCode: 'EXPLORATION_SUFFICIENCY_BLOCKED',
                  remediationHint: explorationSufficiency.remediationHint,
                },
                durationMs: 1,
              };
            } else if (!reproductionCheck.allowed) {
              executionResult = {
                toolName,
                args: toolArgs,
                result: {
                  success: false,
                  error: reproductionCheck.reason,
                  reasonCode: 'REPRODUCTION_GATE_BLOCKED',
                },
                durationMs: 1,
              };
            } else if (fixationCheck.frozen) {
              executionResult = {
                toolName,
                args: toolArgs,
                result: {
                  success: false,
                  error: fixationCheck.reason,
                  reasonCode: 'ANTI_FIXATION_CIRCUIT_BREAKER_BLOCKED',
                  remediationHint: 'Target file is frozen for 1 turn after 2 consecutive failures. Inspect upstream callers, configurations, or schemas before re-attempting modification.',
                },
                durationMs: 1,
              };
            } else {
              const pipelinedOutcome = await this.pipelinedDispatcher.awaitOrExecute(
                toolName,
                toolArgs,
                stepToolRunner,
                {
                  sessionId: session.id,
                  agentId: this.agentId,
                  turn,
                  userRequest: turnUserRequest,
                  signal: options?.signal,
                  lastCommandExecution: this.lastCommandExecutionState,
                  controlMode: toolControlMode,
                  ...(toolControlMode !== 'off' ? {
                    decisionId: activeDecisionId,
                    allowedToolNames: authorizedToolNames,
                    allowedToolSetHash: activeToolSetHash,
                    classificationPhase: classification.phase,
                    phaseVersion: classification.phaseVersion,
                    classificationRisk: classification.risk,
                    maxToolCalls: recommendedToolDecision.maxToolCalls,
                  } : {}),
                  ...(toolName === 'submit_solution' ? {
                    completionEvidenceVerified: true,
                    completionEvidenceReason: ocrCompletion.run?.runId,
                  } : {}),
                },
                toolCallId,
              );
              executionResult = pipelinedOutcome.executionResult;
            }
            if (executionResult.result?.errorCode === 'TOOL_NOT_ALLOWED_THIS_TURN'
              || executionResult.result?.errorCode === 'INVALID_TOOL_DECISION_BINDING') {
              this.toolControlTelemetry.recordDeniedCall();
              // P2: attach cheap recovery carrying the authorized list. The next
              // step surfaces it via authorizationRecovery + reflection prompt
              // without failure-streak, budget, or cascade-freeze cost.
              try {
                const recoveryText = `🔧 [TOOL AUTHORIZATION RECOVERY]: Tool "${toolName}" is not authorized in phase "${classification.phase}". Authorized: [${authorizedToolNames.join(', ')}]. Visible to model: [${visibleToolNames.join(', ')}]. Pick the closest authorized tool; do not repeat the denied call unchanged.`;
                if (executionResult.result && typeof executionResult.result === 'object') {
                  if (Object.isExtensible(executionResult.result)) {
                    (executionResult.result as any)._system_tool_authorization_recovery = recoveryText;
                  } else {
                    executionResult = {
                      ...executionResult,
                      result: { ...executionResult.result, _system_tool_authorization_recovery: recoveryText },
                    };
                  }
                }
              } catch { }
            }
          }

          // Attach only verified pre-edit attribution; never infer ownership from exit code alone.
          const commandForAttribution = extractCommandString(toolArgs, executionResult.result);
          const mutationBeforeCommand = toolName === 'run_command' && isVerificationCommand(commandForAttribution)
            ? getTurnCompletionState(session, turn)
            : undefined;
          if (toolName === 'run_command' && isVerificationCommand(commandForAttribution)
            && mutationBeforeCommand?.hasMutations && executionResult.result?.commandOutcome === 'failed_unexpected') {
            const regressionEvidence = await attributeCommandFailure(
              session, turn, commandForAttribution, executionResult.result,
              this._workspace, mutationBeforeCommand.filesModified, mutationBeforeCommand.latestMutationSeq,
            );
            executionResult = { ...executionResult, result: { ...executionResult.result, regressionEvidence } };
          }

          CLI.stopToolDotSpinner();
          if (this._collapsePreferences.compactSteps) {
            CLI.renderCompactOneLiner({
              step,
              maxSteps: effectiveMaxSteps,
              phase: classification.phase,
              toolName,
              args: toolArgs,
              durationMs: executionResult.durationMs,
              result: executionResult.result,
              tokens: response.usage?.totalTokens,
              cachedTokens: response.usage?.cachedTokens,
            });
          } else {
            CLI.renderToolResult(toolName, executionResult.durationMs, executionResult.result);
          }
          this.kernel?.ctx.events.emit(
            'tool:after',
            toolName,
            executionResult.result,
            executionResult.durationMs,
            toolArgs,
            { sessionId: session.id, agentId: this.agentId, turn },
          );

          // Phân tích kết quả qua ReflectionEngine (Tự vấn & Debugging Protocol + LSP Diagnostics)
          const hasMutationsSoFar = getTurnCompletionState(session, turn).hasMutations
            || hasObservedMutation(toolName, executionResult.result);
          const reflectionAnalysis = this.reflectionEngine.analyze({
            toolName,
            args: toolArgs,
            result: executionResult.result,
            durationMs: executionResult.durationMs,
          }, this._workspace, {
            hasCodeMutations: hasMutationsSoFar,
            modifiedFiles: Array.from(this.targetFilesModifiedInTurn),
          });
          // Cascade-repair freeze: latch when ≥3 consecutive failures share one
          // error signature; auto-clears when the signature changes or success
          // lands (the streak tracker resets on both).
          const failStreak = this.reflectionEngine.getSameSignatureFailStreak();
          const freezeThreshold = Math.max(2, parseInt(process.env.MINUS_CASCADE_FREEZE_STREAK || '3', 10) || 3);
          if (failStreak && failStreak.count >= freezeThreshold) {
            if (!this.cascadeFreeze) this.cascadeFreeze = { ...failStreak };
          } else if (!failStreak || failStreak.signature !== this.cascadeFreeze?.signature) {
            this.cascadeFreeze = undefined;
          }
          // Signature-novelty repair budget: only same-signature repeats consume
          // budget; novel failures and successes reset it (feeds LATS backtracking).
          this.verificationPolicy.recordRepairAttempt(
            reflectionAnalysis.isFailure ? (failStreak?.count ?? 0) : 0,
          );
          this.finalAnswerGuard.observeToolResult(toolName, executionResult.result, toolArgs);
          this.planManager.recordToolEvidence(toolName, toolArgs, executionResult.result, {
            granted: executionResult.permission?.status === 'granted',
            requestId: executionResult.permission?.requestId,
          });
          this.repositoryMap.observeToolResult(toolName, toolArgs, executionResult.result);
          if (sideEffect && !isToolResultFailure(executionResult.result)) {
            this.dynamicContextCache.invalidate();
          }
          if (isMutationTool(toolName) || hasObservedMutation(toolName, executionResult.result)) {
            this.editToolCallsInTurn++;
          }
          if (hasObservedMutation(toolName, executionResult.result)) {
            if (this.lastCommandExecutionState) {
              this.lastCommandExecutionState.filesModifiedSince++;
            }
            const mutatedFiles = observedMutationFiles(toolName, toolArgs, executionResult.result);
            this.lastMutationForInvestigation = {
              toolName,
              args: { ...toolArgs },
              result: { ...executionResult.result },
              files: mutatedFiles,
            };
            for (const file of mutatedFiles) this.targetFilesModifiedInTurn.add(file);
            const mutatedPath = mutatedFiles[0] || '';
            const blast = executionResult.result?.blastRadius;
            // ponytail: replace_text carrying only comment/note changes bypasses the test gate.
            const oldBlock = toolName === 'replace_text'
              ? String(toolArgs?.oldText ?? toolArgs?.old_text ?? toolArgs?.TargetContent ?? toolArgs?.targetContent ?? toolArgs?.searchContent ?? toolArgs?.searchText ?? '')
              : '';
            const newBlock = toolName === 'replace_text'
              ? String(toolArgs?.newText ?? toolArgs?.new_text ?? toolArgs?.ReplacementContent ?? toolArgs?.replacementContent ?? toolArgs?.replaceWith ?? '')
              : '';
            const commentOnlyEdit = toolName === 'replace_text' && Boolean(newBlock)
              && isCommentOnlyChange(oldBlock, newBlock);
            this.verificationPolicy.recordModification(mutatedPath, {
              impactedTestSuites: blast?.impactedTestSuites,
              risk: blast?.risk,
              commentOnly: commentOnlyEdit,
            });
            // ponytail: move_file is fs.rename — content identical by construction.
            if (toolName === 'move_file' && !isToolResultFailure(executionResult.result)) {
              this.verificationPolicy.recordContentPreservedMove(
                String(toolArgs?.sourcePath || ''),
                String(toolArgs?.targetPath || ''),
              );
            }
            const blastRisk = typeof blast?.risk === 'string' ? blast.risk.toUpperCase() : undefined;
            if (blastRisk === 'CRITICAL') this.maxEditBlastRisk = 'CRITICAL';
            else if (blastRisk === 'HIGH' && this.maxEditBlastRisk !== 'CRITICAL') this.maxEditBlastRisk = 'HIGH';
            // Case 2 — high-risk mutation: persist the thought behind a
            // HIGH/CRITICAL-blast or sensitive-path edit for audit/rollback.
            const sensitiveTouched = mutatedFiles.some((f) => !isNonExecutableFile(f) && isSensitivePath(f));
            if (blastRisk === 'CRITICAL' || blastRisk === 'HIGH' || sensitiveTouched) {
              this.persistStepReasoning(session, this._latestReasoning?.thought, {
                highRisk: true,
                highRiskTrigger: `blast-${(blastRisk || 'sensitive-path').toLowerCase()}:${mutatedPath}`,
                step,
                turn,
              });
            }
            const blastConsumers = blast?.directConsumers || blast?.callers || [];
            if (Array.isArray(blastConsumers) && blastConsumers.length > 0) this.editTouchedCallers = true;
            hasSubmittedSolution = false;
            hasReportedFindings = false;
            reportedFindingsMarkdown = '';
            if (mutatedPath) {
              if (isScratchFilePath(mutatedPath)) {
                this.ephemeralScratchFiles.add(mutatedPath);
              }
              this.pipelinedDispatcher.triggerSpeculativeDiagnostics(mutatedPath, this._workspace);
            }
          }
          if (toolName === 'run_command') {
            const regressionEvidence = executionResult.result.regressionEvidence;
            const commandExecuted = executionResult.result?.processStarted !== false
              && executionResult.result?.commandOutcome !== 'blocked_preflight'
              && typeof executionResult.result?.exitCode === 'number';
            if (commandExecuted) {
              const cmdSuccess = !isToolResultFailure(executionResult.result) && executionResult.result.exitCode === 0;
              // Coverage report (lcov/cobertura/…) when the repo produces one:
              // read once after a green verification command; any failure to
              // locate or parse it is fail-open (evaluator ignores absence).
              let fileCoverage: FileCoverage[] | undefined;
              let coverageSource: string | undefined;
              if (cmdSuccess && isVerificationCommand(commandForAttribution)) {
                try {
                  const report = readCoverageReport(this._workspace.rootDir);
                  if (report) {
                    fileCoverage = report.files;
                    coverageSource = report.source;
                  }
                } catch {
                  // Fail-open: stdout parsing still applies without the report.
                }
              }
              this.verificationPolicy.recordVerification(
                commandForAttribution,
                cmdSuccess,
                String(executionResult.result.stdout || executionResult.result.stderr || '').slice(0, 240),
                executionResult.result.exitCode,
                {
                  hasNewFailures: regressionEvidence?.classification === 'new_failures_detected' ? true : undefined,
                  // Full tails (not the 240-char digest) so the coverage
                  // evaluator can parse runner summaries and zero-test runs.
                  stdout: typeof executionResult.result.stdout === 'string' ? executionResult.result.stdout.slice(-20000) : undefined,
                  stderr: typeof executionResult.result.stderr === 'string' ? executionResult.result.stderr.slice(-20000) : undefined,
                  ...(fileCoverage ? { fileCoverage, coverageSource } : {}),
                },
              );
            }
            if (commandExecuted && isVerificationCommand(commandForAttribution) && this.targetFilesModifiedInTurn.size > 0) {
              const isVerifOk = !isToolResultFailure(executionResult.result) && executionResult.result.exitCode === 0;
              for (const modifiedF of this.targetFilesModifiedInTurn) {
                if (isVerifOk) {
                  this.cognitiveHarness.fileFixationTracker.recordSuccess(modifiedF);
                } else {
                  this.cognitiveHarness.fileFixationTracker.recordFailure(modifiedF, turn, 'Verification command failed');
                }
              }
              // Case 1a — failed verification: keep the thought that led to it.
              if (!isVerifOk) {
                this.persistStepReasoning(session, this._latestReasoning?.thought, {
                  failure: true,
                  failureTrigger: `verification-failed:${commandForAttribution}`,
                  step,
                  turn,
                });
              }
            }
            this.lastCommandExecutionState = {
              command: commandForAttribution,
              success: commandExecuted && !isToolResultFailure(executionResult.result)
                && executionResult.result?.exitCode === 0,
              exitCode: executionResult.result?.exitCode,
              commandOutcome: executionResult.result?.commandOutcome,
              filesModifiedSince: 0,
            };

            // AUTO-CLEANUP: Tự động xóa các file scratch tạm ngay khi lệnh kiểm thử chạy thành công mà không tốn thêm step xóa
            if (commandExecuted && !isToolResultFailure(executionResult.result) && executionResult.result.exitCode === 0) {
              const cmd = commandForAttribution;
              const cleanedFiles: string[] = [];
              for (const scratchFile of Array.from(this.ephemeralScratchFiles)) {
                const baseName = path.basename(scratchFile);
                const normScratch = scratchFile.replace(/\\/g, '/');
                if (cmd.includes(scratchFile) || cmd.includes(normScratch) || cmd.includes(baseName)) {
                  try {
                    const fullPath = path.isAbsolute(scratchFile) ? scratchFile : path.resolve(this._workspace.rootDir, scratchFile);
                    if (fs.existsSync(fullPath)) {
                      fs.unlinkSync(fullPath);
                      cleanedFiles.push(scratchFile);
                    }
                    this.ephemeralScratchFiles.delete(scratchFile);
                    this.targetFilesModifiedInTurn.delete(scratchFile);
                  } catch {}
                }
              }
              if (cleanedFiles.length > 0) {
                const cleanupNotice = `\n[AUTO-CLEANUP]: Automatically cleaned up temporary test files (${cleanedFiles.join(', ')}) after successful tests. You do not need to perform an extra file-deletion step.`;
                const currentResult = executionResult.result;
                const mergedResult = {
                  ...currentResult,
                  stdout: typeof currentResult.stdout === 'string' ? currentResult.stdout + cleanupNotice : currentResult.stdout,
                  output: typeof currentResult.output === 'string' ? currentResult.output + cleanupNotice : currentResult.output,
                  autoCleanedFiles: cleanedFiles,
                  cleanupNotice: cleanupNotice.trim(),
                };
                executionResult.result = mergedResult;
              }
            }
          }
          if (toolName === 'manage_task' && String(toolArgs.Action || toolArgs.action || '').toLowerCase() === 'status') {
            const completion = executionResult.result?.commandCompletion;
            const completedCommand = typeof completion?.command === 'string' ? completion.command : '';
            if (completion?.completed === true && isVerificationCommand(completedCommand)) {
              const passed = completion.terminalStatus === 'completed'
                && completion.commandOutcome === 'succeeded'
                && completion.exitCode === 0
                && !isToolResultFailure(executionResult.result);
              this.verificationPolicy.recordVerification(
                completedCommand,
                passed,
                String(executionResult.result?.logTail || '').slice(0, 240),
                typeof completion.exitCode === 'number' ? completion.exitCode : undefined,
                typeof executionResult.result?.logTail === 'string' && executionResult.result.logTail
                  ? { stdout: executionResult.result.logTail.slice(-20000) }
                  : undefined,
              );
              if (this.targetFilesModifiedInTurn.size > 0) {
                for (const modifiedFile of this.targetFilesModifiedInTurn) {
                  if (passed) this.cognitiveHarness.fileFixationTracker.recordSuccess(modifiedFile);
                  else this.cognitiveHarness.fileFixationTracker.recordFailure(modifiedFile, turn, 'Background verification command failed');
                }
              }
              this.lastCommandExecutionState = {
                command: completedCommand,
                success: passed,
                exitCode: completion.exitCode,
                commandOutcome: completion.commandOutcome,
                filesModifiedSince: 0,
              };
            }
          }
          if (toolName === 'get_diagnostics') {
            const isClean = !isToolResultFailure(executionResult.result)
              && executionResult.result?.clean === true
              && (!executionResult.result?.totalErrors || executionResult.result?.totalErrors === 0);
            const target = toolArgs.path ? `get_diagnostics (${toolArgs.path})` : 'get_diagnostics';
            const detail = isClean
              ? `Diagnostics clean (0 errors, ${executionResult.result?.totalWarnings || 0} warnings)`
              : `Diagnostics found ${executionResult.result?.totalErrors || 1} error(s)`;
            this.verificationPolicy.recordVerification(
              target,
              isClean,
              detail,
              isClean ? 0 : 1,
              { tier: 'typecheck' },
            );
          }
          if (toolName === 'run_test_suite' && !toolArgs.useScratchWorkspace) {
            const passed = executionResult.result?.isPassed === true
              && executionResult.result?.exitCode === 0
              && !isToolResultFailure(executionResult.result);
            this.verificationPolicy.recordVerification(
              String(executionResult.result?.commandExecuted || toolArgs.command || 'run_test_suite'),
              passed,
              String(executionResult.result?.summary || '').slice(0, 240),
              executionResult.result?.exitCode,
              { tier: 'full_test' },
            );
          }
          if (toolName === 'submit_solution' && !isToolResultFailure(executionResult.result)) {
            hasSubmittedSolution = true;
            this.cleanupEphemeralScratchFiles();
            const summaryText = String(toolArgs.summary || '').trim();
            const rootCauseText = toolArgs.rootCause ? String(toolArgs.rootCause).trim() : '';
            const filesModifiedList = Array.isArray(toolArgs.filesModified)
              ? toolArgs.filesModified.map((f: any) => String(f).trim()).filter(Boolean)
              : [];
            const verificationText = toolArgs.verificationEvidence ? String(toolArgs.verificationEvidence).trim() : '';

            // Xây dựng bản tóm tắt giải pháp giàu cấu trúc để dự phòng và hiển thị
            const richSummaryParts: string[] = [];
            if (summaryText) richSummaryParts.push(summaryText);
            if (rootCauseText) richSummaryParts.push(`\n**Root Cause:**\n${rootCauseText}`);
            if (filesModifiedList.length > 0) {
              richSummaryParts.push(`\n**Modified Files:**\n${filesModifiedList.map((f: string) => `- \`${f}\``).join('\n')}`);
            }
            if (verificationText) {
              richSummaryParts.push(`\n**Verification Evidence:**\n\`${verificationText}\``);
            }
            submittedSolutionSummary = richSummaryParts.length > 0 ? richSummaryParts.join('\n') : summaryText;

          }
          if (toolName === 'report_investigation_findings' && !isToolResultFailure(executionResult.result)) {
            hasReportedFindings = true;
            reportedFindingsMarkdown = String(toolArgs.userFacingReport || '').trim();

          }
          if (toolName === 'formulate_and_verify_hypothesis' && !isToolResultFailure(executionResult.result)) {
            const hId = executionResult.result?.hypothesisId || 'H';
            const hStatus = executionResult.result?.status;
            if (hStatus === 'validated') {
              this.verificationPolicy.recordVerification(
                `hypothesis_${hId}`,
                true,
                String(toolArgs.statement || 'Hypothesis verified').slice(0, 240),
                0,
              );
            } else if (hStatus === 'refuted' || hStatus === 'falsified') {
              // Case 1b — falsified hypothesis: keep the thought for post-mortem.
              this.persistStepReasoning(session, this._latestReasoning?.thought, {
                failure: true,
                failureTrigger: `hypothesis-${hStatus}:${hId}`,
                step,
                turn,
              });
              const rollbackOutcome = await this.rollbackOrchestrator.rollbackOnFalsifiedHypothesis(
                hId,
                this.hypothesisTracker,
              ).catch(() => undefined);
              if (rollbackOutcome?.rolledBack && executionResult.result && typeof executionResult.result === 'object') {
                try {
                  if (Object.isExtensible(executionResult.result)) {
                    executionResult.result._system_hypothesis_rollback = rollbackOutcome.guidancePrompt;
                  } else {
                    executionResult.result = {
                      ...executionResult.result,
                      _system_hypothesis_rollback: rollbackOutcome.guidancePrompt,
                    };
                  }
                } catch { }
              }
            }
          }

          if (reflectionAnalysis.isFailure) {
            CLI.renderReflectionAlert(reflectionAnalysis.consecutiveFailures, reflectionAnalysis.advice);
            if (reflectionAnalysis.detectiveReport
              && this.reflectionEngine.shouldRenderDetectiveReport(reflectionAnalysis.detectiveReport)) {
              // Lược bỏ edge case lặp: cùng fingerprint (defect+location) thì không render lại khối RCA
              CLI.renderErrorDetectiveReport(reflectionAnalysis.detectiveReport);
            }
            this.kernel?.ctx.events.emit('tool:error', toolName, executionResult.result);
          } else if (toolName === 'run_command' && executionResult.result?.exitCode === 0) {
            this.reflectionEngine.reset();
            if (isVerificationCommand(commandForAttribution)) {
              const lastCp = this.checkpointManager.getLastCheckpoint();
              if (lastCp) {
                this.rollbackOrchestrator.markGreenCheckpoint(lastCp);
              }
            }
          }

          const activeHypothesis = this.hypothesisTracker.getActiveHypothesis();
          const falsifiedCount = this.hypothesisTracker.getFalsifiedHypotheses().length;
          const cognitiveBrake = this.cognitiveHarness.evaluateCognitiveBrake({
            consecutiveFailures: reflectionAnalysis.consecutiveFailures,
            hypothesisFailedCount: falsifiedCount,
            currentHypothesis: activeHypothesis?.statement,
          });

          if (cognitiveBrake.active) {
            CLI.renderCognitiveBrake(cognitiveBrake.reason || 'Branch Pruning', cognitiveBrake.recommendedPivot);
            if (activeHypothesis) {
              this.hypothesisTracker.markFalsified(activeHypothesis.id, cognitiveBrake.reason || 'Branch Pruning');
              const rollbackOutcome = await this.rollbackOrchestrator.rollbackOnFalsifiedHypothesis(
                activeHypothesis.id,
                this.hypothesisTracker,
              ).catch(() => undefined);
              if (rollbackOutcome?.rolledBack && executionResult.result && typeof executionResult.result === 'object') {
                try {
                  if (Object.isExtensible(executionResult.result)) {
                    executionResult.result._system_hypothesis_rollback = rollbackOutcome.guidancePrompt;
                  } else {
                    executionResult.result = {
                      ...executionResult.result,
                      _system_hypothesis_rollback: rollbackOutcome.guidancePrompt,
                    };
                  }
                } catch { }
              }
            }
          }

          const progressDecision = this.progressGuard.observe({
            toolName,
            args: toolArgs,
            result: executionResult.result,
          });
          if (progressDecision.message && typeof executionResult.result === 'object' && executionResult.result !== null) {
            try {
              if (Object.isExtensible(executionResult.result)) {
                (executionResult.result as any).trajectoryIntervention = progressDecision.message;
              } else {
                executionResult.result = {
                  ...executionResult.result,
                  trajectoryIntervention: progressDecision.message,
                };
              }
            } catch { }
          }

          const processIntervention = this.processFailureDetector.observe({
            toolName,
            args: toolArgs,
            result: executionResult.result,
          });
          if (processIntervention && typeof executionResult.result === 'object' && executionResult.result !== null) {
            try {
              const interventionMsg = `${processIntervention.message}\n👉 Suggested action: ${processIntervention.suggestedAction}`;
              if (Object.isExtensible(executionResult.result)) {
                (executionResult.result as any).processFailureIntervention = interventionMsg;
              } else {
                executionResult.result = {
                  ...executionResult.result,
                  processFailureIntervention: interventionMsg,
                };
              }
            } catch { }
          }

          const commandText = commandForAttribution;
          const failureInvestigation = toolName === 'run_command'
            && isVerificationCommand(commandText)
            && reflectionAnalysis.isFailure
            && executionResult.result?.regressionEvidence?.classification !== 'pre_existing_out_of_scope'
            ? buildFailureInvestigationBrief({
                command: commandText,
                result: executionResult.result,
                recentMutation: this.lastMutationForInvestigation,
              })
            : undefined;
          if (failureInvestigation && executionResult.result && typeof executionResult.result === 'object') {
            try {
              if (Object.isExtensible(executionResult.result)) {
                executionResult.result.failureInvestigation = failureInvestigation;
              } else {
                executionResult.result = { ...executionResult.result, failureInvestigation };
              }
            } catch { }
          }

          // SCAFFOLD-CEGIS & Domain Intent Drift Detection
          const domainIntentIntervention = this.domainIntentGuardian.observeToolCall({
            toolName,
            args: toolArgs,
          });
          if (domainIntentIntervention && typeof executionResult.result === 'object' && executionResult.result !== null) {
            try {
              const driftMsg = `${domainIntentIntervention.message}\n👉 Course-correction guidance: ${domainIntentIntervention.courseCorrectionGuidance}`;
              if (Object.isExtensible(executionResult.result)) {
                (executionResult.result as any).domainIntentIntervention = driftMsg;
              } else {
                executionResult.result = {
                  ...executionResult.result,
                  domainIntentIntervention: driftMsg,
                };
              }
            } catch { }
          }

          const isMutatingOrVerification = ['write_file', 'replace_text', 'apply_patch', 'create_file', 'delete_file', 'move_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'submit_solution'].includes(toolName)
            || (toolName === 'run_command' && isVerificationCommand(commandForAttribution));
          let lspPreExecutionWarning: string | undefined;
          if (isMutatingOrVerification && !isToolResultFailure(executionResult.result)) {
            const mutFiles = observedMutationFiles(toolName, toolArgs, executionResult.result);
            for (const targetStr of mutFiles) {
              this.targetFilesModifiedInTurn.add(targetStr);
              if (isScratchFilePath(targetStr)) this.ephemeralScratchFiles.add(targetStr);
            }
            // Pre-Execution LSP Diagnostics Hook (QLCoder arXiv:2511.08462v5)
            const codeFiles = mutFiles.filter((f) => /\.(ts|tsx|js|jsx|py)$/i.test(f));
            if (codeFiles.length > 0) {
              try {
                const syntaxDiags = await CodeSyntaxValidator.validateFiles(codeFiles, this._workspace);
                const errors = syntaxDiags.filter((d: any) => d.category === 'error' || !d.category);
                if (errors.length > 0) {
                  lspPreExecutionWarning = `⚠️ [PRE-EXECUTION LSP HOOK]: Detected ${errors.length} syntax/compile error(s) in modified file(s):\n` +
                    errors.slice(0, 3).map((e: any) => `  • ${e.file}:${e.line} - ${e.message}`).join('\n') +
                    `\n👉 ACTION REQUIRED: Fix these syntax/type errors immediately before running verification or submitting.`;
                  if (executionResult.result && typeof executionResult.result === 'object') {
                    executionResult.result.lspPreExecutionWarning = lspPreExecutionWarning;
                  }
                }
              } catch {}
            }
          }

          // Hiển thị Cây kế hoạch nếu có cập nhật từ planning tools
          if (['create_plan', 'update_plan_task'].includes(toolName) && this.planManager.hasPlan()) {
            if (!this._collapsePreferences.compactSteps) {
              CLI.renderPlan(this.planManager.getTasks());
            }
          }

          // Ghi Tool Result vào Session (kèm Reflection Prompt hướng dẫn nếu có lỗi)
          if (executionResult.result?._untrusted_context?.quarantined && executionResult.result?._untrusted_context?.warning) {
            CLI.renderReflectionAlert(1, executionResult.result._untrusted_context.warning);
          }

          const payloadToRecord = {
            ...executionResult.result,
            ...(executionResult.result?._untrusted_context?.warning
              ? { _system_untrusted_injection_warning: executionResult.result._untrusted_context.warning }
              : {}),
            ...(lspPreExecutionWarning
              ? { _system_pre_execution_lsp_warning: lspPreExecutionWarning }
              : {}),
            ...(executionResult.guardianDiagnosis?.errorAs200Unmasked
              ? { _system_guardian_unmasked_error: `[GUARDIAN UNMASKED ERROR]: Tool returned HTTP 200 / success but contained embedded error: "${executionResult.guardianDiagnosis.message}".` }
              : {}),
            ...(executionResult.guardianDiagnosis && isToolResultFailure(executionResult.result)
              ? { _system_guardian_recovery: `[GUARDIAN RECOVERY GUIDANCE]: Category: ${executionResult.guardianDiagnosis.category}. Action: ${executionResult.guardianDiagnosis.recoveryAction}${executionResult.guardianDiagnosis.suggestedAlternative ? ` Recommended alternative: ${executionResult.guardianDiagnosis.suggestedAlternative}` : ''}` }
              : {}),
            ...(reflectionAnalysis.reflectionPrompt
              ? { _system_reflection_prompt: reflectionAnalysis.reflectionPrompt }
              : {}),
            ...(failureInvestigation
              ? { _system_failure_investigation: failureInvestigation }
              : {}),
            ...(cognitiveBrake.active
              ? { _system_cognitive_brake: `🛑 [COGNITIVE BRAKE ACTIVATED]: ${cognitiveBrake.reason}. ${cognitiveBrake.recommendedPivot}` }
              : {}),
            ...(progressDecision.message
              ? { _system_loop_guard: progressDecision.message }
              : {}),
          };

          const sanitizedPayloadToRecord = await sanitizeToolResultPayload(
            toolName,
            payloadToRecord,
            { workspaceRoot: this._workspace?.rootDir },
          );
          session.addToolResultWithId(toolName, sanitizedPayloadToRecord, toolCallId);
          if (toolName === 'run_command' && isVerificationCommand(commandForAttribution)
            && mutationBeforeCommand && !mutationBeforeCommand.hasMutations
            && typeof executionResult.result?.exitCode === 'number') {
            await captureCommandBaseline(session, turn, commandForAttribution, executionResult.result, this._workspace);
          }
          if (hasObservedMutation(toolName, executionResult.result)) {
            invalidatePhaseOnMutation(session, turn);
          }
          const verificationCommand = toolName === 'get_diagnostics'
            ? 'get_diagnostics'
            : String(executionResult.result?.commandExecuted || commandForAttribution || 'run_test_suite');
          const executedVerification = (toolName === 'run_command' && isVerificationCommand(verificationCommand)
            && typeof executionResult.result?.exitCode === 'number'
            && executionResult.result?.processStarted !== false
            && executionResult.result?.commandOutcome !== 'blocked_preflight')
            || (toolName === 'get_diagnostics' && !executionResult.result?.errorCode)
            || (toolName === 'run_test_suite' && !toolArgs.useScratchWorkspace
              && typeof executionResult.result?.exitCode === 'number'
              && !executionResult.result?.errorCode);
          if (executedVerification && getTurnCompletionState(session, turn).hasMutations) {
            recordImplementationCompleted(session, turn, verificationCommand);
            recordVerificationOutcome(
              session,
              turn,
              verificationCommand,
              !isToolResultFailure(executionResult.result)
                && (toolName === 'get_diagnostics' || executionResult.result.exitCode === 0)
                && (toolName !== 'get_diagnostics' || executionResult.result?.clean === true)
                && (toolName !== 'run_test_suite' || executionResult.result?.isPassed === true),
              this.verificationPolicy.canComplete().allowed,
            );
          }
          if (this.loopOptions?.enableRepositoryMemory !== false) {
            await this.repositoryMemory.observeToolResult(session, toolName, toolArgs, executionResult.result, session.seq).catch(() => { });
          }
          this.reliableToolOrchestrationTelemetry.recordExecution(reliableRouteDecision, toolName, executionResult.result);
          this.trajectorySteps.push({
            toolName,
            args: toolArgs,
            success: !isToolResultFailure(executionResult.result),
            signature: `${toolName}:${JSON.stringify(toolArgs || {}).slice(0, 80)}`,
          });
          if (this.trajectorySteps.length > 20) this.trajectorySteps.shift();

          const cmdStr = toolName === 'run_command'
            ? commandForAttribution
            : String(toolArgs?.command || toolArgs?.script || toolArgs?.code || toolArgs?.filePath || '');
          const isVerifOrReproCommand = isVerificationCommand(cmdStr)
            || /(?:node|tsx|npx\s+tsx|python(?:3)?(?:\.exe)?|pytest|cargo|go|dotnet)\b.*(?:scratch|repro|test)/i.test(cmdStr)
            || (toolName === 'run_node_script' && /(?:scratch|repro|test)/i.test(cmdStr));
          if ((toolName === 'run_command' || toolName === 'run_node_script') && isVerifOrReproCommand) {
            const isFailure = typeof executionResult.result?.exitCode === 'number'
              && executionResult.result.exitCode !== 0
              && executionResult.result?.processStarted !== false
              && executionResult.result?.commandOutcome !== 'blocked_preflight'
              && !['COMMAND_NOT_FOUND', 'COMMAND_TIMEOUT', 'COMMAND_RESOURCE_LIMIT', 'PERMISSION_DENIED', 'COMMAND_NOT_ALLOWED'].includes(String(executionResult.result?.errorCode || ''));
            if (isFailure) {
              this.verificationPolicy.recordReproductionAttempt(cmdStr, true);
            }
          }
          this.lastToolExecution = {
            toolName,
            result: executionResult.result,
            guardianDiagnosis: executionResult.guardianDiagnosis,
          };
          if (
            ['read_file', 'view_file', 'read_compressed_code'].includes(toolName)
            && executionResult.result
            && !executionResult.result.error
            && executionResult.result.success !== false
          ) {
            const inspectedTarget = String(
              toolArgs?.path || toolArgs?.filePath || toolArgs?.file_path || executionResult.result.path || ''
            ).trim();
            if (inspectedTarget) {
              const normalized = inspectedTarget.replace(/\\/g, '/').toLowerCase();
              this.sessionInspectedFiles.add(normalized);
            }
          }
          // Tool-level circuit breaker: track external tools that failed due to rate limits or quota exhaustion
          const execError = String(executionResult.result?.error || executionResult.result?.message || executionResult.result?.stderr || '');
          const isToolRateLimited = executionResult.result?.errorCode === 'RATE_LIMIT_EXCEEDED'
            || executionResult.result?.errorCode === 'QUOTA_EXCEEDED'
            || executionResult.result?.errorCode === 'RESOURCE_EXHAUSTED'
            || /\b(?:429\s+Too\s+Many\s+Requests|rate\s*limit|quota\s*exceeded|resource_exhausted)\b/i.test(execError);
          if (isToolRateLimited) {
            this.circuitBreakerTrippedTools.add(toolName);
          }
          if (readPartition && partitionStartIndex !== undefined) {
            readBatchToolDurationMs.set(
              partitionStartIndex,
              (readBatchToolDurationMs.get(partitionStartIndex) || 0) + executionResult.durationMs,
            );
          }
          if (readPartition && partitionEndIndex === callIndex && partitionStartIndex !== undefined) {
            const measuredBatchDurationMs = readPartition.mode === 'concurrent-read'
              ? (readBatchDurationMs.get(partitionStartIndex) || 0)
              : (readBatchToolDurationMs.get(partitionStartIndex) || 0);
            const estimatedSerialDurationMs = readBatchToolDurationMs.get(partitionStartIndex) || measuredBatchDurationMs;
            const snapshotChangedFiles = partitionStartIndex !== undefined
              ? readBatchSnapshotMismatch.get(partitionStartIndex)
              : undefined;
            if (snapshotChangedFiles && snapshotChangedFiles.length > 0) {
              this.pendingSnapshotNudge = formatSnapshotNudge(snapshotChangedFiles);
            }
            const batchTelemetry = {
              mode: 'read-tool-batch',
              executionMode: readPartition.mode,
              count: readPartition.calls.length,
              toolCallIds: readPartition.calls.map((item) => item.id),
              originalIndexes: readPartition.calls.map((item) => item.index),
              durationMs: measuredBatchDurationMs,
              estimatedSerialDurationMs,
              savedMs: Math.max(0, estimatedSerialDurationMs - measuredBatchDurationMs),
              persistenceWrites: deferReadPersistence ? 1 : readPartition.calls.length,
              snapshotConsistent: !snapshotChangedFiles || snapshotChangedFiles.length === 0,
              ...(snapshotChangedFiles && snapshotChangedFiles.length > 0
                ? { snapshotChangedFiles }
                : {}),
            };
            session.append('control/decision', { turn, step, controlDecision: batchTelemetry });
            this.kernel?.ctx.events.emit('tools:batch', batchTelemetry);
            if (readPartition.mode === 'concurrent-read' && readPartition.calls.length > 1) {
              parallelBatchCount++;
              parallelTotalTools += readPartition.calls.length;
              parallelDurationMs += measuredBatchDurationMs;
              parallelSavedMs += batchTelemetry.savedMs;
              CLI.renderParallelBatchSummary(readPartition.calls.length, measuredBatchDurationMs, batchTelemetry.savedMs);
            }
          }
          if (effect) {
            const outcome = executionResult.result.error || executionResult.result.errorCode ? 'error' : 'success';
            this.effectLedger.commit(effect.id, outcome);
          }
          if (!deferReadPersistence || partitionEndIndex === callIndex) {
            await this.persistSession(session);
          }

          if (progressDecision.shouldStop) {
            strategyChangeRequired = { toolName, repetitionCount: progressDecision.repetitionCount };
          }

          // Explicit user denial ([n]/Esc/Ctrl+C at the permission prompt):
          // stop dispatching further tools this step; the turn ends below
          // instead of letting the model route around the denial.
          if (executionResult.result?.deniedByUser === true) {
            userDeniedPermission = {
              toolName,
              detail: String(
                executionResult.result?.error || executionResult.result?.summary || executionResult.result?.errorCode || 'permission denied',
              ).slice(0, 240),
            };
            break;
          }
          // Post-submit lock: further calls are blocked by design. Finalize
          // from the submitted summary below instead of burning another
          // model round trip on calls that can never execute.
          if (executionResult.result?.errorCode === 'POST_SUBMISSION_TOOL_CALL_BLOCKED' && submittedSolutionSummary) {
            postSubmissionBlocked = true;
            break;
          }
        }

        const stepReason = toolBatchCancelled
          ? 'cancelled-before-dispatch'
          : strategyChangeRequired
            ? 'strategy-change-requested'
            : 'tool-results-recorded';
        consecutiveNoProgressStrategyChanges = strategyChangeRequired
          ? consecutiveNoProgressStrategyChanges + 1
          : 0;
        const parallelToolExecution = parallelBatchCount > 0 ? {
          batchCount: parallelBatchCount,
          totalTools: parallelTotalTools,
          durationMs: parallelDurationMs,
          savedMs: parallelSavedMs,
        } : undefined;
        session.append('step/end', {
          turn,
          step,
          reason: stepReason,
          ...(parallelToolExecution ? { parallelToolExecution } : {}),
        });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: stepReason,
        });

        // The divider is structural navigation, not step detail: keep it visible
        // in compact mode so consecutive steps remain scannable.
        CLI.renderStepFooter();
        this.kernel?.ctx.events.emit('step:after', step);

        if (strategyChangeRequired) {
          CLI.renderReflectionAlert(
            consecutiveNoProgressStrategyChanges,
            `Tool ${strategyChangeRequired.toolName} returned the same observation ${strategyChangeRequired.repetitionCount} times. The model must choose a different strategy on the next step.`,
          );
        }

        if (toolBatchCancelled) {
          const cancellationMessage = 'Agent stopped: cancellation requested. Tool calls not yet dispatched were recorded as aborted.';
          await CLI.renderExecutionStopped(cancellationMessage, 'CANCELLED');
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'cancelled');
          this.goalManager.disarm();
          return cancellationMessage;
        }

        if (userDeniedPermission) {
          const denialMessage = `Denied: ${userDeniedPermission.toolName} — turn ended, awaiting your direction.`;
          await CLI.renderExecutionStopped(denialMessage, 'PERMISSION_DENIED_BY_USER');
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'permission-denied-by-user');
          this.goalManager.disarm();
          return denialMessage;
        }

        // submit_solution already contains a comprehensive, evidence-backed
        // summary. Reusing it avoids an otherwise redundant provider request
        // whose only purpose is to restate the same result.
        const isArchQuery = detectArchitectureAnalysisIntent(turnUserRequest).isArchitectureQuery;
        const isSummarySufficient = isComprehensiveSubmissionSummary(submittedSolutionSummary || '');
        const enableSubmitAutoFinalization = this.loopOptions?.enableSubmitAutoFinalization
          ?? envFeatureEnabled('MINUS_SUBMIT_AUTO_FINALIZATION', true);
        const isReadOnlySubmission = !getTurnCompletionState(session, turn).hasMutations;
        if (
          (!isArchQuery || isReadOnlySubmission)
          && hasSubmittedSolution
          && submittedSolutionSummary
          && (isSummarySufficient || isReadOnlySubmission || postSubmissionBlocked)
          && enableSubmitAutoFinalization
        ) {
          const finalAnswer = stripSystemPromptEcho(submittedSolutionSummary!) || submittedSolutionSummary!;
          CLI.renderModelAction('final_answer');
          await CLI.renderFinalAnswer(finalAnswer);
          this.kernel?.ctx.events.emit('model:final_answer', finalAnswer);
          session.addModelMessage({ text: finalAnswer });
          await this.persistSession(session);
          if (isGoal && (!this.planManager.hasPlan() || this.planManager.isAllTasksCompleted())) {
            try {
              this.goalManager.complete(this.planManager);
            } catch {
              this.goalManager.disarm();
            }
          } else {
            this.goalManager.disarm();
          }
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');
          return finalAnswer;
        }

        if (
          strategyChangeRequired
          && consecutiveNoProgressStrategyChanges >= maxNoProgressStrategyChanges
        ) {
          const enableNoProgressTermination = (this.loopOptions?.enableNoProgressTermination
            ?? envFeatureEnabled('MINUS_ENABLE_NO_PROGRESS_TERMINATION', false)) === true;

          if (enableNoProgressTermination) {
            const noProgressMessage = `Agent stopped: the model repeated tool ${strategyChangeRequired.toolName} without progress and ignored ${maxNoProgressStrategyChanges} consecutive strategy-change requests. The turn was ended explicitly to prevent an infinite loop.`;
            await CLI.renderExecutionStopped(noProgressMessage, 'REPEATED_NO_PROGRESS');
            await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'repeated-no-progress-terminal');
            this.goalManager.disarm();
            return noProgressMessage;
          }

          // Khi cơ chế dừng runtime bị bỏ/tắt: Không dừng execution, thay vào đó bổ sung lời nhắc chiến lược
          // để định hướng model đổi cách tiếp cận và reset lại bộ đếm liên tiếp.
          const loopGuidance = `[SYSTEM LOOP ADVISORY]: Tool '${strategyChangeRequired.toolName}' has returned identical observations ${strategyChangeRequired.repetitionCount} times. Avoid repeating this tool with the same arguments. Please choose an alternative approach, use different tool parameters, or complete the task with existing data.`;
          session.addUserMessage(loopGuidance, 'system');
          await this.persistSession(session);
          consecutiveNoProgressStrategyChanges = 0;
        }

        if (!isMockLLM && process.env.NODE_ENV !== 'test' && this.lastToolExecution && isToolResultFailure(this.lastToolExecution.result || {})) {
          // Pacing delay on tool failure to mitigate LLM API burst rate limiting (429)
          await new Promise((resolve) => setTimeout(resolve, 600));
        }

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 5. Continuation Protocol: Tự động khôi phục khi gặp Turn rỗng (Chống dừng sớm)
      // Reports and submission summaries are candidates, subject to the same gates below.
      if (!hasValidText && !reportedFindingsMarkdown && !submittedSolutionSummary) {
        consecutiveEmptyTurns++;

        if (consecutiveEmptyTurns <= maxEmptyRetries) {
          if (hasReasoning) {
            CLI.renderReflectionAlert(
              consecutiveEmptyTurns,
              hasSubmittedSolution
                ? 'Solution submitted successfully via submit_solution but the model has not produced a text answer yet. Activating Continuation Protocol...'
                : 'Model produced System 2 reasoning but no tool_calls yet. Automatically activating Continuation Protocol...',
            );
            const noteText = hasSubmittedSolution
              ? `[SYSTEM QUALITY DIRECTIVE]: The solution has already been verified and submitted via submit_solution. Do NOT call any further tools. Output your final comprehensive response to the user now in the EXACT SAME LANGUAGE as the user's original request prompt (e.g. Vietnamese if the user asked in Vietnamese). Detail the root cause, files modified with exact paths, code changes, and test verification proof clearly. Do NOT return empty text, placeholder stubs, or robotic confirmation.`
              : '[SYSTEM NOTE]: You completed your internal reasoning monologue but did not provide any tool calls or final user-facing response. Please proceed immediately to execute the next tool call according to your plan or provide the final answer to the user.';
            session.addUserMessage(noteText);
            await this.persistSession(session);
          } else {
            CLI.renderReflectionAlert(
              consecutiveEmptyTurns,
              hasSubmittedSolution
                ? 'Model returned an empty response after submit_solution. Sending a reminder requesting a complete result report...'
                : 'Model returned an empty response. Automatically activating Continuation Protocol to continue the task...',
            );
            const noteText = hasSubmittedSolution
              ? `[SYSTEM QUALITY DIRECTIVE]: The solution has already been verified and submitted via submit_solution. Do NOT call any further tools. Output your final comprehensive response to the user now in the EXACT SAME LANGUAGE as the user's original request prompt (e.g. Vietnamese if the user asked in Vietnamese). Detail the root cause, files modified with exact paths, code changes, and test verification proof clearly. Do NOT return empty text, placeholder stubs, or robotic confirmation.`
              : '[SYSTEM NOTE]: Your last turn produced an empty response with no tool calls and no text. Please continue solving the user request by calling the appropriate tool (e.g. read_file, search_text, replace_text, run_command, create_plan) or concluding the task with a final answer.';
            session.addUserMessage(noteText);
            await this.persistSession(session);
          }

          CLI.renderStepFooter();
          session.append('step/end', { turn, step, reason: 'continuation-requested' });
          await this.persistSession(session);
          await this.agentHooks.run('agent/after-step', {
            ...hookContext,
            reason: 'continuation-requested',
          });
          this.kernel?.ctx.events.emit('step:after', step);
          continue; // TIẾP TỤC VÒNG LẶP, TUYỆT ĐỐI KHÔNG DỪNG VỘI VÃ!
        }

        // Reasoning is not a user-facing answer and must never bypass completion checks.
        if (hasReasoning) {
          const message = 'Agent stopped: the model did not produce a user-facing answer after repeated requests.';
          await CLI.renderExecutionStopped(message, 'MISSING_FINAL_ANSWER');
          CLI.renderStepFooter();
          session.append('step/end', { turn, step, reason: 'missing-final-answer' });
          await this.persistSession(session);
          await this.agentHooks.run('agent/after-step', { ...hookContext, reason: 'missing-final-answer' });
          this.kernel?.ctx.events.emit('step:after', step);
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'missing-final-answer');
          this.goalManager.disarm();
          return message;
        }
      }

      // 6. Nếu model trả về câu trả lời cuối cùng (Final Answer)
      const rawText = response.text ? response.text.trim() : '';
      let finalAnswer = selectFinalAnswer(rawText,
        hasReportedFindings ? reportedFindingsMarkdown : undefined,
        hasSubmittedSolution ? submittedSolutionSummary : undefined);
      consecutiveEmptyTurns = 0;

      const planBlocker = this.planManager.getCompletionBlocker();
      if (planBlocker) {
        consecutivePlanCompletionRejects++;
        const canRetryPlan = consecutivePlanCompletionRejects <= maxPlanCompletionRetries;
        CLI.renderReflectionAlert(
          consecutivePlanCompletionRejects,
          canRetryPlan
            ? `Final Answer was rejected because the execution plan is incomplete. ${planBlocker}`
            : `The model repeatedly tried to finish with an incomplete execution plan. ${planBlocker}`,
        );
        session.addModelMessage({ text: finalAnswer, rawContent: response.rawContent });
        if (canRetryPlan) {
          session.addUserMessage(this.planManager.buildContinuationPrompt(planBlocker), 'system');
        }
        await this.persistSession(session);
        CLI.renderStepFooter();
        const planReason = canRetryPlan
          ? 'incomplete-plan-final-answer'
          : 'incomplete-plan-final-answer-terminal';
        session.append('step/end', { turn, step, reason: planReason });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: planReason,
        });
        this.kernel?.ctx.events.emit('step:after', step);
        if (canRetryPlan) continue;

        const planAllowsReconciliation = Boolean(
          finalAnswer
          && finalAnswer.trim().length > 80
          && !isCompletionStub(finalAnswer)
          && (!initialTurnClassification.requiredCapabilities.includes('edit') || hasSubmittedSolution || hasVerifiedTests)
        );
        if (planAllowsReconciliation) {
          this.planManager.autoReconcileRemainingTasks('Remaining plan tasks auto-reconciled on substantive final answer delivery.');
          CLI.renderReflectionAlert(
            consecutivePlanCompletionRejects,
            `[Auto-Reconciliation]: Automatically reconciled remaining Plan tasks as complete because the model provided a substantive answer. Proceeding to the Completion Gate.`,
          );
        } else {
          const incompletePlanMessage = `Agent stopped explicitly: ${planBlocker} The model ignored ${maxPlanCompletionRetries} plan-continuation requests.`;
          await CLI.renderExecutionStopped(incompletePlanMessage, 'INCOMPLETE_PLAN');
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'incomplete-plan-final-answer-terminal');
          this.goalManager.disarm();
          return incompletePlanMessage;
        }
      }
      consecutivePlanCompletionRejects = 0;

      const completionState = getTurnCompletionState(session, turn);
      const hasCodeMutations = completionState.hasMutations;
      const isExplorationOrReadOnly = !hasCodeMutations && (
        initialTurnClassification.taskClass === 'exploration'
        || initialTurnClassification.phase === 'explore'
        || isReadOnlyRequest(turnUserRequest)
      );
      const codeChangeRequired = !isExplorationOrReadOnly && (
        initialTurnClassification.requiredCapabilities.includes('edit')
        || initialTurnClassification.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE')
      );
      const policyDecision = isSubagent
        ? { allow: true }
        : this.finalAnswerGuard.evaluate(finalAnswer, {
          userRequest: turnUserRequest,
          availableToolNames: this.toolProvider.getAll().map((tool) => tool.name || '').filter(Boolean),
          hasSubmittedSolution,
          hasCodeMutations,
          filesModified: Array.from(this.targetFilesModifiedInTurn),
          workspace: this._workspace,
        });
      const evidenceDecision = (isSubagent || isMockLLM || !isCompletionEvidenceGateEnabled())
        ? { allow: true, reasons: [] }
        : this.completionEvidenceGate.evaluate(finalAnswer, session, {
          turn,
          codeChangeRequired,
          userRequest: turnUserRequest,
          taskClass: initialTurnClassification.taskClass,
          hasReproduction: this.verificationPolicy.hasReproduction(),
        });
      const activeSkills = session.getActiveSkillDecisions().map((decision) => decision.skillId);
      if (this.planManager.getRequirements().verificationRequired && this.planManager.hasPlan()) {
        activeSkills.push('verification-before-completion');
      }
      const verificationDecision = (hasSubmittedSolution || isSubagent || isMockLLM || (!hasCodeMutations && !codeChangeRequired))
        ? { allowed: true }
        : this.verificationPolicy.canComplete(activeSkills, undefined, { userExemptsTesting: isUserExplicitlyExemptingTests(turnUserRequest) });
      const criticDecision = (isSubagent || isMockLLM)
        ? { approved: true, score: 100, invariantViolations: [], lspErrors: [], reasons: [] }
        : this.criticGate.evaluate({
          finalAnswer,
          session,
          workspace: this._workspace,
          hypothesisTracker: this.hypothesisTracker,
          domainGuardian: this.domainIntentGuardian,
          userRequest: turnUserRequest,
          turn,
          hasSubmittedSolution,
          filesModified: completionState.filesModified,
          completionState,
          evidenceDecision,
          risk: initialTurnClassification.risk,
        });
      let ocrDecision: OcrGateDecision = {
        allow: true,
        reason: 'not-applicable',
        blockingFindings: [],
        advisoryFindings: [],
      };
      const priorCompletionGatesAllow = policyDecision.allow
        && criticDecision.approved
        && evidenceDecision.allow
        && verificationDecision.allowed;
      if (!isSubagent && !isMockLLM && priorCompletionGatesAllow) {
        const ocrReview = (this.kernel?.ctx as any)?.ocrReview as OcrReviewService | undefined;
        if (ocrReview) {
          ocrDecision = await ocrReview.evaluateCompletion({
            session,
            filesModified: completionState.filesModified,
            background: turnUserRequest,
            signal: options?.signal,
          });
          await this.persistSession(session);
        }
      }
      let finalAnswerDecision: Omit<FinalAnswerGuardDecision, 'reason'> & { reason?: string } = (isSubagent || isMockLLM)
        ? (policyDecision.allow ? { allow: true } : policyDecision)
        : (!policyDecision.allow
          ? policyDecision
          : (!criticDecision.approved)
            ? {
              allow: false,
              reason: 'unverified-evidence' as const,
              recovery: criticDecision.lspErrors.length ? 'verify-changes' : evidenceDecision.recovery || 'revise-answer',
              continuationPrompt: criticDecision.critiquePrompt,
            }
            : (!evidenceDecision.allow)
              ? {
                allow: false,
                reason: 'unverified-evidence' as const,
                recovery: evidenceDecision.recovery,
                continuationPrompt: evidenceDecision.continuationPrompt,
              }
              : (!hasSubmittedSolution && !verificationDecision.allowed)
                ? {
                  allow: false,
                  reason: 'unverified-evidence' as const,
                  recovery: 'verify-changes',
                  continuationPrompt: `[SYSTEM VERIFICATION GATE]: ${verificationDecision.reason}\nRun an appropriate test/build/lint/typecheck command now, after the latest modification.`,
                }
                : (!ocrDecision.allow)
                  ? {
                    allow: false,
                    reason: 'unverified-evidence' as const,
                    recovery: 'verify-changes',
                    continuationPrompt: ocrDecision.continuationPrompt,
                  }
                  : { allow: true });

      // Apply to every answer-only completion, not just requests recognized by
      // the intent classifier (e.g. a diagnosis may also advertise edit tools).
      const requiresReadOnlySubmission = !hasCodeMutations && !codeChangeRequired && !hasSubmittedSolution;
      if (finalAnswerDecision.allow && requiresReadOnlySubmission) {
        finalAnswerDecision = {
          allow: false,
          reason: 'submission-required',
          continuationPrompt: '[STRONG ADVISORY — READ-ONLY SUBMIT]: Call submit_solution as the final tool with the answer itself in summary before returning a final answer. No code edit or test is required. A report or direct text is not a successful submission.',
        };
      }

      if (!finalAnswerDecision.allow) {
        // Case 1c — completion-gate rejection: keep the thought that produced
        // the rejected answer so the retry can diagnose, not guess.
        this.persistStepReasoning(session, this._latestReasoning?.thought, {
          failure: true,
          failureTrigger: `gate-rejected:${finalAnswerDecision.reason || 'completion-gate'}`,
          step,
          turn,
        });
        {
          consecutiveIncompleteFinals++;
          const canRetryIncompleteFinal = consecutiveIncompleteFinals <= maxIncompleteFinalRetries;
          this.adaptiveReasoning.escalate(finalAnswerDecision.reason || 'completion-gate-rejection');
          const reasoningGuidance = this.adaptiveReasoning.getGuidancePrompt();

          const actionMandate = requiresReadOnlySubmission
            ? '[STRONG ADVISORY — READ-ONLY SUBMIT]: Correct any unsupported claims using existing evidence, then call submit_solution with the actual answer in summary. Inspect only missing evidence if needed; do not invent edits or verification.'
            : buildCompletionRecoveryPrompt({
            reason: finalAnswerDecision.reason,
            recovery: finalAnswerDecision.recovery,
            hasSubmittedSolution,
          });

          const fullContinuationPrompt = [
            actionMandate,
            finalAnswerDecision.continuationPrompt,
            reasoningGuidance,
          ].filter(Boolean).join('\n\n');

          CLI.renderReflectionAlert(
            consecutiveIncompleteFinals,
            canRetryIncompleteFinal
              ? `Final answer did not pass the completion gate (${finalAnswerDecision.reason || 'policy'}). The agent will continue immediately within the current turn.`
              : 'Model keeps returning Final Answers without sufficient evidence, results, or a real blocker. The turn will end with a clear notice.',
          );
          session.addModelMessage({ text: finalAnswer, rawContent: response.rawContent });
          if (canRetryIncompleteFinal && fullContinuationPrompt) {
            session.addUserMessage(fullContinuationPrompt, 'system');
          }
          await this.persistSession(session);
          CLI.renderStepFooter();
          const incompleteFinalReason = canRetryIncompleteFinal
            ? 'incomplete-final-answer'
            : 'incomplete-final-answer-terminal';
          session.append('step/end', { turn, step, reason: incompleteFinalReason });
          await this.persistSession(session);
          await this.agentHooks.run('agent/after-step', {
            ...hookContext,
            reason: incompleteFinalReason,
          });
          this.kernel?.ctx.events.emit('step:after', step);
          if (canRetryIncompleteFinal) continue;

          const incompleteFinalMessage = `Agent stopped: completion remained unresolved after ${consecutiveIncompleteFinals} attempts (${finalAnswerDecision.reason || 'unknown'}).`;
          await CLI.renderExecutionStopped(incompleteFinalMessage, 'NON_TERMINAL_PROGRESS_LIMIT');
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'incomplete-final-answer-terminal');
          this.goalManager.disarm();
          return incompleteFinalMessage;
        }
      }
      consecutiveIncompleteFinals = 0;
      this.adaptiveReasoning.reset();

      // Strip echoed system-prompt paragraphs before the answer reaches the
      // TUI, session history, and downstream consumers. The guard above
      // already evaluated the raw text, so pure-echo answers were rejected
      // for revision before this point.
      const sanitizedFinalAnswer = stripSystemPromptEcho(finalAnswer);
      if (sanitizedFinalAnswer && sanitizedFinalAnswer !== finalAnswer) {
        finalAnswer = sanitizedFinalAnswer;
      }

      if (ocrDecision.allow && ocrDecision.advisoryFindings.length > 0) {
        finalAnswer = [
          finalAnswer,
          '',
          'OpenCodeReview advisories:',
          ...ocrDecision.advisoryFindings.slice(0, 8).map((finding) =>
            `- [${finding.severity.toUpperCase()}] ${finding.path}:${finding.startLine || '?'} — ${finding.content}`,
          ),
        ].join('\n');
      }

      CLI.renderModelAction('final_answer');
      CLI.renderStepFooter();
      await CLI.renderFinalAnswer(finalAnswer);
      this.kernel?.ctx.events.emit('model:final_answer', finalAnswer);

      // Ghi nhận câu trả lời cuối cùng vào Session
      session.addModelMessage({ text: finalAnswer, rawContent: response.rawContent });
      await this.persistSession(session);
      session.append('step/end', { turn, step, reason: 'final-answer' });
      await this.persistSession(session);
      await this.agentHooks.run('agent/after-step', {
        ...hookContext,
        reason: 'final-answer',
      });
      if (isGoal && (!this.planManager.hasPlan() || this.planManager.isAllTasksCompleted())) {
        try {
          this.goalManager.complete(this.planManager);
        } catch {
          this.goalManager.disarm();
        }
      } else {
        this.goalManager.disarm();
      }
      await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed', turnUserRequest, finalAnswer);

      resolveSteerItems(finalAnswer);
      if (!this.drainingInbox && !this.drainScheduled && this.inbox.pending(session.id) > 0) {
        this.drainScheduled = true;
        void this.drainInbox(session, options);
      }

      return finalAnswer;
    }

    // 7. Nếu đạt maxSteps mà chưa hoàn thành
    const timeoutMessage = isGoal
      ? `Agent stopped: Goal execution finished.`
      : !isFinite(effectiveMaxSteps)
        ? `Agent stopped: Dynamic convergence limit reached without final answer.`
        : `Agent stopped: maximum steps (${effectiveMaxSteps}) reached without final answer.`;
    CLI.renderModelAction('max_steps');
    CLI.renderStepFooter();
    await CLI.renderExecutionStopped(timeoutMessage, 'MAX_STEPS_REACHED');
    await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'max-steps-reached');
    this.goalManager.disarm();

    resolveSteerItems(timeoutMessage);
    if (!this.drainingInbox && !this.drainScheduled && this.inbox.pending(session.id) > 0) {
      this.drainScheduled = true;
      void this.drainInbox(session, options);
    }

    return timeoutMessage;
    } finally {
      CLI.finishCompaction('failed');
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      if (claimedSteerItems.length > 0) {
        rejectSteerItems(new Error('Agent turn ended abruptly before steer message could be resolved.'));
      }
      // Preserve the queue for the drain loop when one owns this session (see
      // the break in drainInbox); otherwise clear so no promise hangs forever.
      if (options?.signal?.aborted && (!this.drainingInbox || this.drainingSessionId !== session.id)) {
        this.inbox.clear(session.id, 'Agent execution cancelled.');
      }
    }
  }

  /** Queue a model-visible input and drain it through serialized turns. */
  async submit(
    session: Session,
    text: string,
    source: AgentInputSource = 'human',
    options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal; isRecoveryResume?: boolean },
  ): Promise<string> {
    if (this.drainingInbox && this.drainingSessionId !== session.id) {
      throw new Error('AgentLoop is currently draining another session inbox.');
    }

    const item = this.inbox.enqueue(session.id, text, source);
    session.append('input/queued', {
      inputId: item.id,
      inputText: item.text,
      source: item.source,
    });
    const isRunning = this.drainingInbox || this.runQueues.has(session.id);
    const shouldStartDrain = !isRunning && !this.drainScheduled;
    if (shouldStartDrain) this.drainScheduled = true;
    try {
      await this.persistSession(session);
    } catch (error) {
      item.reject(error);
      if (shouldStartDrain) this.drainScheduled = false;
      throw error;
    }
    if (shouldStartDrain) void this.drainInbox(session, options);
    return item.promise;
  }

  /**
   * Chờ đợi có hỗ trợ Reactive Wakeup (Google Antigravity Standard):
   * Nếu người dùng enqueue tin nhắn mới vào session inbox trong lúc đang ngủ/chờ,
   * hàm sẽ lập tức thức tỉnh (resolve early với { awakenedByQueue: true }) thay vì chờ hết thời gian timeout.
   */
  async sleepWithWakeup(
    sessionId: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<{ awakenedByQueue: boolean; aborted: boolean }> {
    if (signal?.aborted) return { awakenedByQueue: false, aborted: true };
    if (this.inbox.pending(sessionId) > 0) {
      return { awakenedByQueue: true, aborted: false };
    }

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let unsubscribeWakeup: (() => void) | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (unsubscribeWakeup) unsubscribeWakeup();
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };

      timer = setTimeout(() => {
        cleanup();
        resolve({ awakenedByQueue: false, aborted: false });
      }, ms);

      unsubscribeWakeup = this.inbox.onWakeup((enqueuedSessionId) => {
        if (enqueuedSessionId === sessionId) {
          cleanup();
          resolve({ awakenedByQueue: true, aborted: false });
        }
      });

      if (signal) {
        onAbort = () => {
          cleanup();
          resolve({ awakenedByQueue: false, aborted: true });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Restore durable queued inputs and explicitly continue draining them. */
  async resumePending(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal }): Promise<string[]> {
    this.bindSession(session);
    const pendingItems = session.getPendingInputs().map((input) => this.inbox.restore(session.id, input));
    if (pendingItems.length === 0) return [];
    if (!this.drainingInbox && !this.drainScheduled) {
      await this.drainInbox(session, options);
    }
    return Promise.all(pendingItems.map((item) => item.promise));
  }

  setSessionPersistence(sessionPersistence: SessionPersistence): void {
    this.sessionPersistence = sessionPersistence;
  }

  bindSession(session: Session): void {
    this.activeSession = session;
    this.kernel?.ctx.sessions.register(session);
    this.planManager.bindSession(session);
    this.goalManager.bindSession(session);
    this.memoryManager.bindSession(session);
    this.repositoryMemory.bindSession(session);
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    for (const input of session.getPendingInputs()) {
      this.inbox.restore(session.id, input);
    }
  }

  /**
   * Đúc kết một Session thành bản ghi Episodic Memory súc tích
   * Ghi lại mục tiêu, các file đã sửa đổi, kết quả test và kết luận để tái sử dụng ở các phiên sau.
   */
  async summarizeSessionEpisodic(session: Session): Promise<MemoryRecord | null> {
    const events = session.getEvents();
    if (events.length === 0) return null;

    // 1. Tìm mục tiêu ban đầu từ tin nhắn user
    const firstUserEvent = events.find((e) => e.type === 'user/message' && e.data.source !== 'system');
    let objective = '';
    if (firstUserEvent?.data.content?.parts) {
      for (const p of firstUserEvent.data.content.parts) {
        if (typeof p?.text === 'string') {
          // Bỏ phần warm start prefix nếu có
          const rawText = p.text;
          const userIdx = rawText.indexOf('[USER INSTRUCTION]:');
          objective = userIdx >= 0 ? rawText.slice(userIdx + 19).trim() : rawText.trim();
          break;
        }
      }
    }
    if (!objective) objective = 'Programming task';
    const compactObjective = objective.slice(0, 150).replace(/\s+/g, ' ');

    // 2. Thu thập các files đã chỉnh sửa qua tool calls
    const modifiedFiles = new Set<string>();
    let testsPassed = false;
    let testsFailed = false;

    for (const e of events) {
      if (e.type === 'tool/call') {
        const name = e.data.toolName;
        const args = e.data.args || {};
        if (['replace_text', 'write_file', 'patch_file'].includes(name || '')) {
          const p = args.path || args.filePath || args.targetFile;
          if (p && typeof p === 'string') modifiedFiles.add(path.basename(p));
        }
      }
      if (e.type === 'tool/result') {
        const res = e.data.result || {};
        if (typeof res.exitCode === 'number') {
          if (res.exitCode === 0) testsPassed = true;
          else testsFailed = true;
        }
      }
    }

    // 3. Xác định outcome
    const filesList = Array.from(modifiedFiles);
    const verificationOutcome = testsPassed
      ? 'Tests verified successfully (exitCode: 0)'
      : testsFailed
        ? 'Tests not fully passing'
        : filesList.length > 0 ? 'Modified code' : 'Surveyed';

    // 4. Tìm tóm tắt cuối cùng từ model nếu có
    const lastAssistant = [...events].reverse().find((e) => e.type === 'assistant/message');
    let finalSummary = '';
    if (lastAssistant?.data.content?.parts) {
      for (const p of lastAssistant.data.content.parts) {
        if (typeof p?.text === 'string' && p.text.trim()) {
          finalSummary = p.text.slice(0, 160).replace(/\s+/g, ' ');
          break;
        }
      }
    }

    const summaryStatement = `[Session ${session.id.slice(0, 10)}] Objective: "${compactObjective}". Modified files: ${filesList.join(', ') || 'none'}. Result: ${verificationOutcome}.${finalSummary ? ` Summary: ${finalSummary}` : ''}`;

    return this.memoryManager.saveEpisodicSummary(session.id, summaryStatement, {
      outcome: testsPassed ? 'success' : testsFailed ? 'failure' : 'completed',
      filesModified: filesList,
      confidence: testsPassed ? 0.95 : 0.8,
    });
  }

  /**
   * Reset Session an toàn kèm Episodic Epilogue:
   * 1. Đúc kết phiên hiện tại thành Episodic Memory ghi vào ProjectMemoryManager
   * 2. Tạo một Session mới sạch sẽ, giải phóng toàn bộ history tokens cũ
   * 3. Phiên mới sẽ nhận được bản tóm tắt phiên trước qua Warm-Start Digest
   */
  async resetSessionWithEpisodicEpilogue(
    session: Session,
    newSessionId?: string,
  ): Promise<{ episodicRecord: MemoryRecord | null; newSession: Session }> {
    const episodicRecord = await this.summarizeSessionEpisodic(session);
    const newSession = this.kernel
      ? await this.kernel.ctx.sessions.create(newSessionId)
      : new Session(newSessionId);

    this.bindSession(newSession);
    if (this.sessionPersistence) {
      await this.sessionPersistence.save(newSession);
    }

    return { episodicRecord, newSession };
  }

  private async persistSession(session: Session): Promise<void> {
    if (!this.sessionPersistence) return;
    await this.sessionPersistence.save(session);
  }

  /**
   * Completed-turn window compaction: after a turn closes, keep the newest
   * `preserveCompletedTurns` closed turns fully intact and summarize older
   * ones into the rolling synopsis + turn archive only under history-token
   * pressure with material savings. Non-blocking: any failure
   * (or an uncompactable state) leaves the closed turn and history untouched.
   */
  private async maybeCompactCompletedTurnWindow(session: Session): Promise<void> {
    try {
      const config = this.contextCompactor.getConfig();
      if (config.enableCompletedTurnCompaction === false) return;
      const preserve = Math.max(1, Math.floor(config.preserveCompletedTurns ?? 4));
      if (session.getOpenTurn() !== undefined) return;
      if (session.getPendingToolCalls().length > 0) return;
      const completed = session.getCompletedTurnNumbers();
      if (completed.length <= preserve) return;
      const entries = session.getProjectionWithTurns().map((entry) => ({
        message: entry.message,
        turn: entry.turn,
        isSynopsis: entry.isSynopsis,
      }));
      const policy = resolveCompletedTurnCompactionPolicy();
      const tokenConfig = this.getTokenConfig();
      const configuredMaxInput = tokenConfig?.maxInputTokens;
      const maxInputTokens = Number.isFinite(configuredMaxInput) && configuredMaxInput! > 0
        ? configuredMaxInput! : config.maxTotalHistoryTokens;
      const historyTokens = ContextCompactor.countHistoryTokens(entries.map((entry) => entry.message));
      const metadata = this.lastRequestEnvelope?.sessionId === session.id ? this.lastRequestEnvelope.envelope : undefined;
      const envelope = metadata ? { ...metadata, maxInputTokens,
        outputReserveTokens: tokenConfig?.maxOutputTokens ?? metadata.outputReserveTokens,
        history: entries.map((entry) => entry.message) } : undefined;
      const before = envelope ? await this.contextBudgetManager.counter.count(envelope) : undefined;
      const budget = resolveRequestBudget(envelope || {
        maxInputTokens, outputReserveTokens: tokenConfig?.maxOutputTokens || 0,
      });
      if (!hasCompletedTurnPressure(before?.upperBoundTokens ?? historyTokens, budget.targetUsableInputTokens, policy)) return;
      const turnKey = computeRequestValueDigest({ sessionId: session.id, entries, envelope, budget,
        config, policy, plan: this.planManager.getTaskGraph(), count: before,
        completionReason: session.findLatestEventOfType('turn/end')?.data.reason });
      if (this.rejectedTurnCandidateKey === turnKey) return;
      CLI.startCompaction('turn');
      const result = this.contextCompactor.compactCompletedTurnWindow(entries, {
        completedTurns: completed,
        preserveCompletedTurns: preserve,
        plan: this.planManager.getTaskGraph(),
        completionReason: session.findLatestEventOfType('turn/end')?.data.reason,
      });
      const after = envelope ? await this.contextBudgetManager.counter.count({ ...envelope, history: result.messages }) : undefined;
      if (!result.stats.prunedTurnsCount || !result.stats.archivedTurns?.length
        || !hasMaterialCompletedTurnSavings(before?.upperBoundTokens ?? result.stats.originalTokens,
          after?.upperBoundTokens ?? result.stats.compactedTokens, policy)) {
        this.rejectedTurnCandidateKey = turnKey;
        return;
      }
      this.rejectedTurnCandidateKey = undefined;

      const archiveStatus: Record<string, unknown> = {};
      try {
        archiveStatus.archivedTurns = await this.turnMemoryRetriever.archiveTurns(result.stats.archivedTurns);
      } catch (error) {
        const message = String((error as Error)?.message || error);
        archiveStatus.archivedTurns = { error: message };
        CLI.renderArchiveWarning({ scope: 'Archived-turn', error: message });
        CLI.finishCompaction('failed');
        // Never replace recoverable history when its archive was not accepted.
        return;
      }

      const previousState = session.findLatestEventOfType(
        'session/compaction',
        (event) => Boolean(event.data.compactionState),
      )?.data.compactionState as CompactionStateV1 | undefined;
      const archivedDocs = result.stats.archivedTurns;
      const archivedIds = archivedDocs.map((doc) => doc.id);
      const archivedTurnNumbers = archivedDocs.map((doc) => doc.turnNumber);
      const preservedTurns = completed.slice(completed.length - preserve);
      const mergedArchivedIds = Array.from(new Set([...(previousState?.archivedTurnIds || []), ...archivedIds]));
      session.setHistory(result.messages, 'completed-turn-window', {
        ...(previousState as unknown as Record<string, unknown> | undefined),
        schemaVersion: 1,
        generation: (previousState?.generation || 0) + 1,
        sourceFingerprint: computeRequestValueDigest(result.messages),
        archivedTurnIds: mergedArchivedIds,
        archiveStatus,
        turnWindow: { preservedTurns, archivedTurnNumbers, archivedTurnIds: archivedIds },
      } as unknown as Record<string, unknown>);
      await this.persistSession(session);
      CLI.renderAutoCompactionNotice(result.stats.tokensSaved, result.stats.compactedTokens);
    } catch {
      CLI.finishCompaction('failed');
      // Non-blocking: turn completion must never fail because of compaction.
    } finally {
      CLI.finishCompaction('skipped');
    }
  }

  private async drainInbox(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal; isRecoveryResume?: boolean }): Promise<void> {
    this.drainScheduled = false;
    this.drainingInbox = true;
    this.drainingSessionId = session.id;
    try {
      let item: ReturnType<AgentInbox['claim']>;
      while ((item = this.inbox.claim(session.id))) {
        try {
          session.addUserMessage(item.text, item.source, item.id);
          session.append('input/claimed', { inputId: item.id });
          await this.persistSession(session);
          item.resolve(await this.run(session, options));
        } catch (error) {
          item.reject(error);
        }
        // An aborted signal must not be reused for the remaining queue:
        // leave leftovers pending so the post-turn drain executes them
        // with a fresh signal instead of instant-cancelling each one.
        if (options?.signal?.aborted) break;
      }
    } finally {
      this.drainingInbox = false;
      this.drainingSessionId = undefined;
    }
  }

  private collectVerificationDiagnostics(targetFiles?: string[]): VerificationFailureItem[] | undefined {
    try {
      if (!targetFiles || targetFiles.length === 0) {
        return [];
      }
      const tsService = getOrCreateTypeScriptService(this._workspace);
      const items: VerificationFailureItem[] = [];
      for (const file of targetFiles) {
        if (!/\.[cm]?[jt]sx?$/i.test(file)) continue;
        const diags = tsService.getDiagnostics(file)
          .filter((item) => item.category === 'error')
          .map((item): VerificationFailureItem => ({
            id: `ts-${item.code}-${item.file}-${item.line}`,
            source: 'diagnostics',
            file: item.file,
            line: item.line,
            message: item.message,
          }));
        items.push(...diags);
      }
      return items;
    } catch {
      return undefined;
    }
  }

  private async endTurn(
    session: Session,
    turn: number,
    maxSteps: number,
    isGoalMode: boolean,
    reason: string,
    turnUserRequest?: string,
    finalAnswer?: string,
  ): Promise<void> {
    await this.agentHooks.run('agent/turn-stopping', {
      session,
      turn,
      maxSteps,
      isGoalMode,
      reason,
      metadata: {},
    });
    session.append('turn/end', { turn, reason });
    session.assertRuntimeInvariants();
    await this.persistSession(session);
    await this.maybeCompactCompletedTurnWindow(session);
    if (reason === 'goal-completed' || reason === 'task-completed' || reason === 'completed' || (isGoalMode && reason === 'goal-stopped')) {
      void this.summarizeSessionEpisodic(session).catch(() => { });

      // Auto Context Save (Task Boundary Snapshot - context-management-context-save)
      if (turnUserRequest || finalAnswer) {
        try {
          const snapshot = await this.contextSnapshotManager.captureSnapshot({
            sessionId: session.id,
            turn,
            taskPrompt: turnUserRequest || 'Task Execution',
            finalAnswer: finalAnswer || 'Task completed.',
            mutatedFiles: Array.from(this.targetFilesModifiedInTurn),
            verificationStatus: this.verificationPolicy.canComplete().allowed ? 'verified' : 'unverified',
          });
          CLI.renderContextSnapshotSaved(snapshot);
          session.append('context/snapshot', {
            snapshotId: snapshot.snapshotId,
            contextFingerprint: snapshot.contextFingerprint,
          });
          await this.persistSession(session);
        } catch {
          // Non-blocking snapshot
        }
      }

      // Living Playbook Reflector & Curator (Agentic Context Engineering - ACE arXiv:2510.04618)
      try {
        const events = session.getEvents();
        const toolsExecuted: Array<{ toolName: string; args?: any; result?: any }> = [];
        let hadFailures = false;
        for (const e of events) {
          if (e.type === 'tool/call') {
            const d = e.data as any;
            toolsExecuted.push({ toolName: d.name || d.toolName || '', args: d.args });
          } else if (e.type === 'tool/result') {
            const d = e.data as any;
            const last = toolsExecuted[toolsExecuted.length - 1];
            if (last) {
              last.result = d.result;
            }
            if (d.result?.exitCode && d.result.exitCode !== 0) {
              hadFailures = true;
            }
          }
        }
        const deltas = PlaybookReflector.reflectOnTrace({
          userRequest: turnUserRequest || '',
          toolsExecuted,
          hadTestFailuresThenPass: hadFailures && this.verificationPolicy.canComplete().allowed,
          finalSuccess: true,
        });
        if (deltas.length > 0) {
          const curator = new PlaybookCurator(this.turnMemoryRetriever.getLivingPlaybook());
          await curator.commitDeltas(deltas);
        }

        // In-Loop Experience Distillation (SWE-Bench-CL & ExpeRepair)
        if (this.targetFilesModifiedInTurn.size > 0 && this.verificationPolicy.canComplete().allowed) {
          const touchedFiles = Array.from(this.targetFilesModifiedInTurn);
          const verifiedCmd = toolsExecuted.find((t: any) => t.toolName === 'run_command' && t.result && t.result.exitCode === 0)?.args?.command || 'npm test';
          await this.turnMemoryRetriever.distillExperience({
            taskIntent: turnUserRequest || 'Software modification task',
            faultLocalizedEntities: touchedFiles,
            patchSummary: `Modified ${touchedFiles.length} file(s): ${touchedFiles.slice(0, 5).join(', ')}`,
            verificationCommand: String(verifiedCmd),
            verificationExitCode: 0,
          }).catch(() => {});
        }
      } catch {
        // Non-blocking memory & playbook reflection
      }
    }
    this.cleanupEphemeralScratchFiles();
    this.targetFilesModifiedInTurn.clear();
    this.lastMutationForInvestigation = undefined;
    try {
      disposeSharedTypeScriptService();
      this.repositoryMap?.clearCache();
    } catch { }
    this.setAgentStatus('idle', session, turn);
  }

  private cleanupEphemeralScratchFiles(): string[] {
    const cleaned: string[] = [];
    for (const scratchFile of Array.from(this.ephemeralScratchFiles)) {
      try {
        const fullPath = path.isAbsolute(scratchFile) ? scratchFile : path.resolve(this._workspace.rootDir, scratchFile);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          cleaned.push(scratchFile);
        }
        this.ephemeralScratchFiles.delete(scratchFile);
        this.targetFilesModifiedInTurn.delete(scratchFile);
      } catch {}
    }
    return cleaned;
  }

  private setAgentStatus(status: AgentStatus, session: Session, turn?: number, step?: number): void {
    const record = this.agentRegistry.update(this.agentId, {
      status,
      sessionId: session.id,
      turn,
      step,
    });
    this.kernel?.ctx.events.emit('agent/status', record);
  }

  private createSubagentLoop(
    agentId: string,
    _session: Session,
    options: SubagentOptions,
    signal: AbortSignal,
  ): AgentLoop {
    const childRegistry = new ToolRegistry();
    const forbidden = new Set(['delegate_agent', 'spawn_agent', 'get_agent_result', 'wait_agent', 'stop_agent', 'resume_agent', 'allocate_agent_task', 'schedule_dag_parallel', 'verify_subagent_quality', 'brainstorm_design']);
    for (const tool of this.toolRegistry.getAll()) {
      if (!forbidden.has(tool.name)) childRegistry.register(tool);
    }

    const availableNames = childRegistry.getAll().map((tool) => tool.name);
    const allowedNames = (options.toolNames || availableNames).filter((name) => !forbidden.has(name));
    const childScope = childRegistry.createScope(`subagent-scope:${agentId}`, allowedNames);
    const subagentSections = resolveSubagentPromptSections({
      capabilities: options.capabilities || options.requiredCapabilities,
      toolNames: allowedNames,
      brief: options.brief,
    });
    const childLoop = new AgentLoop(this.llm, childRegistry, {
      workspace: options.worktreePath ? new Workspace(options.worktreePath) : this._workspace,
      maxSteps: options.maxSteps ?? this.maxSteps,
      toolScope: childScope,
      agentId,
      agentRegistry: this.agentRegistry,
      sessionPersistence: this.sessionPersistence,
      enableSubagents: false,
      enableStepSummarization: false,
      promptSections: subagentSections,
    });
    if (signal?.aborted) {
      childLoop.subagentManager.stopAll();
    } else if (signal) {
      signal.addEventListener('abort', () => {
        childLoop.subagentManager.stopAll();
      }, { once: true });
    }
    return childLoop;
  }
}
