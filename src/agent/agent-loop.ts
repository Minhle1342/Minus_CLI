import path from 'node:path';
import fs from 'node:fs';
import { ToolRegistry, ToolScope } from '../tools/registry.js';
import { ToolProvider } from '../tools/registry.js';
import { ToolRunner, type ToolExecutionResult } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';
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
import { DEFAULT_PROMPT_SECTIONS, detectPromptContext, resolveSubagentPromptSections, resolvePhaseDynamicGuidance } from '../llm/prompts.js';
import { AgentRegistry, AgentStatus } from './agent-registry.js';
import { SubagentManager, SubagentOptions } from './subagent-manager.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { EffectLedger } from './effect-ledger.js';
import { LoopProgressGuard } from './loop-progress-guard.js';
import { ProcessFailureDetector } from './process-failure-detector.js';
import { DomainIntentGuardian } from './domain-intent-guardian.js';
import { getTurnCompletionState, hasObservedMutation, observedMutationFiles } from './completion-observations.js';
import { buildCompletionRecoveryPrompt, selectFinalAnswer } from './completion-response.js';
import { FinalAnswerGuard, detectArchitectureAnalysisIntent, detectAnalysisOrInvestigationIntent, type FinalAnswerGuardDecision } from './final-answer-guard.js';
import { createDelegateAgentTool, createSpawnAgentTool, createWaitAgentTool, createGetAgentResultTool, createResumeAgentTool, createStopAgentTool, createAllocateAgentTaskTool, createBrainstormDesignTool, createVerifySubagentQualityTool, createScheduleDagParallelTool } from '../tools/subagent-tools.js';
import { classifyGitCommand } from '../tools/git-command-policy.js';
import { CompletionEvidenceGate, isToolResultFailure, isVerificationCommand } from './completion-evidence.js';
import { VerificationPolicy } from '../skills/verification-policy.js';
import { type LLMRequestOptions } from '../llm/gemini.js';
import { HypothesisTracker } from './hypothesis-tracker.js';
import { SpeculativeBranchManager } from './speculative-branch-manager.js';
import { CriticGate } from './critic-gate.js';
import { registerSubmitSolutionTool } from '../tools/submit-solution.js';
import { registerReportFindingsTool } from '../tools/report-findings.js';
import { WorkspaceStateVerifier } from '../workspace/workspace-state-verifier.js';
import { HypothesisRollbackOrchestrator } from './hypothesis-rollback-orchestrator.js';
import { AdaptiveReasoningController } from './adaptive-reasoning-controller.js';
import {
  generateFallbackStepSummary,
} from './step-summarizer.js';
import { classifyLLMError } from '../llm/error-handling.js';
import { ToolSynergyAdvisor } from './tool-synergy-advisor.js';
import { GraphRankedRepositoryMap } from './graph-ranked-repository-map.js';
import { CitationValidatedRepositoryMemory } from '../memory/repository-memory.js';
import { ClassificationEngine } from '../control/classification-engine.js';
import type { ClassificationDecision, ToolControlMode } from '../control/classification-types.js';
import { ThisTurnToolGate, hashAllowedToolSet } from '../control/this-turn-tool-gate.js';
import { ToolControlTelemetry } from '../control/tool-control-telemetry.js';
import { getOrCreateTypeScriptService } from '../tools/inspect-symbol.js';
import type { VerificationFailureItem } from '../skills/verification-baseline.js';
import { LatencyOrchestrator } from './latency-orchestrator.js';
import { DynamicContextCache } from './dynamic-context-cache.js';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';
import { partitionToolCalls, type ScheduledToolCall, type ToolCallPartition } from './tool-execution-scheduler.js';
import { PipelinedToolDispatcher } from './pipelined-tool-dispatcher.js';
import { CognitiveHarness } from './cognitive-harness.js';
import { ContextSnapshotManager, type TaskContextSnapshot } from '../session/context-snapshot-manager.js';
import { isMutationTool } from '../tools/diff-generator.js';
import { detectWorkspaceTestCommand } from '../testing/test-engineering-harness.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';
import { StepRetrievalQueryBuilder } from './step-retrieval-query-builder.js';
import { ContextQualityEvaluator } from './context-quality-evaluator.js';
import { StepPromptPolicy, resolveStepPromptGatingMode } from './step-prompt-policy.js';
import { assessParetoEvidence } from './pareto-evidence-policy.js';
import {
  ReliableToolOrchestrationTelemetry,
  applyReliableToolRouteToDeclarations,
  decideReliableToolRoute,
  resolveReliableToolOrchestrationMode,
  type TrajectoryStep,
} from './reliable-tool-orchestration.js';
import { AciGuardrails, resolveAciGuardrailMode } from './aci-guardrails.js';
import { ContextBudgetManager, resolveContextManagementMode, type CompactionStateV1 } from './context-budget-manager.js';

