import { ToolRegistry } from '../tools/registry.js';
import { ToolProvider } from '../tools/registry.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';
import { AgentLoopOptions } from './types.js';
import { CLI } from '../ui/cli-ui.js';
import { CheckpointManager } from '../workspace/checkpoint.js';
import { ContextCompactor } from './context-compactor.js';
import { PlanManager } from './plan-manager.js';
import { ReflectionEngine } from './reflection-engine.js';
import { ProjectMemoryManager } from '../memory/project-memory.js';
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
import { createDelegateAgentTool, createGetAgentResultTool, createResumeAgentTool, createStopAgentTool } from '../tools/subagent-tools.js';
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
  readonly kernel?: AgentKernel;
  private sessionPersistence?: SessionPersistence;
  private _isGoalMode: boolean = false;
  private drainingInbox = false;
  private drainingSessionId?: string;
  private drainScheduled = false;
  private runQueues = new Map<string, Promise<string>>();
  private activeSession?: Session;
  private loopOptions?: AgentLoopOptions;

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
        ? new ToolRunner(this.toolProvider, this._workspace)
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
      this.effectLedger = new EffectLedger();
      this.criticGate = new CriticGate(this.completionEvidenceGate);
      this.speculativeManager = new SpeculativeBranchManager(this._workspace.rootDir);
      this.workspaceVerifier = new WorkspaceStateVerifier(this._workspace);
      this.rollbackOrchestrator = new HypothesisRollbackOrchestrator(this.checkpointManager, this.speculativeManager);
      this.maxSteps = options?.maxSteps ?? 30;
      this.sessionPersistence = options?.sessionPersistence;
      registerSubmitSolutionTool(this.toolRegistry, this._workspace);
      this.kernel.init().catch(() => {});
    } else {
      this.llm = kernelOrLLM;
      this._workspace = options?.workspace ?? new Workspace();
      this.toolRegistry = toolRegistry ?? new ToolRegistry();
      this.toolProvider = options?.toolScope || this.toolRegistry;
      this.toolRunner = new ToolRunner(this.toolProvider, this._workspace);
      this.maxSteps = options?.maxSteps ?? 30;
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
      this.effectLedger = new EffectLedger();
      this.criticGate = new CriticGate(this.completionEvidenceGate);
      this.speculativeManager = new SpeculativeBranchManager(this._workspace.rootDir);
      this.workspaceVerifier = new WorkspaceStateVerifier(this._workspace);
      this.rollbackOrchestrator = new HypothesisRollbackOrchestrator(this.checkpointManager, this.speculativeManager);
      this.sessionPersistence = options?.sessionPersistence;

      // Đăng ký các planning và memory tools vào toolRegistry
      this.toolRegistry.attachPlanManager(this.planManager);
      this.toolRegistry.attachMemoryManager(this.memoryManager);
      registerSubmitSolutionTool(this.toolRegistry, this._workspace);

      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(this._workspace).catch(() => {});
    }

    // Bảo tồn KV-Cache Prefix của OpenAI Codex trong suốt vòng lặp
    this.contextCompactor.setConfig({ preservePrefixCache: true });

    this.agentRegistry.register(this.agentId, this.agentId);
    this.subagentManager = new SubagentManager(
      this.agentRegistry,
      (agentId, session, subagentOptions, signal) => this.createSubagentLoop(agentId, session, subagentOptions, signal),
      (session) => this.persistSession(session),
    );
    if (options?.enableSubagents !== false) {
      this.toolRegistry.register(createDelegateAgentTool(this.subagentManager));
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
    if (this.kernel) {
      this.kernel.ctx.setWorkspace(workspace);
      if (this.toolProvider === this.toolRegistry) {
        this.toolRunner = this.kernel.ctx.toolRunner;
      } else {
        this.toolRunner = new ToolRunner(this.toolProvider, workspace);
      }
    } else {
      this.toolRunner = new ToolRunner(this.toolProvider, this._workspace);
      (this as any).checkpointManager = new CheckpointManager(workspace.rootDir);
      (this as any).memoryManager = new ProjectMemoryManager(workspace.rootDir);
      this.toolRegistry.attachMemoryManager(this.memoryManager);
      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(workspace).catch(() => {});
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
      // Preserve an auditable, balanced lifecycle even when a provider, hook,
      // persistence adapter, or tool pipeline throws unexpectedly. This also
      // pairs any assistant-declared tool calls whose outcome is not known.
      try {
        if (session.recoverInterrupted()) {
          await this.persistSession(session);
        }
      } catch {
        // Keep the original failure as the rejection reason. Any successfully
        // appended in-memory recovery events remain available for inspection.
      }
      this.setAgentStatus('error', session);
      this.goalManager.disarm();
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await CLI.renderExecutionStopped(
          `Agent stopped because an unexpected execution error occurred: ${detail}`,
          'EXECUTION_ERROR',
        );
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
    const toolDeclarations = this.toolProvider.getFunctionDeclarations();
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
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    this.reflectionEngine.reset();
    this.progressGuard.reset();
    this.finalAnswerGuard.reset();
    this.verificationPolicy.reset();
    const isGoal = options?.isGoalMode ?? this._isGoalMode;
    const effectiveMaxSteps = options?.maxSteps ?? (isGoal ? Infinity : this.maxSteps);
    const turn = session.getEvents().filter((event) => event.type === 'turn/start').length + 1;
    this.planManager.beginTurn(turn, turnUserRequest);
    let consecutiveEmptyTurns = 0;
    let consecutiveIncompleteFinals = 0;
    let consecutivePlanCompletionRejects = 0;
    let consecutiveIncompleteFinishes = 0;
    let consecutiveNoProgressStrategyChanges = 0;
    let hasSubmittedSolution = false;
    let submittedSolutionSummary: string | undefined;
    const maxEmptyRetries = 2;
    const maxIncompleteFinishRetries = 3;
    const maxIncompleteFinalRetries = 3;
    const maxPlanCompletionRetries = 3;
    const maxNoProgressStrategyChanges = 3;

    this.setAgentStatus('running', session, turn);

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
      CLI.renderStepHeader(step, effectiveMaxSteps);
      this.kernel?.ctx.events.emit('step:before', step, effectiveMaxSteps);

      // 2. Tối ưu hoá ngữ cảnh và nén Token (Context Compaction)
      const compactionResult = this.contextCompactor.compact(session.getHistory());
      if (compactionResult.stats.charsSaved > 0) {
        session.setHistory(compactionResult.messages);
        await this.persistSession(session);
      }

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

      const activeToolDeclarations = (this.loopOptions?.enableDynamicToolRetrieval && typeof (this.toolProvider as any).getRelevantTools === 'function')
        ? (this.toolProvider as any).getRelevantTools(activeStepQuery)
        : toolDeclarations;

      let response;
      // System Prompt 100% STATIC để tối đa hóa KV-Cache Hit Rate (>80%) theo chuẩn OpenAI Codex
      const assembledSystemPrompt = this.promptAssembler.assemble();
      const dynamicExecutionContext = this.planManager.renderExecutionContext();

      session.recordRequestHeader({
        turn,
        step,
        systemPrompt: assembledSystemPrompt,
        tools: activeToolDeclarations,
        history: session.getHistory(),
      });
      session.assertRuntimeInvariants({ allowOpenLifecycle: true });
      await this.persistSession(session);
      const requestOptions: LLMRequestOptions = {
        systemPrompt: assembledSystemPrompt,
        dynamicContext: dynamicExecutionContext,
        sessionId: session.id,
        promptCacheKey: session.id,
        enablePromptCaching: this.loopOptions?.enablePromptCaching !== false,
      };
      CLI.renderLLMThinking();
      if (typeof this.llm.generateStream === 'function') {
        response = await this.llm.generateStream(session, activeToolDeclarations, {
          onThoughtToken: (token: string) => {
            this.kernel?.ctx.events.emit('model:thought', token);
          },
          onContentToken: (token: string) => {
            this.kernel?.ctx.events.emit('model:token', token);
          },
        }, requestOptions);
      } else {
        response = await this.llm.generate(session, activeToolDeclarations, requestOptions);
      }

      // Giám sát và hiển thị Prompt Cache Hit Rate / Token Telemetry
      if (response.usage) {
        this.kernel?.ctx.events.emit('model:usage', response.usage);
        CLI.renderCacheUsage(response.usage);
      }

      // System 2: Hiển thị mạch suy luận nội tâm sâu (Deep Reasoning / CoT) nếu có
      if (response.reasoningContent) {
        CLI.renderReasoning(response.reasoningContent);
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

        let strategyChangeRequired: { toolName: string; repetitionCount: number } | undefined;
        let toolBatchCancelled = false;

        // Thực thi từng Tool Call thông qua ToolRunner (5-stage pipeline)
        for (const [callIndex, call] of normalizedToolCalls.entries()) {
          if (options?.signal?.aborted) {
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
          session.append('tool/call', {
            turn,
            step,
            toolName,
            toolCallId,
            assistantSeq,
            args: toolArgs,
            thoughtSignature: responseFunctionCallParts[callIndex]?.thoughtSignature,
          });
          await this.persistSession(session);

          if (toolName === '__invalid_tool_call__') {
            const invalidResult = {
              error: 'The model emitted a tool call without a valid tool name.',
              errorCode: 'INVALID_TOOL_CALL',
              retryable: true,
            };
            session.addToolResultWithId(toolName, invalidResult, toolCallId, 'invalid-tool-call');
            await this.persistSession(session);
            this.kernel?.ctx.events.emit('tool:error', toolName, invalidResult);
            continue;
          }

          const sideEffectConfig: Record<string, { reversible: boolean; checkpoint: boolean }> = {
            write_file: { reversible: true, checkpoint: true },
            replace_text: { reversible: true, checkpoint: true },
            run_command: { reversible: true, checkpoint: true },
            git_add: { reversible: true, checkpoint: true },
            git_commit: { reversible: true, checkpoint: true },
            git_push: { reversible: false, checkpoint: false },
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
                ? { reversible: false, checkpoint: false }
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

          this.kernel?.ctx.events.emit('tool:before', toolName, toolArgs);
          CLI.renderToolCall(toolName, toolArgs);

          // Post-Submission Terminal Gate (OpenAI Codex CLI Standard):
          // Chặn các lệnh kiểm thử / submit dư thừa nếu nhiệm vụ đã được submit_solution hoàn tất và không có thay đổi file mới
          let executionResult: { durationMs: number; result: Record<string, any> };
          if (hasSubmittedSolution && (toolName === 'submit_solution' || (toolName === 'run_command' && isVerificationCommand(toolArgs.command)))) {
            const redundantPayload = {
              success: true,
              submitted: true,
              summary: submittedSolutionSummary || 'Task completed and submitted.',
              nextAction: 'final_answer',
              message: 'Solution has already been submitted and verified. No files have changed since submission. Do not execute further verification tools; conclude your turn with your final response to the user immediately.',
            };
            executionResult = { durationMs: 0, result: redundantPayload };
          } else {
            // Chạy tool qua pipeline an toàn
            executionResult = await this.toolRunner.run(toolName, toolArgs, {
              sessionId: session.id,
              agentId: this.agentId,
              turn,
              userRequest: turnUserRequest,
            });
          }

          CLI.renderToolResult(toolName, executionResult.durationMs, executionResult.result);
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
          this.planManager.recordToolEvidence(toolName, toolArgs, executionResult.result);
          if (!isToolResultFailure(executionResult.result) && ['write_file', 'replace_text', 'apply_patch', 'create_file', 'delete_file', 'move_file'].includes(toolName)) {
            this.verificationPolicy.recordModification(String(toolArgs.path || ''));
            hasSubmittedSolution = false;
          }
          if (toolName === 'run_command') {
            this.verificationPolicy.recordVerification(
              String(toolArgs.command || ''),
              !isToolResultFailure(executionResult.result),
              String(executionResult.result.stdout || executionResult.result.stderr || '').slice(0, 240),
              executionResult.result.exitCode,
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
            this.kernel?.ctx.events.emit('tool:error', toolName, executionResult.result);
          }

          const progressDecision = this.progressGuard.observe({
            toolName,
            args: toolArgs,
            result: executionResult.result,
          });

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
            ...(progressDecision.message
              ? { _system_loop_guard: progressDecision.message }
              : {}),
          };

          session.addToolResultWithId(toolName, payloadToRecord, toolCallId);
          await this.persistSession(session);
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

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 5. Continuation Protocol: Tự động khôi phục khi gặp Turn rỗng (Chống dừng sớm)
      if (!hasValidText) {
        // Post-Submission Graceful Auto-Finalization (Codex CLI Standard):
        // Nếu đã submit_solution thành công và có summary đầy đủ mà model sinh turn rỗng/chỉ reasoning, chốt Final Answer ngay lập tức
        if (hasSubmittedSolution && submittedSolutionSummary) {
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
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');
          this.goalManager.disarm();
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
              ? '[SYSTEM NOTE]: The solution has already been verified and submitted via submit_solution. Do NOT call any further tools or build commands. Output your final response and summary to the user now.'
              : '[SYSTEM NOTE]: You completed your internal reasoning monologue but did not provide any tool calls or final user-facing response. Please proceed immediately to execute the next tool call according to your plan or provide the final answer to the user.';
            session.addUserMessage(noteText);
            await this.persistSession(session);
          } else {
            CLI.renderReflectionAlert(
              consecutiveEmptyTurns,
              'Model trả về phản hồi rỗng. Đang tự động kích hoạt Continuation Protocol để tiếp tục tác vụ...'
            );
            const noteText = hasSubmittedSolution
              ? '[SYSTEM NOTE]: The solution has already been verified and submitted via submit_solution. Do NOT call any further tools or build commands. Output your final response and summary to the user now.'
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
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');
          this.goalManager.disarm();
          return fallbackAnswer;
        }
      }

      // 6. Nếu model trả về câu trả lời cuối cùng (Final Answer)
      const finalAnswer = response.text || '(Nhiệm vụ đã hoàn tất)';
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

      const policyDecision = this.finalAnswerGuard.evaluate(finalAnswer, {
        userRequest: turnUserRequest,
        availableToolNames: toolDeclarations.map((tool) => tool.name || '').filter(Boolean),
      });
      const evidenceDecision = this.completionEvidenceGate.evaluate(finalAnswer, session, {
        turn,
        codeChangeRequired: this.planManager.getRequirements().required,
        userRequest: turnUserRequest,
      });
      const activeSkills = session.getActiveSkillDecisions().map((decision) => decision.skillId);
      if (this.planManager.getRequirements().verificationRequired && this.planManager.hasPlan()) {
        activeSkills.push('verification-before-completion');
      }
      const verificationDecision = this.verificationPolicy.canComplete(activeSkills);
      const criticDecision = this.criticGate.evaluate({
        finalAnswer,
        session,
        workspace: this._workspace,
        hypothesisTracker: this.hypothesisTracker,
        userRequest: turnUserRequest,
      });
      const finalAnswerDecision = !policyDecision.allow
        ? policyDecision
        : !evidenceDecision.allow
        ? {
            allow: false,
            reason: 'unverified-evidence' as const,
            continuationPrompt: evidenceDecision.continuationPrompt,
          }
        : !criticDecision.approved
        ? {
            allow: false,
            reason: 'unverified-evidence' as const,
            continuationPrompt: criticDecision.critiquePrompt,
          }
        : !verificationDecision.allowed
          ? {
              allow: false,
              reason: 'unverified-evidence' as const,
              continuationPrompt: `[SYSTEM VERIFICATION GATE]: ${verificationDecision.reason}\nRun an appropriate test/build/lint/typecheck command now, after the latest modification.`,
            }
          : { allow: true };

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
      await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'completed');
      this.goalManager.disarm();

      return finalAnswer;
    }

    // 7. Nếu đạt maxSteps mà chưa hoàn thành
    const timeoutMessage = isGoal
      ? `Agent stopped: Goal execution finished.`
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
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    for (const input of session.getPendingInputs()) {
      this.inbox.restore(session.id, input);
    }
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
    const forbidden = new Set(['delegate_agent', 'get_agent_result', 'stop_agent']);
    for (const tool of this.toolRegistry.getAll()) {
      if (!forbidden.has(tool.name)) childRegistry.register(tool);
    }

    const availableNames = childRegistry.getAll().map((tool) => tool.name);
    const allowedNames = (options.toolNames || availableNames).filter((name) => !forbidden.has(name));
    const childScope = childRegistry.createScope(`subagent-scope:${agentId}`, allowedNames);
    return new AgentLoop(this.llm, childRegistry, {
      workspace: this._workspace,
      maxSteps: options.maxSteps ?? this.maxSteps,
      toolScope: childScope,
      agentId,
      agentRegistry: this.agentRegistry,
      sessionPersistence: new SessionPersistence(this._workspace.rootDir),
      enableSubagents: false,
    });
  }
}
