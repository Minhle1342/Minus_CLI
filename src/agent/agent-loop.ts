import path from 'node:path';
import { ToolRegistry, ToolScope } from '../tools/registry.js';
import { ToolProvider } from '../tools/registry.js';
import { ToolRunner, type ToolExecutionResult } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';
import { AgentLoopOptions } from './types.js';
import { CheckpointManager } from '../workspace/checkpoint.js';
import { CLI, UICollapsePreferences, DEFAULT_COLLAPSE_PREFERENCES } from '../ui/cli-ui.js';
import { ContextCompactor } from './context-compactor.js';
import { PlanManager } from './plan-manager.js';
import { ReflectionEngine } from './reflection-engine.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
import type { MemoryRecord } from '../memory/types.js';
import { AgentKernel, KernelContext } from '../kernel/kernel.js';
import { SessionPersistence } from '../session/session-persistence.js';
import { GoalManager } from './goal-manager.js';
import { AgentHookContext, AgentHookRegistry } from './agent-hooks.js';
import { AgentInbox, AgentInputSource } from './agent-inbox.js';
import { PromptAssembler } from '../llm/prompt-assembler.js';
import { CODING_AGENT_SYSTEM_PROMPT } from '../llm/prompts.js';
import { AgentRegistry, AgentStatus } from './agent-registry.js';
import { SubagentManager, SubagentOptions } from './subagent-manager.js';
import { EffectLedger } from './effect-ledger.js';
import { LoopProgressGuard } from './loop-progress-guard.js';
import { FinalAnswerGuard } from './final-answer-guard.js';
import { createDelegateAgentTool, createSpawnAgentTool, createWaitAgentTool, createGetAgentResultTool, createResumeAgentTool, createStopAgentTool } from '../tools/subagent-tools.js';
import { classifyGitCommand } from '../tools/git-command-policy.js';
import { CompletionEvidenceGate, isToolResultFailure, isVerificationCommand } from './completion-evidence.js';
import { VerificationPolicy } from '../skills/verification-policy.js';
import { type LLMRequestOptions } from '../llm/gemini.js';
import { HypothesisTracker } from './hypothesis-tracker.js';
import { SpeculativeBranchManager } from './speculative-branch-manager.js';
import { CriticGate } from './critic-gate.js';
import { registerSubmitSolutionTool } from '../tools/submit-solution.js';
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
import { partitionToolCalls, type ScheduledToolCall, type ToolCallPartition } from './tool-execution-scheduler.js';
import { PipelinedToolDispatcher } from './pipelined-tool-dispatcher.js';
import { CognitiveHarness } from './cognitive-harness.js';

function envFeatureEnabled(name: string, defaultValue = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return !['0', 'false', 'off', 'disabled'].includes(value);
}

function envFiniteNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : undefined;
}