export function isScratchFilePath(filePath: string): boolean {
  const normalized = (filePath || '').trim().replace(/\\/g, '/').toLowerCase();
  return (
    normalized.startsWith('scratch/') ||
    normalized.startsWith('.scratch/') ||
    /(?:^|[\\/])(?:scratch|throwaway)[_-][a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/i.test(normalized) ||
    /(?:^|[\\/])scratch[\\/]/i.test(normalized)
  );
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
      guidance: '🛡️ [HARNESS PROFILE: STRICT-VERIFICATION ACTIVE]: Tác vụ sửa lỗi/bảo mật cần bằng chứng tỷ lệ thuận với rủi ro. Dùng kiểm chứng thực nghiệm cho thay đổi rủi ro cao; thay đổi nhỏ, dễ đảo ngược có thể tiến hành khi target đã được đọc và cơ chế nguyên nhân có bằng chứng trực tiếp.',
    };
  }

  if (isExploration) {
    return {
      profileName: 'read-only-guard',
      enforceScratchTest: false,
      criticStrictness: 'standard',
      compactionRatioBias: -0.05,
      guidance: '🔍 [HARNESS PROFILE: EXPLORATION ACTIVE]: Ưu tiên khảo sát cấu trúc, gọi các công cụ đọc/tìm kiếm và trích xuất ngữ cảnh. Hạn chế can thiệp trực tiếp vào mã nguồn trước khi có kế hoạch.',
    };
  }

  if (isScaffoldOrFeature) {
    return {
      profileName: 'velocity-first',
      enforceScratchTest: false,
      criticStrictness: 'lenient',
      compactionRatioBias: +0.05,
      guidance: '⚡ [HARNESS PROFILE: VELOCITY-FIRST ACTIVE]: Tác vụ dựng khung/tính năng mới. Ưu tiên tốc độ kiến tạo mã nguồn và nới lỏng kiểm tra blocker kiểm thử ở các bước ban đầu.',
    };
  }

  return {
    profileName: 'balanced-default',
    enforceScratchTest: false,
    criticStrictness: 'standard',
    compactionRatioBias: 0,
    guidance: '⚖️ [HARNESS PROFILE: BALANCED-DEFAULT ACTIVE]: Vận hành cân bằng theo quy trình TDD chuẩn.',
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
    reasons.push('Tác vụ sửa lỗi/bảo mật đòi hỏi suy luận sâu & kiểm chứng thực thi');
  } else if (taskClass === 'feature' || taskClass === 'refactor') {
    score += 0.25;
    reasons.push('Tác vụ tính năng mới/tái cấu trúc yêu cầu mở rộng không gian tìm kiếm');
  }

  const hasStackTrace = /(?:(?:Error|Exception):|at\s+[\w$./\\-]+\s*\([^)]+:\d+:\d+\)|Traceback \(most recent call last\):)/i.test(userRequest);
  if (hasStackTrace) {
    score += 0.25;
    reasons.push('Phát hiện dấu vết Stack Trace lỗi trong yêu cầu');
  }

  if (userRequest.length > 500) {
    score += 0.15;
    reasons.push('Yêu cầu mô tả chi tiết với nhiều ràng buộc');
  }

  score = Math.min(1.0, Math.max(0.1, score));
  const scaleFactor = 1.0 + Math.round(score * 10) / 10;

  return {
    score,
    scaleFactor,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Tác vụ tiêu chuẩn',
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
  readonly verificationPolicy = new VerificationPolicy();
  readonly reflectionEngine: ReflectionEngine;
  readonly memoryManager: ProjectMemoryManager;
  readonly hypothesisTracker = new HypothesisTracker();
  readonly criticGate: CriticGate;
  readonly speculativeManager: SpeculativeBranchManager;
  readonly adaptiveReasoning = new AdaptiveReasoningController();
  readonly rollbackOrchestrator: HypothesisRollbackOrchestrator;
  readonly workspaceVerifier: WorkspaceStateVerifier;
  readonly cognitiveHarness = new CognitiveHarness();
  readonly contextSnapshotManager: ContextSnapshotManager;
  private targetFilesModifiedInTurn = new Set<string>();
  private ephemeralScratchFiles = new Set<string>();
  readonly kernel?: AgentKernel;
  private sessionPersistence?: SessionPersistence;
  private _isGoalMode: boolean = false;
  private drainingInbox = false;
  private drainingSessionId?: string;
  private drainScheduled = false;
  private runQueues = new Map<string, Promise<string>>();
  readonly MAX_CIRCUIT_BREAKER_RETRIES = 5;
  private consecutiveCircuitBreakerRetries = 0;
  private activeSession?: Session;
  private loopOptions?: AgentLoopOptions;
  readonly toolAdvisor = new ToolSynergyAdvisor();
  readonly repositoryMap: GraphRankedRepositoryMap;
  readonly repositoryMemory: CitationValidatedRepositoryMemory;
  private lastToolExecution?: { toolName: string; result: any; guardianDiagnosis?: any };
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
    filesModifiedSince: number;
  };

  private isEvidenceSufficient(): boolean {
    const last = this.lastToolExecution;
    return Boolean(last?.toolName === 'read_file' && last?.result?.symbol && last?.result?.completeDeclaration);
  }
  readonly stepPromptPolicy = new StepPromptPolicy();
  private stepDynamicSuffixes = new Map<number, string>();
  readonly pipelinedDispatcher = new PipelinedToolDispatcher();
  private _latestReasoning?: { thought: string; timestamp: string; step: number; turn: number };
  private _collapsePreferences: UICollapsePreferences = { ...DEFAULT_COLLAPSE_PREFERENCES };
  private cachedTurnNumber?: number;
  private cachedTurnToolDeclarations?: any[];
  private cachedTurnToolProviderSize?: number;
  private cachedTurnToolFingerprint?: string;

  get latestReasoning(): { thought: string; timestamp: string; step: number; turn: number } | undefined {
    return this._latestReasoning;
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
      this.criticGate = new CriticGate(this.completionEvidenceGate);
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
    if (this.llm && typeof this.llm.getTokenConfig === 'function') {
      return this.llm.getTokenConfig();
    }
    return undefined;
  }

  setTokenConfig(config: Partial<import('../llm/token-config.js').TokenConfig>): void {
    if (this.llm && typeof this.llm.setTokenConfig === 'function') {
      this.llm.setTokenConfig(config);
    }
    if (config.maxInputTokens) {
      this.contextCompactor.setMaxInputTokens(config.maxInputTokens);
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
        const result = await this.runInternal(session, {
          ...options,
          isCircuitBreakerRetry: this.consecutiveCircuitBreakerRetries > 0,
        });
        this.consecutiveCircuitBreakerRetries = 0;
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
          this.consecutiveCircuitBreakerRetries = 0;
          throw error;
        }

        const errClassification = classifyLLMError(error);
        const isQuotaOrRateLimit = errClassification.kind === 'HARD_QUOTA_EXHAUSTED' || errClassification.kind === 'TRANSIENT_RATE_LIMIT';
        const isServerError = errClassification.kind === 'SERVER_ERROR';
        const isRetryableLLMError = isQuotaOrRateLimit || isServerError;

        if (isRetryableLLMError && this.consecutiveCircuitBreakerRetries < this.MAX_CIRCUIT_BREAKER_RETRIES) {
          this.consecutiveCircuitBreakerRetries++;

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
            : (errClassification.retryAfterMs ?? Math.min(1500 * Math.pow(1.5, this.consecutiveCircuitBreakerRetries - 1), 8000));

          const sleepResult = await this.sleepWithWakeup(session.id, backoffMs, options?.signal);
          if (sleepResult.aborted || options?.signal?.aborted) {
            throw new Error('Agent stopped: cancellation requested.');
          }

          // Ẩn thông báo CIRCUIT_BREAKER_TRIGGERED và tự động lặp tiếp tục turn dở dang
          continue;
        }

        if (isRetryableLLMError && this.consecutiveCircuitBreakerRetries >= this.MAX_CIRCUIT_BREAKER_RETRIES) {
          const detailMsg = isServerError
            ? `LLM Provider đang quá tải hoặc không khả dụng: Hệ thống đã tự động gửi prompt "Continue" 5 lần nhưng máy chủ LLM vẫn báo lỗi (${errClassification.kind}: ${errClassification.message || 'Mô hình đang chịu tải cao tạm thời / 503 UNAVAILABLE'}). Vui lòng chờ vài phút rồi thử lại hoặc đổi sang model khác bằng lệnh /model.`
            : `LLM đã hết Quota: Hệ thống đã tự động gửi prompt "Continue" 5 lần nhưng LLM vẫn báo lỗi hạn mức (${errClassification.kind}: ${errClassification.message || 'Hạn mức API đã cạn kiệt hoặc bị giới hạn tần suất liên tục'}). Vui lòng đổi sang model khác bằng lệnh /model hoặc kiểm tra gói cước billing.`;
          const quotaExhaustedError = new Error(detailMsg);
          (quotaExhaustedError as any).isQuotaExhausted = isQuotaOrRateLimit;
          (quotaExhaustedError as any).isServerUnavailable = isServerError;
          (quotaExhaustedError as any).originalClassification = errClassification;
          this.consecutiveCircuitBreakerRetries = 0;
          throw quotaExhaustedError;
        }

        this.consecutiveCircuitBreakerRetries = 0;
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
        return 'Tác vụ đã được dừng theo yêu cầu của người dùng.';
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
                    ? `LLM đã hết Quota (Hạn mức API đã hết). Bạn có thể đổi sang model khác bằng lệnh /model, hoặc kiểm tra gói cước billing trước khi tiếp tục.`
                    : `LLM Rate Limit Exceeded (Giới hạn tần suất 429). Hệ thống đã tự động lưu tiến độ kế hoạch. Bạn có thể đợi vài phút rồi dùng /goal resume hoặc /plan resume.`)
                : `LLM Provider Server Unavailable (Quá tải máy chủ 503). Hệ thống đã tự động lưu tiến độ kế hoạch. Bạn có thể đợi vài phút rồi dùng /goal resume hoặc đổi model bằng lệnh /model.`);
          await CLI.renderExecutionStopped(
            `Agent suspended: ${suspensionAdvice}\nChi tiết: ${detail}`,
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
    this.planManager.bindSession(session);
    this.goalManager.bindSession(session);
    this.memoryManager.bindSession(session);
    this.repositoryMemory.bindSession(session);
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    this.reflectionEngine.reset();
    this.progressGuard.reset();
    this.processFailureDetector.reset();
    this.processFailureDetector.initTaskKeywords(turnUserRequest);
    this.domainIntentGuardian.reset();
    this.domainIntentGuardian.extractAndFreezeContract(turnUserRequest);
    this.finalAnswerGuard.reset();
    this.verificationPolicy.reset();
    this.cognitiveHarness.reset();
    this.cleanupEphemeralScratchFiles();
    this.targetFilesModifiedInTurn.clear();
    this.stepDynamicSuffixes.clear();
    const isGoal = options?.isGoalMode ?? this._isGoalMode;
    const baseMaxSteps = options?.maxSteps ?? this.maxSteps;
    const initialTurnClassification = this.classificationEngine.classify({
      request: turnUserRequest,
      hasPlan: this.planManager.hasPlan(),
    });
    const taskComplexity = calculateTaskComplexity(turnUserRequest, initialTurnClassification.taskClass);
    const effectiveMaxSteps = Number.isFinite(baseMaxSteps)
      ? Math.max(1, Math.round(baseMaxSteps * taskComplexity.scaleFactor))
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
    let consecutiveUnproductiveSteps = 0;
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
    if (toolControlMode === 'enforce') {
      const baselineDiagnostics = this.collectVerificationDiagnostics();
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
    await this.persistSession(session);
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
        const digest = this.memoryManager.getProjectDigest();
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
          });
          prefix += `${this.cognitiveHarness.formatScaffoldForPrompt(initialScaffold)}\n\n`;
        }
        const rewrittenHistory = history.map((message, index) =>
          index === 0
            ? { ...message, parts: [{ text: `${prefix}[USER INSTRUCTION]:\n${userText}` }] }
            : message
        );
        session.replaceHistory(rewrittenHistory, 'warm-start');
        await this.persistSession(session);
      }
    }

    for (let step = 1; step <= effectiveMaxSteps; step++) {
      if (options?.signal?.aborted) {
        const cancellationMessage = 'Agent stopped: cancellation requested.';
        await CLI.renderExecutionStopped(cancellationMessage, 'CANCELLED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'cancelled');
        this.goalManager.disarm();
        rejectSteerItems(new Error(cancellationMessage));
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
        consecutiveUnproductiveSteps = 0;
        consecutiveEmptyTurns = 0;
        consecutiveIncompleteFinals = 0;
        consecutivePlanCompletionRejects = 0;
        consecutiveIncompleteFinishes = 0;
        consecutiveNoProgressStrategyChanges = 0;
      }

      session.append('step/start', { turn, step });
      await this.persistSession(session);
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
      const maxBudget = this.contextCompactor.getConfig().maxTotalHistoryTokens || 32000;
      const workingHistoryBudget = Math.min(maxBudget, 24000);

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
        request: turnUserRequest,
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
      const paretoEvidence = assessParetoEvidence({
        session,
        turn,
        taskClass: provisionalClassification.taskClass,
        risk: provisionalClassification.risk,
        hasPlan: this.planManager.hasPlan(),
        validatedHypothesisCount: validatedHypotheses.length,
        supportedHypothesisCount,
      });
      const inspectedLowRiskFastPath = ['R0', 'R1', 'R2'].includes(provisionalClassification.risk)
        && paretoEvidence.inspectedFiles.length > 0;
      const classification = this.classificationEngine.classify({
        ...classificationInput,
        hasDirectEvidence: paretoEvidence.hasSufficientEvidence || inspectedLowRiskFastPath,
        evidenceScore: paretoEvidence.score,
        evidenceThreshold: paretoEvidence.threshold,
      });
      previousClassification = classification;

      // Cập nhật ngữ cảnh Cổng Pareto 80/20 Thích Ứng & Reproduction Verification cho ToolUseGuardian
      this.toolRunner.guardian.setPreMutationGateContext({
        isBugfixTask: classification.taskClass === 'bugfix',
        taskIntent: classification.taskClass,
        taskClass: classification.taskClass,
        phase: classification.phase,
        hasPlan: this.planManager.hasPlan(),
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
        inspectedFiles: paretoEvidence.inspectedFiles,
        hasEmpiricalEvidence: paretoEvidence.hasEmpiricalEvidence,
        hasSubmittedSolution,
        reproductionStatus: {
          hasPostFixPass: this.completionEvidenceGate.hasVerifiedPassingTest(session, turn),
          hasPreFixRepro: paretoEvidence.hasFailureEvidence || hasValidatedHypothesis,
        },
      });

      const adviceInfo = this.toolAdvisor.advise({
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        hasErrors: this.lastToolExecution?.result?.error !== undefined,
        activeTaskTitle: activeTask?.title,
        hasSubmittedSolution,
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

      this.kernel?.ctx.events.emit('step:before', step, effectiveMaxSteps);
      this.verificationPolicy.setRequiredRisk(classification.risk);
      const recommendedToolDecision = this.thisTurnToolGate.decide(classification, this.toolProvider.getAll());
      this.toolControlTelemetry.recordDecision(classification, recommendedToolDecision);
      const candidateProvider = toolControlMode === 'enforce'
        ? new ToolScope(`turn-${turn}-step-${step}-candidates`, this.toolProvider, recommendedToolDecision.allowedToolNames)
        : this.toolProvider;
      const dynamicRetrievalEnabled = this.loopOptions?.enableDynamicToolRetrieval !== false
        && (toolControlMode === 'enforce' || candidateProvider.getAll().length >= 10);
      const providerSize = candidateProvider.getAll().length;
      const currentHypothesis = this.hypothesisTracker.getActiveHypothesis()
        || this.hypothesisTracker.getSupportedHypotheses().slice(-1)[0]
        || this.hypothesisTracker.getValidatedHypotheses().slice(-1)[0];
      const retrievalState = this.stepRetrievalQueryBuilder.build({
        userRequest: turnUserRequest,
        activeTask,
        phase: classification.phase,
        taskClass: classification.taskClass,
        hypothesis: currentHypothesis,
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        allowedToolNames: toolControlMode === 'enforce'
          ? recommendedToolDecision.allowedToolNames
          : candidateProvider.getAll().map((tool) => tool.name),
      });
      const activeStepQuery = retrievalState.query;
      let activeToolDeclarations: any[];
      if (
        this.cachedTurnNumber === turn
        && this.cachedTurnToolDeclarations
        && this.cachedTurnToolProviderSize === providerSize
        && this.cachedTurnToolFingerprint === retrievalState.fingerprint
      ) {
        activeToolDeclarations = this.cachedTurnToolDeclarations;
      } else {
        activeToolDeclarations = (dynamicRetrievalEnabled && typeof candidateProvider.getRelevantTools === 'function')
          ? candidateProvider.getRelevantTools(activeStepQuery)
          : candidateProvider.getFunctionDeclarations();
        this.cachedTurnNumber = turn;
        this.cachedTurnToolDeclarations = activeToolDeclarations;
        this.cachedTurnToolProviderSize = providerSize;
        this.cachedTurnToolFingerprint = retrievalState.fingerprint;
      }

      // Intent-Aware Tool Scoping (Cơ chế 1 - Claude Code & Cursor Pattern):
      // Khi yêu cầu là điều tra nguyên nhân / phân tích sự cố / khảo sát mà không có mutation,
      // ẩn hoàn toàn submit_solution để LLM tập trung vào phân tích chi tiết hoặc gọi tool báo cáo chuyên biệt.
      const stepCompletionState = getTurnCompletionState(session, turn);
      const isPureInvestigation = !stepCompletionState.hasMutations
        && !classification.requiredCapabilities.includes('edit')
        && ['question', 'exploration'].includes(classification.taskClass);
      if (isPureInvestigation) {
        activeToolDeclarations = activeToolDeclarations.filter((tool: any) => tool.name !== 'submit_solution');
      }

      // Pre-Call Predictive Guardrails (Phase 1/4):
      // Khi đã có verification thành công sau mutation, ẩn toàn bộ tool chỉnh sửa code để triệt tiêu vi phạm và đột biến thừa
      const hasVerifiedTests = this.verificationPolicy.canComplete().allowed
        && stepCompletionState.hasMutations
        && !hasSubmittedSolution;
      if (hasVerifiedTests) {
        activeToolDeclarations = activeToolDeclarations.filter((tool: any) =>
          !isMutationTool(tool.name)
        );
      }

      // Post-Submission Tool Stripping: Khi đã submit_solution thành công, tước bỏ toàn bộ tools để model chỉ sinh text thuần
      if (hasSubmittedSolution) {
        activeToolDeclarations = [];
      }

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
      activeToolDeclarations = applyReliableToolRouteToDeclarations(
        activeToolDeclarations,
        reliableRouteDecision,
        reliableToolOrchestrationMode,
      );

      const visibleToolNames = activeToolDeclarations.map((tool: any) => String(tool.name)).filter(Boolean).sort();
      const expectedToolNames = recommendedToolDecision.allowedToolNames.filter((name) => {
        if (hasSubmittedSolution) return false;
        if (isPureInvestigation && name === 'submit_solution') return false;
        if (hasVerifiedTests && isMutationTool(name)) return false;
        return true;
      });
      this.contextQualityEvaluator.recordToolRetrieval(visibleToolNames, expectedToolNames);
      const activeToolSetHash = hashAllowedToolSet(visibleToolNames);
      const activeDecisionId = `${recommendedToolDecision.id}-${activeToolSetHash.slice(0, 8)}`;
      const hasRuntimeToolScope = toolControlMode === 'enforce'
        || (reliableToolOrchestrationMode === 'enforce' && reliableRouteDecision.constrainSafe && !reliableRouteDecision.failOpen);
      const stepToolProvider = hasRuntimeToolScope
        ? new ToolScope(`turn-${turn}-step-${step}-runtime`, candidateProvider, visibleToolNames)
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
              id: activeDecisionId,
              visibleToolNames,
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
        harnessProfileName: harnessProfile.profileName,
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

      const effectiveRepoMemTokens = (isLocalizedExecution && !explicitRepoMem)
        ? Math.min(300, configuredRepoMemTokens)
        : configuredRepoMemTokens;
      const effectiveRepoMapTokens = (isLocalizedExecution && !explicitRepoMap)
        ? 0
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
        if (shouldRecallRepoMem) {
          try {
            const recalled = await this.repositoryMemory.recall(activeStepQuery, {
              limit: isLocalizedExecution && !explicitRepoMem ? 4 : 12,
              maxTokens: effectiveRepoMemTokens,
            });
            repositoryMemoryContext = recalled.rendered;
            repositoryMemoryRecords = recalled.records;
          } catch {
            // Repository memory is an independent, fail-open context source.
          }
        }
        if (shouldRenderRepoMap) {
          try {
            const repositoryQuery = [
              activeStepQuery,
              ...relevantMemory.map((item) => item.insight),
              ...repositoryMemoryRecords.map((item) => item.statement),
            ].filter(Boolean).join('\n');
            repositoryContext = await this.repositoryMap.renderContext(repositoryQuery, {
              maxTokens: effectiveRepoMapTokens,
              seedFiles: [
                ...(activeTask?.readSet || []),
                ...(activeTask?.writeSet || []),
                ...(currentHypothesis?.targetFiles || []),
                ...retrievalState.discoveredFiles,
                ...(composeState?.registeredFiles || []),
                ...repositoryMemoryRecords.flatMap((item) => item.relatedFiles),
              ],
              seedSymbols: [
                ...(activeTask?.symbols || []),
                ...retrievalState.discoveredSymbols,
              ],
            });
          } catch (error: any) {
            repositoryContext = `[GRAPH-RANKED REPOSITORY MAP DEGRADED]\n${error?.message || String(error)}`;
          }
        }
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
            minScore: 0.55,
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
        hasValidatedHypothesis,
        hasSupportedHypothesis: supportedHypothesisCount > 0,
        evidenceSufficient: paretoEvidence.hasSufficientEvidence,
        evidenceScore: paretoEvidence.score,
        evidenceThreshold: paretoEvidence.threshold,
      });

      // Phase 3/4: Cognitive Task Scaffolding, Dynamic Reflection & Strategic Pivot (Layer 2 & 1)
      const rawReflection = this.reflectionEngine.getLastReflectionPrompt();
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
      const reflectionContext = [rawReflection, strategicPivotGuidance].filter(Boolean).join('\n\n');

      // Phase 4: Auto-Convergence Directive when all verification tests passed
      let completionDirective: string | undefined;
      if (hasVerifiedTests) {
        completionDirective = `🎯 [VERIFICATION SUCCESSFUL]: All unit test checks passed with Exit Code 0. Code modifications are empirically verified. Do NOT make any more code changes. Call "submit_solution" immediately to conclude the task.`;
      }

      const hypothesisContext = this.hypothesisTracker.toScratchpad();
      const hypothesisGuidance = this.hypothesisTracker.toPromptGuidance();
      const domainContractContext = this.domainIntentGuardian.formatContractForPromptContext();

      // Every model-visible dynamic block enters one arbiter. A preliminary pass
      // provides the footprint used by latency guidance; the final pass includes it.
      const dynamicBudgetTokens = isLocalizedExecution ? 1200 : 1600;
      const arbitrationInputs = {
        completionDirective,
        advicePrompt,
        reflectionContext,
        cognitiveScaffold: cognitiveScaffoldText,
        toolPlaybooks: promptDecision.toolPlaybookPrompt,
        harnessGuidance: promptDecision.harnessGuidance,
        hypothesisContext,
        hypothesisGuidance,
        domainContractContext,
        phaseGuidance,
        rawPlanContext,
        recalledTurnContext,
        memoryPrompt,
        composeContext,
        repositoryMemoryContext,
        repositoryContext,
      };
      const arbitrationOptions = {
        maxBudgetTokens: dynamicBudgetTokens,
        modelName: activeModelName,
        consecutiveFailures: consecutiveFails,
        retrievalQuery: activeStepQuery,
      };
      const preliminaryArbitration = this.dynamicContextArbiter.arbitrate(arbitrationInputs, arbitrationOptions);
      const latencyProfile = this.latencyOrchestrator.getModelProfile(activeModelName, activeTokenConfig);
      const preliminaryFootprint = this.latencyOrchestrator.estimateRequest({
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
        dynamicContext: preliminaryArbitration.renderedContext,
        maxInputTokens: activeTokenConfig.maxInputTokens,
        maxOutputTokens: activeTokenConfig.maxOutputTokens,
      });
      const latencyGuidance = this.latencyOrchestrator.buildGuidance({
        step,
        footprint: preliminaryFootprint,
        modelName: activeModelName,
        tokenConfig: activeTokenConfig,
        phase: classification.phase,
        verificationReady: this.verificationPolicy.canComplete().allowed
          && (!this.planManager.hasPlan() || this.planManager.isAllTasksCompleted()),
      });
      const finalArbitrationInputs = { ...arbitrationInputs, latencyGuidance };
      const arbitration = this.dynamicContextArbiter.arbitrate(finalArbitrationInputs, arbitrationOptions);
      this.contextQualityEvaluator.recordContextArbitration({
        sourceCount: Object.values(finalArbitrationInputs).filter((value) => typeof value === 'string' && value.trim().length > 0).length,
        retainedSourceCount: arbitration.sourcesIncluded.length,
        beforeTokens: arbitration.stats.beforeTokens,
        afterTokens: arbitration.stats.afterTokens,
      });
      const dynamicExecutionContext = arbitration.renderedContext;
      let requestFootprint = this.latencyOrchestrator.estimateRequest({
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
        dynamicContext: dynamicExecutionContext,
        maxInputTokens: activeTokenConfig.maxInputTokens,
        maxOutputTokens: activeTokenConfig.maxOutputTokens,
      });

      // Budget the complete serialized request once all dynamic inputs are known.
      const previousCompactionState = [...session.getEvents()]
        .reverse()
        .find((event) => event.type === 'session/compaction' && event.data.compactionState)
        ?.data.compactionState as CompactionStateV1 | undefined;
      const contextPreparation = await this.contextBudgetManager.prepareRequest({
        provider: this.llm?.constructor?.name || 'unknown',
        model: activeModelName,
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
        dynamicContext: dynamicExecutionContext,
        maxInputTokens: Math.max(1, activeTokenConfig.maxInputTokens || maxBudget),
        targetInputTokens: workingHistoryBudget,
        outputReserveTokens: Math.max(0, activeTokenConfig.maxOutputTokens || 0),
      }, {
        mutatedFiles: Array.from(this.targetFilesModifiedInTurn),
        cognitivePhase: classification.phase === 'release' ? 'verify' : classification.phase,
        enableObservationMasking: true,
        previousState: previousCompactionState,
      });
      const compactionStats = contextPreparation.compactionStats;
      if (contextPreparation.changed && compactionStats) {
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
          await this.turnMemoryRetriever.archiveTurns(compactionStats.archivedTurns).catch(() => {});
        }
        if (compactionStats.maskedObservations?.length) {
          await this.turnMemoryRetriever.archiveMaskedObservations(compactionStats.maskedObservations).catch(() => {});
        }
        session.setHistory(
          contextPreparation.history,
          `context-budget-${contextPreparation.mode}`,
          contextPreparation.state as unknown as Record<string, unknown> | undefined,
        );
        CLI.renderAutoCompactionNotice(compactionStats.tokensSaved, compactionStats.compactedTokens);
        await this.persistSession(session);
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
        const message = `Agent stopped: ${contextPreparation.failureReason} (${contextPreparation.after.upperBoundTokens}/${workingHistoryBudget} estimated input tokens).`;
        session.append('step/end', { turn, step, reason: contextPreparation.failureReason });
        await this.persistSession(session);
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, contextPreparation.failureReason);
        return message;
      }

      session.recordRequestHeader({
        turn,
        step,
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
      }, { compactHistory: true });
      session.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
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
      };
      const requestStartedAt = Date.now();
      let firstTokenAt: number | undefined;
      this.kernel?.ctx.events.emit('model:thinking:start', {
        agentId: this.agentId,
        turn,
        step,
        startedAt: requestStartedAt,
      });
      try {
        if (typeof this.llm.generateStream === 'function') {
          response = await this.llm.generateStream(session, activeToolDeclarations, {
            onThoughtToken: (token: string) => {
              firstTokenAt ??= Date.now();
              this.kernel?.ctx.events.emit('model:thought', token);
            },
            onContentToken: (token: string) => {
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
        this.kernel?.ctx.events.emit('model:thinking:end', {
          agentId: this.agentId,
          turn,
          step,
          endedAt: Date.now(),
        });
      }
      this.consecutiveCircuitBreakerRetries = 0;
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
        if (!this._collapsePreferences.compactSteps) {
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
        }));
        const toolCallIds = normalizedToolCalls.map((call: any, callIndex: number) => (call as any).id || `call-${turn}-${step}-${callIndex}`);
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

        let strategyChangeRequired: { toolName: string; repetitionCount: number } | undefined;
        let toolBatchCancelled = false;

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
              CLI.renderToolCall(scheduled.name, scheduled.args);
            }

            const batchStartedAt = Date.now();
            const settled = await Promise.allSettled(readPartition.calls.map((scheduled) => (
              stepToolRunner.run(scheduled.name, scheduled.args, {
                sessionId: session.id,
                agentId: this.agentId,
                turn,
                userRequest: turnUserRequest,
                signal: options?.signal,
                ...(toolControlMode === 'enforce' ? {
                  decisionId: activeDecisionId,
                  allowedToolNames: visibleToolNames,
                  allowedToolSetHash: activeToolSetHash,
                  classificationPhase: classification.phase,
                  classificationRisk: classification.risk,
                  maxToolCalls: recommendedToolDecision.maxToolCalls,
                } : {}),
              })
            )));
            readBatchDurationMs.set(callIndex, Date.now() - batchStartedAt);
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
            }
          }

          // Post-Submission Terminal Gate (OpenAI Codex CLI Standard):
          // Chặn toàn bộ các tool call dư thừa (kể cả read_file, run_command) nếu nhiệm vụ đã được submit_solution hoàn tất
          let executionResult: ToolExecutionResult;
          if (preexecutedReadResult) {
            executionResult = preexecutedReadResult;
          } else if (hasSubmittedSolution) {
            const redundantPayload = {
              success: false,
              submitted: true,
              summary: submittedSolutionSummary || 'Task completed and submitted.',
              nextAction: 'final_answer',
              errorCode: 'POST_SUBMISSION_TOOL_CALL_BLOCKED',
              message: 'Solution has already been submitted and verified. All tool calls are locked. Do not execute further tools; conclude your turn with your final response to the user immediately.',
            };
            executionResult = { toolName, args: toolArgs, durationMs: 0, result: redundantPayload };
          } else {
            // Chạy tool qua pipeline an toàn
            let completionEvidence = toolName === 'submit_solution'
              ? this.completionEvidenceGate.evaluate('', session, {
                turn,
                codeChangeRequired: this.verificationPolicy.hasPendingModifications()
                  || Boolean(this.planManager.getTasks().some((task: any) => (task.writeSet || []).length > 0)),
              })
              : undefined;
            let policyCompletion = toolName === 'submit_solution'
              ? this.verificationPolicy.canComplete()
              : undefined;

            // Tool-Use Guardian: JIT Pre-Call Validation Guard cho submit_solution
            if (toolName === 'submit_solution' && (policyCompletion?.allowed !== true || completionEvidence?.allow !== true)) {
              try {
                const tsService = getOrCreateTypeScriptService(this._workspace);
                let errors: any[] = [];
                if (this.targetFilesModifiedInTurn.size > 0) {
                  for (const modFile of this.targetFilesModifiedInTurn) {
                    if (/\.[cm]?[jt]sx?$/i.test(modFile)) {
                      errors.push(...tsService.getDiagnostics(modFile).filter((d: any) => d.category === 'error'));
                    }
                  }
                } else {
                  // Pure read-only / investigation: 0 errors
                  errors = [];
                }
                if (errors.length === 0) {
                  // Kiểm tra xem dự án có test runner / test suite cấu hình sẵn hay không khi có thay đổi mã nguồn
                  const detectedTestCmd = await detectWorkspaceTestCommand(this._workspace.rootDir);
                  const hasRealTestScript = Boolean(detectedTestCmd);
                  const verificationHistory = this.verificationPolicy.getVerificationHistory();
                  const hasSuccessfulTest = verificationHistory.some(
                    (v) => v.success && (v.tier === 'targeted_test' || v.tier === 'full_test')
                  );

                  if (this.targetFilesModifiedInTurn.size > 0 && hasRealTestScript && !hasSuccessfulTest) {
                    policyCompletion = {
                      allowed: false,
                      reason: `Dự án có cấu hình test suite ("${detectedTestCmd}") và bạn đã chỉnh sửa mã nguồn (${Array.from(this.targetFilesModifiedInTurn).join(', ')}). Bắt buộc phải thực thi lệnh kiểm thử thành công trước khi hoàn thành nhiệm vụ qua submit_solution.`,
                      errorCode: 'TEST_EXECUTION_REQUIRED',
                    };
                  } else {
                    this.verificationPolicy.recordVerification(
                      'jit_diagnostics_sweep',
                      true,
                      'JIT in-memory diagnostics clean (0 errors)',
                      0,
                      { tier: 'typecheck' },
                    );
                    policyCompletion = this.verificationPolicy.canComplete();
                    completionEvidence = this.completionEvidenceGate.evaluate('', session, {
                      turn,
                      codeChangeRequired: false,
                    });
                  }
                } else {
                  policyCompletion = {
                    allowed: false,
                    reason: `Phát hiện ${errors.length} lỗi TypeScript chưa được sửa: ${errors.slice(0, 2).map((e: any) => `${e.file}:${e.line} - ${e.message}`).join('; ')}`,
                    errorCode: 'DIAGNOSTICS_FAILED',
                  };
                }
              } catch {}
            }
            // Phase 1 ACI Guardrails Pre-validation (SWE-agent)
            const aciValidation = this.aciGuardrails.validate({
              toolName,
              args: toolArgs,
              workspaceRoot: this._workspace.rootDir,
            }, resolveAciGuardrailMode());

            // Phase 3 Reproduction Gate (Agentless & AutoCodeRover)
            const reproductionMode = process.env.MINUS_REPRODUCTION_GATE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'observe';
            const reproductionCheck = isMutationTool(toolName)
              ? this.verificationPolicy.canMutate(classification.taskClass, reproductionMode)
              : { allowed: true };

            if (!aciValidation.allowed) {
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
                  ...(toolControlMode === 'enforce' ? {
                    decisionId: activeDecisionId,
                    allowedToolNames: visibleToolNames,
                    allowedToolSetHash: activeToolSetHash,
                    classificationPhase: classification.phase,
                    classificationRisk: classification.risk,
                    maxToolCalls: recommendedToolDecision.maxToolCalls,
                  } : {}),
                  ...(toolName === 'submit_solution' ? {
                    completionEvidenceVerified: completionEvidence?.allow === true && policyCompletion?.allowed === true,
                    completionEvidenceReason: policyCompletion?.reason || completionEvidence?.reasons?.filter(Boolean).join('; ') || undefined,
                  } : {}),
                },
                toolCallId,
              );
              executionResult = pipelinedOutcome.executionResult;
            }
            if (executionResult.result?.errorCode === 'TOOL_NOT_ALLOWED_THIS_TURN') {
              this.toolControlTelemetry.recordDeniedCall();
            }
          }

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
          this.finalAnswerGuard.observeToolResult(toolName, executionResult.result);
          this.planManager.recordToolEvidence(toolName, toolArgs, executionResult.result, {
            granted: executionResult.permission?.status === 'granted',
            requestId: executionResult.permission?.requestId,
          });
          this.repositoryMap.observeToolResult(toolName, toolArgs, executionResult.result);
          if (sideEffect && !isToolResultFailure(executionResult.result)) {
            this.dynamicContextCache.invalidate();
          }
          if (hasObservedMutation(toolName, executionResult.result)) {
            if (this.lastCommandExecutionState) {
              this.lastCommandExecutionState.filesModifiedSince++;
            }
            const mutatedFiles = observedMutationFiles(toolName, toolArgs, executionResult.result);
            for (const file of mutatedFiles) this.targetFilesModifiedInTurn.add(file);
            const mutatedPath = mutatedFiles[0] || '';
            const blast = executionResult.result?.blastRadius;
            this.verificationPolicy.recordModification(mutatedPath, {
              impactedTestSuites: blast?.impactedTestSuites,
              risk: blast?.risk,
            });
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
            let differential: { hasNewFailures: boolean } | undefined;
            if (toolControlMode === 'enforce' && isVerificationCommand(toolArgs.command)) {
              const postDiagnostics = this.collectVerificationDiagnostics();
              if (postDiagnostics) {
                differential = this.verificationPolicy.getBaselineManager().evaluateDifferential(postDiagnostics);
              }
            }
            this.verificationPolicy.recordVerification(
              String(toolArgs.command || ''),
              !isToolResultFailure(executionResult.result),
              String(executionResult.result.stdout || executionResult.result.stderr || '').slice(0, 240),
              executionResult.result.exitCode,
              { hasNewFailures: differential?.hasNewFailures },
            );
            this.lastCommandExecutionState = {
              command: String(toolArgs?.command || toolArgs?.CommandLine || ''),
              success: !isToolResultFailure(executionResult.result) && (executionResult.result?.exitCode === 0 || executionResult.result?.exitCode === undefined),
              exitCode: executionResult.result?.exitCode,
              filesModifiedSince: 0,
            };

            // AUTO-CLEANUP: Tự động xóa các file scratch tạm ngay khi lệnh kiểm thử chạy thành công mà không tốn thêm step xóa
            if (!isToolResultFailure(executionResult.result) && (executionResult.result.exitCode === 0 || executionResult.result.exitCode === undefined)) {
              const cmd = String(toolArgs.command || '');
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
                const cleanupNotice = `\n[AUTO-CLEANUP]: Đã tự động dọn dẹp file kiểm thử tạm (${cleanedFiles.join(', ')}) sau khi kiểm thử thành công. Bạn không cần thực hiện thêm bước xóa file.`;
                if (typeof executionResult.result.stdout === 'string') {
                  executionResult.result.stdout += cleanupNotice;
                } else if (typeof executionResult.result.output === 'string') {
                  executionResult.result.output += cleanupNotice;
                }
                if (typeof executionResult.result === 'object' && executionResult.result !== null) {
                  executionResult.result.autoCleanedFiles = cleanedFiles;
                  executionResult.result.cleanupNotice = cleanupNotice.trim();
                }
              }
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
            if (rootCauseText) richSummaryParts.push(`\n**Nguyên nhân cốt lõi (Root Cause):**\n${rootCauseText}`);
            if (filesModifiedList.length > 0) {
              richSummaryParts.push(`\n**Các tệp đã chỉnh sửa (Modified Files):**\n${filesModifiedList.map((f: string) => `- \`${f}\``).join('\n')}`);
            }
            if (verificationText) {
              richSummaryParts.push(`\n**Bằng chứng kiểm chứng (Verification Evidence):**\n\`${verificationText}\``);
            }
            submittedSolutionSummary = richSummaryParts.length > 0 ? richSummaryParts.join('\n') : summaryText;

            this.verificationPolicy.recordVerification(
              String(toolArgs.verificationEvidence || 'submit_solution'),
              true,
              summaryText.slice(0, 240),
              0,
            );
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
            }
          }

          if (reflectionAnalysis.isFailure) {
            CLI.renderReflectionAlert(reflectionAnalysis.consecutiveFailures, reflectionAnalysis.advice);
            if (reflectionAnalysis.detectiveReport) {
              CLI.renderErrorDetectiveReport(reflectionAnalysis.detectiveReport);
            }
            this.kernel?.ctx.events.emit('tool:error', toolName, executionResult.result);
          } else if (toolName === 'run_command' && executionResult.result?.exitCode === 0) {
            this.reflectionEngine.reset();
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
              const interventionMsg = `${processIntervention.message}\n👉 Hành động gợi ý: ${processIntervention.suggestedAction}`;
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

          // SCAFFOLD-CEGIS & Domain Intent Drift Detection
          const domainIntentIntervention = this.domainIntentGuardian.observeToolCall({
            toolName,
            args: toolArgs,
          });
          if (domainIntentIntervention && typeof executionResult.result === 'object' && executionResult.result !== null) {
            try {
              const driftMsg = `${domainIntentIntervention.message}\n👉 Hướng dẫn chỉnh hướng: ${domainIntentIntervention.courseCorrectionGuidance}`;
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
            || (toolName === 'run_command' && isVerificationCommand(toolArgs.command));
          let lspPreExecutionWarning: string | undefined;
          if (isMutatingOrVerification && !isToolResultFailure(executionResult.result)) {
            consecutiveUnproductiveSteps = 0;
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
          } else if (!isMutatingOrVerification) {
            consecutiveUnproductiveSteps++;
          }

          // Hiển thị Cây kế hoạch nếu có cập nhật từ planning tools
          if (['create_plan', 'update_plan_task'].includes(toolName) && this.planManager.hasPlan()) {
            if (!this._collapsePreferences.compactSteps) {
              CLI.renderPlan(this.planManager.getTasks());
            }
          }


          // Ghi Tool Result vào Session (kèm Reflection Prompt hướng dẫn nếu có lỗi)
          const payloadToRecord = {
            ...executionResult.result,
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
            ...(cognitiveBrake.active
              ? { _system_cognitive_brake: `🛑 [COGNITIVE BRAKE ACTIVATED]: ${cognitiveBrake.reason}. ${cognitiveBrake.recommendedPivot}` }
              : {}),

            ...(progressDecision.message
              ? { _system_loop_guard: progressDecision.message }
              : {}),
          };

          session.addToolResultWithId(toolName, payloadToRecord, toolCallId);
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

          if (toolName === 'run_command' && isVerificationCommand(String(toolArgs?.command || ''))) {
            const isFailure = isToolResultFailure(executionResult.result) || executionResult.result?.exitCode !== 0;
            if (isFailure) {
              this.verificationPolicy.recordReproductionAttempt(String(toolArgs.command), true);
            }
          }
          this.lastToolExecution = {
            toolName,
            result: executionResult.result,
            guardianDiagnosis: executionResult.guardianDiagnosis,
          };
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
            };
            session.append('control/decision', { turn, step, controlDecision: batchTelemetry });
            this.kernel?.ctx.events.emit('tools:batch', batchTelemetry);
          }
          if (!deferReadPersistence || partitionEndIndex === callIndex) {
            await this.persistSession(session);
          }
          if (effect) {
            const outcome = executionResult.result.error || executionResult.result.errorCode ? 'error' : 'success';
            this.effectLedger.commit(effect.id, outcome);
            await this.persistSession(session);
          }

          if (progressDecision.shouldStop) {
            strategyChangeRequired = { toolName, repetitionCount: progressDecision.repetitionCount };
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
        session.append('step/end', { turn, step, reason: stepReason });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: stepReason,
        });

        if (!this._collapsePreferences.compactSteps) {
          CLI.renderStepFooter();
        }
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

        // submit_solution already contains a comprehensive, evidence-backed
        // summary. Reusing it avoids an otherwise redundant provider request
        // whose only purpose is to restate the same result.
        const isArchQuery = detectArchitectureAnalysisIntent(turnUserRequest).isArchitectureQuery;
        const isSummarySufficient = isComprehensiveSubmissionSummary(submittedSolutionSummary || '');
        const enableSubmitAutoFinalization = this.loopOptions?.enableSubmitAutoFinalization
          ?? envFeatureEnabled('MINUS_SUBMIT_AUTO_FINALIZATION', false);
        if (
          !isArchQuery
          && hasSubmittedSolution
          && isSummarySufficient
          && enableSubmitAutoFinalization
        ) {
          const finalAnswer = submittedSolutionSummary!;
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
                ? 'Giải pháp đã submit_solution thành công nhưng model chưa sinh câu trả lời văn bản. Đang kích hoạt Continuation Protocol...'
                : 'Model sinh suy luận System 2 nhưng chưa phát sinh tool_calls. Đang tự động kích hoạt Continuation Protocol...',
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
                ? 'Model trả về phản hồi rỗng sau khi submit_solution. Đang gửi lời nhắc yêu cầu báo cáo kết quả hoàn chỉnh...'
                : 'Model trả về phản hồi rỗng. Đang tự động kích hoạt Continuation Protocol để tiếp tục tác vụ...',
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

        const incompletePlanMessage = `Agent stopped explicitly: ${planBlocker} The model ignored ${maxPlanCompletionRetries} plan-continuation requests.`;
        await CLI.renderExecutionStopped(incompletePlanMessage, 'INCOMPLETE_PLAN');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'incomplete-plan-final-answer-terminal');
        this.goalManager.disarm();
        return incompletePlanMessage;
      }
      consecutivePlanCompletionRejects = 0;

      const completionState = getTurnCompletionState(session, turn);
      const hasCodeMutations = completionState.hasMutations;
      const codeChangeRequired = initialTurnClassification.requiredCapabilities.includes('edit')
        || initialTurnClassification.reasonCodes.includes('PARETO_UNCERTAINTY_REQUIRES_EVIDENCE');
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
      const evidenceDecision = (isSubagent || isMockLLM)
        ? { allow: true, reasons: [] }
        : this.completionEvidenceGate.evaluate(finalAnswer, session, {
          turn,
          codeChangeRequired,
          userRequest: turnUserRequest,
          hasSubmittedSolution,
        });
      const activeSkills = session.getActiveSkillDecisions().map((decision) => decision.skillId);
      if (this.planManager.getRequirements().verificationRequired && this.planManager.hasPlan()) {
        activeSkills.push('verification-before-completion');
      }
      const verificationDecision = (hasSubmittedSolution || isSubagent || isMockLLM || (!hasCodeMutations && !codeChangeRequired))
        ? { allowed: true }
        : this.verificationPolicy.canComplete(activeSkills);
      const criticDecision = (isSubagent || isMockLLM)
        ? { approved: true, score: 100, invariantViolations: [], lspErrors: [], reasons: [] }
        : this.criticGate.evaluate({
          finalAnswer,
          session,
          workspace: this._workspace,
          hypothesisTracker: this.hypothesisTracker,
          userRequest: turnUserRequest,
          turn,
          hasSubmittedSolution,
          filesModified: completionState.filesModified,
          completionState,
          evidenceDecision,
        });
      const finalAnswerDecision: Omit<FinalAnswerGuardDecision, 'reason'> & { reason?: string } = (isSubagent || isMockLLM)
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
                : { allow: true });

      if (!finalAnswerDecision.allow) {
        {
          consecutiveIncompleteFinals++;
          const canRetryIncompleteFinal = consecutiveIncompleteFinals <= maxIncompleteFinalRetries;
          this.adaptiveReasoning.escalate(finalAnswerDecision.reason || 'completion-gate-rejection');
          const reasoningGuidance = this.adaptiveReasoning.getGuidancePrompt();

          const actionMandate = buildCompletionRecoveryPrompt({
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
              ? `Final Answer chưa vượt qua completion gate (${finalAnswerDecision.reason || 'policy'}). Agent sẽ tiếp tục ngay trong lượt hiện tại.`
              : 'Model liên tục trả về Final Answer không có đủ evidence, kết quả, hoặc blocker thực. Turn sẽ kết thúc với thông báo rõ ràng.',
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
    if (!objective) objective = 'Tác vụ lập trình';
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
      ? 'Đã xác thực test thành công (exitCode: 0)'
      : testsFailed
        ? 'Test chưa pass hoàn toàn'
        : filesList.length > 0 ? 'Đã chỉnh sửa code' : 'Đã khảo sát';

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

    const summaryStatement = `[Phiên ${session.id.slice(0, 10)}] Mục tiêu: "${compactObjective}". Files sửa: ${filesList.join(', ') || 'không'}. Kết quả: ${verificationOutcome}.${finalSummary ? ` Tóm tắt: ${finalSummary}` : ''}`;

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
      }
    } finally {
      this.drainingInbox = false;
      this.drainingSessionId = undefined;
    }
  }

  private collectVerificationDiagnostics(): VerificationFailureItem[] | undefined {
    try {
      return getOrCreateTypeScriptService(this._workspace).getDiagnostics()
        .filter((item) => item.category === 'error')
        .map((item): VerificationFailureItem => ({
          id: `ts-${item.code}-${item.file}-${item.line}`,
          source: 'diagnostics',
          file: item.file,
          line: item.line,
          message: item.message,
        }));
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
    _signal: AbortSignal,
  ): AgentLoop {
    const childRegistry = new ToolRegistry();
    const forbidden = new Set(['delegate_agent', 'spawn_agent', 'get_agent_result', 'wait_agent', 'stop_agent', 'resume_agent']);
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
    return new AgentLoop(this.llm, childRegistry, {
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
  }
}