function isComprehensiveSubmissionSummary(value: string): boolean {
  return value.trim().length >= 80 && value.trim().split(/\s+/).length >= 12;
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
  readonly planManager: PlanManager;
  readonly goalManager: GoalManager;
  readonly agentHooks: AgentHookRegistry;
  readonly inbox: AgentInbox;
  readonly promptAssembler: PromptAssembler;
  readonly agentRegistry: AgentRegistry;
  readonly agentId: string;
  readonly subagentManager: SubagentManager;
  readonly effectLedger: EffectLedger;
  readonly progressGuard = new LoopProgressGuard();
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
  readonly kernel?: AgentKernel;
  private sessionPersistence?: SessionPersistence;
  private _isGoalMode: boolean = false;
  private drainingInbox = false;
  private drainingSessionId?: string;
  private drainScheduled = false;
  private runQueues = new Map<string, Promise<string>>();
  private activeSession?: Session;
  private loopOptions?: AgentLoopOptions;
  readonly toolAdvisor = new ToolSynergyAdvisor();
  readonly repositoryMap: GraphRankedRepositoryMap;
  readonly repositoryMemory: CitationValidatedRepositoryMemory;
  private lastToolExecution?: { toolName: string; result: any };
  readonly classificationEngine = new ClassificationEngine();
  readonly thisTurnToolGate = new ThisTurnToolGate();
  readonly toolControlTelemetry = new ToolControlTelemetry();
  readonly latencyOrchestrator: LatencyOrchestrator;
  readonly dynamicContextCache = new DynamicContextCache<{
    repositoryMemoryContext: string;
    repositoryMemoryRecords: Awaited<ReturnType<CitationValidatedRepositoryMemory['recall']>>['records'];
    repositoryContext: string;
  }>();
  readonly pipelinedDispatcher = new PipelinedToolDispatcher();
  private _latestReasoning?: { thought: string; timestamp: string; step: number; turn: number };
  private _collapsePreferences: UICollapsePreferences = { ...DEFAULT_COLLAPSE_PREFERENCES };

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
      this.maxSteps = options?.maxSteps ?? Infinity;
      this.sessionPersistence = options?.sessionPersistence;
      registerSubmitSolutionTool(this.toolRegistry, this._workspace);
      this.kernel.init().catch(() => {});
    } else {
      this.llm = kernelOrLLM;
      this._workspace = options?.workspace ?? new Workspace();
      this.toolRegistry = toolRegistry ?? new ToolRegistry();
      this.toolProvider = options?.toolScope || this.toolRegistry;
      this.toolRunner = new ToolRunner(this.toolProvider, this._workspace);
      this.maxSteps = options?.maxSteps ?? Infinity;
      this.checkpointManager = options?.checkpointManager ?? new CheckpointManager(this._workspace.rootDir);
      this.contextCompactor = options?.contextCompactor ?? new ContextCompactor();
      this.planManager = new PlanManager();
      this.goalManager = new GoalManager();
      this.agentHooks = new AgentHookRegistry();
      this.inbox = new AgentInbox();
      this.promptAssembler = new PromptAssembler(CODING_AGENT_SYSTEM_PROMPT);
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
      this.sessionPersistence = options?.sessionPersistence;

      // Đăng ký các planning và memory tools vào toolRegistry
      this.toolRegistry.attachPlanManager(this.planManager);
      this.toolRegistry.attachMemoryManager(this.memoryManager);
      this.toolRegistry.attachRepositoryMemory(this.repositoryMemory);
      registerSubmitSolutionTool(this.toolRegistry, this._workspace);

      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(this._workspace).catch(() => {});
      this.repositoryMemory.init().catch(() => {});
    }

    // Bảo tồn KV-Cache Prefix của OpenAI Codex trong suốt vòng lặp
    this.contextCompactor.setConfig({ preservePrefixCache: true });
    this.latencyOrchestrator = new LatencyOrchestrator({
      enabled: options?.enableLatencyOptimization
        ?? envFeatureEnabled('MINUS_LATENCY_OPTIMIZATION'),
      softStepTargetMs: options?.softStepTargetMs
        ?? envFiniteNumber('MINUS_SOFT_STEP_TARGET_MS'),
      requestBudgetRatio: options?.requestCompactionRatio
        ?? envFiniteNumber('MINUS_REQUEST_COMPACTION_RATIO'),
    });

    this.agentRegistry.register(this.agentId, this.agentId);
    this.subagentManager = new SubagentManager(
      this.agentRegistry,
      (agentId, session, subagentOptions, signal) => this.createSubagentLoop(agentId, session, subagentOptions, signal),
      (session) => this.persistSession(session),
    );
    if (options?.enableSubagents !== false) {
      this.toolRegistry.register(createDelegateAgentTool(this.subagentManager));
      this.toolRegistry.register(createSpawnAgentTool(this.subagentManager));
      this.toolRegistry.register(createWaitAgentTool(this.subagentManager));
      this.toolRegistry.register(createGetAgentResultTool(this.subagentManager));
      this.toolRegistry.register(createStopAgentTool(this.subagentManager));
      this.toolRegistry.register(createResumeAgentTool(this.subagentManager));
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
      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(workspace).catch(() => {});
      this.repositoryMemory.init().catch(() => {});
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

  async run(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal }): Promise<string> {
    const previous = this.runQueues.get(session.id) || Promise.resolve('');
    const current = previous.then(
      () => this.runInternal(session, options),
      () => this.runInternal(session, options),
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
        } catch {}
        this.setAgentStatus('idle', session);
        await CLI.renderExecutionStopped(
          'Agent stopped: cancellation requested.',
          'CANCELLED' as any,
        );
        return 'Tác vụ đã được dừng theo yêu cầu của người dùng.';
      }

      // Preserve an auditable, balanced lifecycle even when a provider, hook,
      // persistence adapter, or tool pipeline throws unexpectedly.
      const errClassification = classifyLLMError(error);
      const isQuotaOrRateLimit = errClassification.kind === 'HARD_QUOTA_EXHAUSTED' || errClassification.kind === 'TRANSIENT_RATE_LIMIT';

      if (isQuotaOrRateLimit) {
        try {
          await this.checkpointManager.createCheckpoint('Suspended: LLM Quota or Rate Limit reached', {
            isTaskCheckpoint: true,
            taskId: this.planManager.getActiveTask()?.id ? `task-${this.planManager.getActiveTask()?.id}` : undefined,
          });
        } catch {}

        this.goalManager.pause(`LLM ${errClassification.kind}: ${errClassification.message}`);
        session.append('goal/change', {
          reason: 'suspended_quota_limit',
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

      this.setAgentStatus(isQuotaOrRateLimit ? 'idle' : 'error', session);
      const detail = error instanceof Error ? error.message : String(error);
      try {
        if (isQuotaOrRateLimit) {
          const quotaAdvice = errClassification.kind === 'HARD_QUOTA_EXHAUSTED'
            ? `LLM Quota Exceeded (Hạn mức API đã hết). Bạn có thể đổi sang model khác bằng lệnh /model, hoặc kiểm tra gói cước billing trước khi tiếp tục.`
            : `LLM Rate Limit Exceeded (Giới hạn tần suất 429). Hệ thống đã tự động lưu tiến độ kế hoạch. Bạn có thể đợi vài phút rồi dùng /goal resume hoặc /plan resume.`;
          await CLI.renderExecutionStopped(
            `Agent suspended: ${quotaAdvice}\nChi tiết: ${detail}`,
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

  private async runInternal(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal }): Promise<string> {
    this.activeSession = session;
    const turnUserEvent = [...session.getEvents()].reverse().find(
      (event) => event.type === 'user/message' && event.data.source !== 'system',
    );
    const turnUserRequest = turnUserEvent?.data.content?.parts
      ?.map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n') || '';
    this.planManager.bindSession(session);
    this.goalManager.bindSession(session);
    this.memoryManager.bindSession(session);
    this.repositoryMemory.bindSession(session);
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    this.reflectionEngine.reset();
    this.progressGuard.reset();
    this.finalAnswerGuard.reset();
    this.verificationPolicy.reset();
    this.cognitiveHarness.reset();
    const isGoal = options?.isGoalMode ?? this._isGoalMode;
    const effectiveMaxSteps = options?.maxSteps ?? this.maxSteps;
    const turn = session.getEvents().filter((event) => event.type === 'turn/start').length + 1;
    const isContinuationOrGoal = isGoal || turnUserRequest.includes('[RESUME INCOMPLETE PLAN]') || turnUserRequest.includes('[GOAL CONTINUATION]');
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
      return rejectionMessage;
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
        if (isGoal) {
          prefix += `[AUTONOMOUS GOAL MODE ACTIVE - UNLIMITED STEPS]:\nYou are operating in autonomous Goal Mode without step limits. Continue executing tools, inspecting, decomposing plans, writing/modifying code, and verifying results until the entire goal is completely achieved. Only return your final response once all steps and empirical verifications have succeeded.\n\n`;
        } else if (!isFinite(effectiveMaxSteps)) {
          prefix += `[DYNAMIC CONVERGENCE ACTIVE - UNBOUNDED EXECUTION]:\nYou are operating in dynamic convergence mode without arbitrary step limits. Continue executing tools, inspecting, coding, and verifying results until the task is completely achieved and empirically verified. Do not stop prematurely.\n\n`;
        }
        const initialScaffold = this.cognitiveHarness.createScaffold({
          request: userText,
          phase: 'explore',
        });
        prefix += `${this.cognitiveHarness.formatScaffoldForPrompt(initialScaffold)}\n\n`;
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
        return cancellationMessage;
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
      // 2. Tối ưu hoá ngữ cảnh và nén Token (Context Compaction)
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
      const activeStepQuery = [
        turnUserRequest,
        activeTask?.title || '',
        activeTask?.acceptanceCriteria || '',
        activeTask?.notes || '',
      ].filter(Boolean).join(' ');
      const classification = this.classificationEngine.classify({
        request: turnUserRequest,
        activeTask: activeTask?.title,
        activeAcceptance: activeTask?.acceptanceCriteria,
        hasPlan: this.planManager.hasPlan(),
        hasUnverifiedChanges: this.verificationPolicy.hasPendingModifications(),
        lastToolName: this.lastToolExecution?.toolName,
        lastToolFailed: Boolean(this.lastToolExecution && isToolResultFailure(this.lastToolExecution.result || {})),
        previous: previousClassification,
      });
      previousClassification = classification;

      const adviceInfo = this.toolAdvisor.advise({
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        hasErrors: this.lastToolExecution?.result?.error !== undefined,
        activeTaskTitle: activeTask?.title,
      });

      // Hiển thị Step Header kèm Workflow Pipeline breadcrumb
      CLI.renderStepHeader(step, effectiveMaxSteps, {
        phase: classification.phase,
        activeTask: activeTask?.title,
        playbook: adviceInfo.playbook,
        risk: classification.risk,
        isGoal,
      });

      if (step === 1 || this.reflectionEngine.getConsecutiveFailures() > 1) {
        const activeScaffold = this.cognitiveHarness.createScaffold({
          request: turnUserRequest,
          phase: classification.phase,
          activeTask: activeTask?.title,
          consecutiveFailures: this.reflectionEngine.getConsecutiveFailures(),
        });
        CLI.renderCognitiveScaffold(this.cognitiveHarness.formatScaffoldForUI(activeScaffold));
      }

      const safetyCeiling = envFiniteNumber('MINUS_SAFETY_MAX_STEPS') ?? 500;
      if (!isFinite(effectiveMaxSteps) && step >= safetyCeiling) {
        const circuitBreakerMessage = `Agent stopped: Dynamic convergence safety ceiling (${safetyCeiling} steps) reached without final answer.`;
        CLI.renderModelAction('max_steps');
        CLI.renderStepFooter();
        await CLI.renderExecutionStopped(circuitBreakerMessage, 'CIRCUIT_BREAKER_REACHED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'circuit-breaker-reached');
        this.goalManager.disarm();
        return circuitBreakerMessage;
      }

      if (!isFinite(effectiveMaxSteps) && consecutiveUnproductiveSteps >= 18) {
        const stagnationMessage = `Agent stopped: Convergence stagnation detected (${consecutiveUnproductiveSteps} consecutive inspection steps without progress).`;
        CLI.renderModelAction('max_steps');
        CLI.renderStepFooter();
        await CLI.renderExecutionStopped(stagnationMessage, 'STAGNATION_LIMIT_REACHED');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'stagnation-limit-reached');
        this.goalManager.disarm();
        return stagnationMessage;
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
      const activeToolDeclarations = (dynamicRetrievalEnabled && typeof candidateProvider.getRelevantTools === 'function')
        ? candidateProvider.getRelevantTools(activeStepQuery)
        : candidateProvider.getFunctionDeclarations();
      const visibleToolNames = activeToolDeclarations.map((tool: any) => String(tool.name)).filter(Boolean).sort();
      const activeToolSetHash = hashAllowedToolSet(visibleToolNames);
      const activeDecisionId = `${recommendedToolDecision.id}-${activeToolSetHash.slice(0, 8)}`;
      const stepToolProvider = toolControlMode === 'enforce'
        ? new ToolScope(`turn-${turn}-step-${step}-runtime`, candidateProvider, visibleToolNames)
        : this.toolProvider;
      const stepToolRunner = toolControlMode === 'enforce'
        ? this.toolRunner.createScoped(stepToolProvider)
        : this.toolRunner;
      if (toolControlMode !== 'off') {
        session.append('control/decision', {
          turn,
          step,
          controlDecision: {
            mode: toolControlMode,
            classification,
            toolDecision: {
              ...recommendedToolDecision,
              id: activeDecisionId,
              visibleToolNames,
              allowedToolSetHash: activeToolSetHash,
            },
          },
        });
      }

      let response;
      // System Prompt 100% STATIC để tối đa hóa KV-Cache Hit Rate (>80%) theo chuẩn OpenAI Codex
      const assembledSystemPrompt = this.promptAssembler.assemble();
      const rawPlanContext = this.planManager.renderExecutionContext();
      const advicePrompt = this.toolAdvisor.formatAdvicePrompt({
        lastToolName: this.lastToolExecution?.toolName,
        lastToolResult: this.lastToolExecution?.result,
        hasErrors: this.lastToolExecution?.result?.error !== undefined,
        activeTaskTitle: activeTask?.title,
        activeTaskAcceptance: activeTask?.acceptanceCriteria,
      });
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

      const effectiveRepoMemTokens = isLocalizedExecution
        ? Math.min(300, configuredRepoMemTokens)
        : configuredRepoMemTokens;
      const effectiveRepoMapTokens = isLocalizedExecution
        ? 0
        : configuredRepoMapTokens;

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
      const mockModel = Boolean(this.llm?.constructor?.name?.includes('Mock') || process.env.NODE_ENV === 'test');
      let repositoryMemoryContext = '';
      let repositoryMemoryRecords: Awaited<ReturnType<CitationValidatedRepositoryMemory['recall']>>['records'] = [];
      let repositoryContext = '';
      const dynamicCacheEnabled = this.loopOptions?.enableDynamicContextCache
        ?? envFeatureEnabled('MINUS_DYNAMIC_CONTEXT_CACHE');
      const dynamicCacheKey = JSON.stringify({
        workspace: this._workspace.rootDir,
        activeStepQuery,
        activeTask: activeTask ? {
          id: activeTask.id,
          readSet: activeTask.readSet,
          writeSet: activeTask.writeSet,
          symbols: activeTask.symbols,
        } : undefined,
        relevantMemory: relevantMemory.map((item) => [item.key, item.confidence, item.insight]),
        registeredFiles: composeState?.registeredFiles || [],
        repositoryMemoryEnabled: this.loopOptions?.enableRepositoryMemory !== false,
        repositoryMemoryTokens: effectiveRepoMemTokens,
        repositoryMapEnabled: this.loopOptions?.enableGraphRepositoryMap !== false && !mockModel && effectiveRepoMapTokens > 0,
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
        if (this.loopOptions?.enableRepositoryMemory !== false && effectiveRepoMemTokens > 0) {
          try {
            const recalled = await this.repositoryMemory.recall(activeStepQuery, {
              limit: isLocalizedExecution ? 4 : 12,
              maxTokens: effectiveRepoMemTokens,
            });
            repositoryMemoryContext = recalled.rendered;
            repositoryMemoryRecords = recalled.records;
          } catch {
            // Repository memory is an independent, fail-open context source.
          }
        }
        if (this.loopOptions?.enableGraphRepositoryMap !== false && !mockModel && effectiveRepoMapTokens > 0) {
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
                ...(composeState?.registeredFiles || []),
                ...repositoryMemoryRecords.flatMap((item) => item.relatedFiles),
              ],
              seedSymbols: activeTask?.symbols || [],
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
      let dynamicExecutionContext = [memoryPrompt, repositoryMemoryContext, rawPlanContext, composeContext, repositoryContext, advicePrompt].filter(Boolean).join('\n\n');
      const activeTokenConfig = typeof this.llm.getTokenConfig === 'function'
        ? (this.llm.getTokenConfig() || {})
        : {};
      const activeModelName = this.llm?.getActiveProvider?.()?.name
        || this.llm?.modelName
        || this.llm?.constructor?.name
        || 'unknown';
      const latencyProfile = this.latencyOrchestrator.getModelProfile(activeModelName, activeTokenConfig);
      let requestFootprint = this.latencyOrchestrator.estimateRequest({
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
        dynamicContext: dynamicExecutionContext,
        maxInputTokens: activeTokenConfig.maxInputTokens,
        maxOutputTokens: activeTokenConfig.maxOutputTokens,
      });
      const latencyGuidance = this.latencyOrchestrator.buildGuidance({
        step,
        footprint: requestFootprint,
        modelName: activeModelName,
        tokenConfig: activeTokenConfig,
        phase: classification.phase,
        verificationReady: this.verificationPolicy.canComplete().allowed
          && (!this.planManager.hasPlan() || this.planManager.isAllTasksCompleted()),
      });
      if (latencyGuidance) {
        dynamicExecutionContext = [dynamicExecutionContext, latencyGuidance].filter(Boolean).join('\n\n');
        requestFootprint = this.latencyOrchestrator.estimateRequest({
          systemPrompt: assembledSystemPrompt,
          tools: activeToolDeclarations,
          history: session.getHistory(),
          dynamicContext: dynamicExecutionContext,
          maxInputTokens: activeTokenConfig.maxInputTokens,
          maxOutputTokens: activeTokenConfig.maxOutputTokens,
        });
      }

      // Budget the complete model-visible request, not history alone. This is
      // proactive compaction at a safe provider-turn boundary, not a timeout.
      const compactionResult = this.contextCompactor.compact(session.getHistory(), {
        requestOverheadTokens: requestFootprint.nonHistoryTokens,
        outputReserveTokens: requestFootprint.outputReserveTokens,
        triggerRatio: this.loopOptions?.requestCompactionRatio
          ?? envFiniteNumber('MINUS_REQUEST_COMPACTION_RATIO')
          ?? 0.82,
      });
      if (compactionResult.stats.charsSaved > 0) {
        session.setHistory(compactionResult.messages);
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

      session.recordRequestHeader({
        turn,
        step,
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
      }, { compactHistory: true });
      session.assertRuntimeInvariants({ allowOpenLifecycle: true, verifyRequestReplay: 'latest' });
      await this.persistSession(session);
      const requestOptions: LLMRequestOptions = {
        systemPrompt: assembledSystemPrompt,
        dynamicContext: dynamicExecutionContext,
        sessionId: session.id,
        promptCacheKey: session.id,
        enablePromptCaching: this.loopOptions?.enablePromptCaching !== false,
        signal: options?.signal,
      };
      const requestStartedAt = Date.now();
      let firstTokenAt: number | undefined;
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
      const requestDurationMs = Date.now() - requestStartedAt;
      const timeToFirstTokenMs = firstTokenAt === undefined ? undefined : firstTokenAt - requestStartedAt;
      response.usage = {
        ...(response.usage || {}),
        requestDurationMs,
        ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
      };
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
          hardTimeoutApplied: false,
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

      if (!isSubagent) {
        CLI.renderLLMThinking(stepSummary);
      }

      // Giám sát và hiển thị Prompt Cache Hit Rate / Token Telemetry
      if (response.usage) {
        this.kernel?.ctx.events.emit('model:usage', response.usage);
        CLI.renderCacheUsage(response.usage);
      }

      // System 2: Hiển thị mạch suy luận nội tâm sâu (Deep Reasoning / CoT) nếu có
      if (response.reasoningContent) {
        this._latestReasoning = {
          thought: response.reasoningContent,
          timestamp: new Date().toLocaleTimeString(),
          step,
          turn: (session as any).turnsCount || 1,
        };
        CLI.renderReasoning(response.reasoningContent, { collapsed: this._collapsePreferences.thinking || this._collapsePreferences.compactSteps });
        this.kernel?.ctx.events.emit('model:thought', response.reasoningContent);
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
        CLI.renderModelAction('tool_call', `Requesting ${response.toolCalls.length} tool call(s)`);

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
          // Chặn các lệnh kiểm thử / submit dư thừa nếu nhiệm vụ đã được submit_solution hoàn tất và không có thay đổi file mới
          let executionResult: ToolExecutionResult;
          if (preexecutedReadResult) {
            executionResult = preexecutedReadResult;
          } else if (hasSubmittedSolution && (toolName === 'submit_solution' || (toolName === 'run_command' && isVerificationCommand(toolArgs.command)))) {
            const redundantPayload = {
              success: true,
              submitted: true,
              summary: submittedSolutionSummary || 'Task completed and submitted.',
              nextAction: 'final_answer',
              message: 'Solution has already been submitted and verified. No files have changed since submission. Do not execute further verification tools; conclude your turn with your final response to the user immediately.',
            };
            executionResult = { toolName, args: toolArgs, durationMs: 0, result: redundantPayload };
          } else {
            // Chạy tool qua pipeline an toàn
            const completionEvidence = toolName === 'submit_solution'
              ? this.completionEvidenceGate.evaluate('', session, {
                  turn,
                  codeChangeRequired: this.verificationPolicy.hasPendingModifications()
                    || Boolean(this.planManager.getTasks().some((task: any) => (task.writeSet || []).length > 0)),
                })
              : undefined;
            const policyCompletion = toolName === 'submit_solution'
              ? this.verificationPolicy.canComplete()
              : undefined;
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
                } : {}),
              },
              toolCallId,
            );
            executionResult = pipelinedOutcome.executionResult;
            if (executionResult.result.errorCode === 'TOOL_NOT_ALLOWED_THIS_TURN') {
              this.toolControlTelemetry.recordDeniedCall();
            }
          }

          if (this._collapsePreferences.compactSteps) {
            CLI.renderCompactStepLine(toolName, toolArgs, executionResult.durationMs, executionResult.result);
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
          const reflectionAnalysis = this.reflectionEngine.analyze({
            toolName,
            args: toolArgs,
            result: executionResult.result,
            durationMs: executionResult.durationMs,
          }, this._workspace);
          this.finalAnswerGuard.observeToolResult(toolName, executionResult.result);
          this.planManager.recordToolEvidence(toolName, toolArgs, executionResult.result, {
            granted: executionResult.permission?.status === 'granted',
            requestId: executionResult.permission?.requestId,
          });
          this.repositoryMap.observeToolResult(toolName, toolArgs, executionResult.result);
          if (sideEffect && !isToolResultFailure(executionResult.result)) {
            this.dynamicContextCache.invalidate();
          }
          if (!isToolResultFailure(executionResult.result) && ['write_file', 'replace_text', 'apply_patch', 'create_file', 'delete_file', 'move_file'].includes(toolName)) {
            const mutatedPath = String(toolArgs.path || toolArgs.filePath || toolArgs.targetFile || '');
            const blast = executionResult.result?.blastRadius;
            this.verificationPolicy.recordModification(mutatedPath, {
              impactedTestSuites: blast?.impactedTestSuites,
              risk: blast?.risk,
            });
            hasSubmittedSolution = false;
            if (mutatedPath) {
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
          }
          if (toolName === 'submit_solution' && !isToolResultFailure(executionResult.result)) {
            hasSubmittedSolution = true;
            submittedSolutionSummary = String(toolArgs.summary || '').trim();
            this.verificationPolicy.recordVerification(
              String(toolArgs.verificationEvidence || 'submit_solution'),
              true,
              submittedSolutionSummary.slice(0, 240),
              0,
            );
          }

          if (reflectionAnalysis.isFailure) {
            CLI.renderReflectionAlert(reflectionAnalysis.consecutiveFailures, reflectionAnalysis.advice);
            if (reflectionAnalysis.detectiveReport) {
              CLI.renderErrorDetectiveReport(reflectionAnalysis.detectiveReport);
            }
            this.kernel?.ctx.events.emit('tool:error', toolName, executionResult.result);
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

          const isMutatingOrVerification = ['write_file', 'replace_text', 'apply_patch', 'create_file', 'delete_file', 'move_file', 'submit_solution'].includes(toolName)
            || (toolName === 'run_command' && isVerificationCommand(toolArgs.command));
          if (isMutatingOrVerification && !isToolResultFailure(executionResult.result)) {
            consecutiveUnproductiveSteps = 0;
          } else if (!isMutatingOrVerification) {
            consecutiveUnproductiveSteps++;
          }

          // Hiển thị Cây kế hoạch nếu có cập nhật từ planning tools
          if (['create_plan', 'update_plan_task'].includes(toolName) && this.planManager.hasPlan()) {
            CLI.renderPlan(this.planManager.getTasks());
          }


          // Ghi Tool Result vào Session (kèm Reflection Prompt hướng dẫn nếu có lỗi)
          const payloadToRecord = {
            ...executionResult.result,
            ...(reflectionAnalysis.reflectionPrompt
              ? { _system_reflection_prompt: reflectionAnalysis.reflectionPrompt }
              : {}),
            ...(cognitiveBrake.active
              ? { _system_cognitive_brake: `🛑 [COGNITIVE BRAKE ACTIVATED]: ${cognitiveBrake.reason}. ${cognitiveBrake.recommendedPivot}` }
              : {}),
            ...(consecutiveUnproductiveSteps === 10 && !isFinite(effectiveMaxSteps)
              ? { _system_convergence_directive: '[DYNAMIC CONVERGENCE NOTICE]: 10 consecutive inspection steps executed without state modification or verification. Synthesize your findings now and proceed to implementation or final response.' }
              : {}),
            ...(progressDecision.message
              ? { _system_loop_guard: progressDecision.message }
              : {}),
          };

          session.addToolResultWithId(toolName, payloadToRecord, toolCallId);
          if (this.loopOptions?.enableRepositoryMemory !== false) {
            await this.repositoryMemory.observeToolResult(session, toolName, toolArgs, executionResult.result, session.seq).catch(() => {});
          }
          this.lastToolExecution = { toolName, result: executionResult.result };
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

        // submit_solution already contains a comprehensive, evidence-backed
        // summary. Reusing it avoids an otherwise redundant provider request
        // whose only purpose is to restate the same result.
        if (
          hasSubmittedSolution
          && isComprehensiveSubmissionSummary(submittedSolutionSummary || '')
          && (this.loopOptions?.enableSubmitAutoFinalization
            ?? envFeatureEnabled('MINUS_SUBMIT_AUTO_FINALIZATION'))
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
          const noProgressMessage = `Agent stopped: the model repeated tool ${strategyChangeRequired.toolName} without progress and ignored ${maxNoProgressStrategyChanges} consecutive strategy-change requests. The turn was ended explicitly to prevent an infinite loop.`;
          await CLI.renderExecutionStopped(noProgressMessage, 'REPEATED_NO_PROGRESS');
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'repeated-no-progress-terminal');
          this.goalManager.disarm();
          return noProgressMessage;
        }

        if (!isMockLLM && process.env.NODE_ENV !== 'test' && this.lastToolExecution && isToolResultFailure(this.lastToolExecution.result || {})) {
          // Pacing delay on tool failure to mitigate LLM API burst rate limiting (429)
          await new Promise((resolve) => setTimeout(resolve, 600));
        }

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 5. Continuation Protocol: Tự động khôi phục khi gặp Turn rỗng (Chống dừng sớm)
      if (!hasValidText) {
        // Post-Submission Graceful Auto-Finalization (Codex CLI Standard):
        // Nếu đã submit_solution thành công và có summary đầy đủ mà model sinh turn rỗng/chỉ reasoning, chốt Final Answer ngay lập tức
        if (hasSubmittedSolution && submittedSolutionSummary) {
          const earlyCritic = this.criticGate.evaluate({
            finalAnswer: submittedSolutionSummary,
            session,
            workspace: this._workspace,
            turn,
            hasSubmittedSolution: true,
          });
          if (!earlyCritic.approved) {
            CLI.renderReflectionAlert(
              1,
              `Post-submission syntax or missing import check failed. Continuing turn to fix compiler issues...`,
            );
            session.addUserMessage(earlyCritic.critiquePrompt || 'Please fix syntax / missing import errors before completing.', 'system');
            await this.persistSession(session);
            CLI.renderStepFooter();
            session.append('step/end', { turn, step, reason: 'unresolved-syntax-error' });
            await this.persistSession(session);
            await this.agentHooks.run('agent/after-step', {
              ...hookContext,
              reason: 'unresolved-syntax-error',
            });
            this.kernel?.ctx.events.emit('step:after', step);
            continue;
          }

          const finalAnswer = submittedSolutionSummary;
          CLI.renderModelAction('final_answer');
          CLI.renderStepFooter();
          await CLI.renderFinalAnswer(finalAnswer);
          this.kernel?.ctx.events.emit('model:final_answer', finalAnswer);
          session.addModelMessage({ text: finalAnswer, rawContent: response.rawContent });
          await this.persistSession(session);
          session.append('step/end', { turn, step, reason: 'submitted-solution-final-answer' });
          await this.persistSession(session);
          await this.agentHooks.run('agent/after-step', {
            ...hookContext,
            reason: 'submitted-solution-final-answer',
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
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');
          return finalAnswer;
        }

        consecutiveEmptyTurns++;

        if (consecutiveEmptyTurns <= maxEmptyRetries) {
          if (hasReasoning) {
            if (consecutiveEmptyTurns > 1) {
              CLI.renderReflectionAlert(
                consecutiveEmptyTurns,
                'Model sinh suy luận System 2 nhưng chưa phát sinh tool_calls. Đang tự động kích hoạt Continuation Protocol...'
              );
            }
            const noteText = hasSubmittedSolution
              ? `[SYSTEM NOTE]: The solution has already been verified and submitted via submit_solution. Do NOT call any further tools. Output your final comprehensive response to the user now in the EXACT SAME LANGUAGE as the user's original request prompt (e.g. Vietnamese if the user asked in Vietnamese). Present your findings, file paths, code logic, and verification proof clearly.`
              : '[SYSTEM NOTE]: You completed your internal reasoning monologue but did not provide any tool calls or final user-facing response. Please proceed immediately to execute the next tool call according to your plan or provide the final answer to the user.';
            session.addUserMessage(noteText);
            await this.persistSession(session);
          } else {
            CLI.renderReflectionAlert(
              consecutiveEmptyTurns,
              'Model trả về phản hồi rỗng. Đang tự động kích hoạt Continuation Protocol để tiếp tục tác vụ...'
            );
            const noteText = hasSubmittedSolution
              ? `[SYSTEM NOTE]: The solution has already been verified and submitted via submit_solution. Do NOT call any further tools. Output your final comprehensive response to the user now in the EXACT SAME LANGUAGE as the user's original request prompt (e.g. Vietnamese if the user asked in Vietnamese). Present your findings, file paths, code logic, and verification proof clearly.`
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

        // Nếu đã thử re-prompt 3 lần mà vẫn không có text nhưng có reasoning, dùng reasoning làm fallback
        if (hasReasoning) {
          const planBlocker = this.planManager.getCompletionBlocker();
          if (planBlocker) {
            consecutivePlanCompletionRejects++;
            CLI.renderReflectionAlert(
              consecutivePlanCompletionRejects,
              `Reasoning-only output cannot finish the turn while the execution plan is incomplete. ${planBlocker}`,
            );
            session.addUserMessage(this.planManager.buildContinuationPrompt(planBlocker), 'system');
            await this.persistSession(session);
            CLI.renderStepFooter();
            session.append('step/end', { turn, step, reason: 'plan-continuation-requested' });
            await this.persistSession(session);
            await this.agentHooks.run('agent/after-step', {
              ...hookContext,
              reason: 'plan-continuation-requested',
            });
            this.kernel?.ctx.events.emit('step:after', step);
            continue;
          }

          const fallbackAnswer = `[Tóm tắt kết quả phân tích]:\n${response.reasoningContent}`;
          CLI.renderModelAction('final_answer');
          CLI.renderStepFooter();
          await CLI.renderFinalAnswer(fallbackAnswer);
          this.kernel?.ctx.events.emit('model:final_answer', fallbackAnswer);
          session.addModelMessage({ text: fallbackAnswer, rawContent: response.rawContent });
          await this.persistSession(session);
          session.append('step/end', { turn, step, reason: 'fallback-answer' });
          await this.persistSession(session);
          await this.agentHooks.run('agent/after-step', {
            ...hookContext,
            reason: 'fallback-answer',
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
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');
          return fallbackAnswer;
        }
      }

      // 6. Nếu model trả về câu trả lời cuối cùng (Final Answer)
      const rawText = response.text ? response.text.trim() : '';
      const isGenericStub = !rawText
        || /^(each task must be atomic|execution sequence satisfied|\(nhiệm vụ đã hoàn tất\)|\(task completed\)|\(solution submitted\))/i.test(rawText)
        || (rawText.length < 40 && hasSubmittedSolution && (submittedSolutionSummary?.length || 0) > 40);

      const finalAnswer = (isGenericStub && hasSubmittedSolution && submittedSolutionSummary)
        ? submittedSolutionSummary
        : (rawText || (hasSubmittedSolution && submittedSolutionSummary ? submittedSolutionSummary : '(Nhiệm vụ đã hoàn tất)'));
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

      const policyDecision = isSubagent
        ? { allow: true }
        : this.finalAnswerGuard.evaluate(finalAnswer, {
            userRequest: turnUserRequest,
            availableToolNames: this.toolProvider.getAll().map((tool) => tool.name || '').filter(Boolean),
            hasSubmittedSolution,
          });
      const evidenceDecision = (isSubagent || isMockLLM)
        ? { allow: true, reasons: [] }
        : this.completionEvidenceGate.evaluate(finalAnswer, session, {
            turn,
            codeChangeRequired: this.planManager.getRequirements().required,
            userRequest: turnUserRequest,
            hasSubmittedSolution,
          });
      const activeSkills = session.getActiveSkillDecisions().map((decision) => decision.skillId);
      if (this.planManager.getRequirements().verificationRequired && this.planManager.hasPlan()) {
        activeSkills.push('verification-before-completion');
      }
      const verificationDecision = (hasSubmittedSolution || isSubagent || isMockLLM)
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
          });
      const finalAnswerDecision = (isSubagent || isMockLLM)
        ? (policyDecision.allow ? { allow: true } : policyDecision)
        : (!policyDecision.allow
        ? policyDecision
        : !criticDecision.approved
        ? {
            allow: false,
            reason: 'unverified-evidence' as const,
            continuationPrompt: criticDecision.critiquePrompt,
          }
        : (!hasSubmittedSolution && !evidenceDecision.allow)
        ? {
            allow: false,
            reason: 'unverified-evidence' as const,
            continuationPrompt: evidenceDecision.continuationPrompt,
          }
        : (!hasSubmittedSolution && !verificationDecision.allowed)
        ? {
            allow: false,
            reason: 'unverified-evidence' as const,
            continuationPrompt: `[SYSTEM VERIFICATION GATE]: ${verificationDecision.reason}\nRun an appropriate test/build/lint/typecheck command now, after the latest modification.`,
          }
        : { allow: true });

      if (!finalAnswerDecision.allow) {
        consecutiveIncompleteFinals++;
        const canRetryIncompleteFinal = consecutiveIncompleteFinals <= maxIncompleteFinalRetries;
        this.adaptiveReasoning.escalate(finalAnswerDecision.reason || 'completion-gate-rejection');
        const reasoningGuidance = this.adaptiveReasoning.getGuidancePrompt();

        const actionMandate = [
          `⛔ [CODEX ACTION MANDATE - MANDATORY TOOL CALL REQUIRED]`,
          `Your response was REJECTED by the Completion Gate: ${finalAnswerDecision.reason || 'Missing empirical verification or tool execution'}.`,
          `You MUST NOT return conversational progress text or unfulfilled promises.`,
          `You MUST execute a concrete tool call in this step (e.g. run_command to run test/build, read_file to inspect, replace_text/apply_patch to edit, or submit_solution when all empirical proof is verified).`,
        ].join('\n');

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
          session.addUserMessage(fullContinuationPrompt);
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

        const incompleteFinalMessage = `Agent stopped: the model returned ${consecutiveIncompleteFinals} non-terminal progress updates instead of executing a tool, reporting evidence, or providing a concrete blocker.`;
        await CLI.renderExecutionStopped(incompleteFinalMessage, 'NON_TERMINAL_PROGRESS_LIMIT');
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'incomplete-final-answer-terminal');
        this.goalManager.disarm();
        return incompleteFinalMessage;
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
      await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');

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
    
    return timeoutMessage;
  }

  /** Queue a model-visible input and drain it through serialized turns. */
  async submit(
    session: Session,
    text: string,
    source: AgentInputSource = 'human',
    options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal },
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
    const shouldStartDrain = !this.drainingInbox && !this.drainScheduled;
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

  private async drainInbox(session: Session, options?: { maxSteps?: number; isGoalMode?: boolean; signal?: AbortSignal }): Promise<void> {
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
    if (reason === 'goal-completed' || reason === 'task-completed' || (isGoalMode && reason === 'goal-stopped')) {
      void this.summarizeSessionEpisodic(session).catch(() => {});
    }
    this.setAgentStatus('idle', session, turn);
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
    return new AgentLoop(this.llm, childRegistry, {
      workspace: options.worktreePath ? new Workspace(options.worktreePath) : this._workspace,
      maxSteps: options.maxSteps ?? this.maxSteps,
      toolScope: childScope,
      agentId,
      agentRegistry: this.agentRegistry,
      sessionPersistence: this.sessionPersistence,
      enableSubagents: false,
      enableStepSummarization: false,
    });
  }
}
