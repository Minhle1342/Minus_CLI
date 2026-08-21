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
import { createDelegateAgentTool, createGetAgentResultTool, createResumeAgentTool, createStopAgentTool } from '../tools/subagent-tools.js';

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
  readonly reflectionEngine: ReflectionEngine;
  readonly memoryManager: ProjectMemoryManager;
  readonly kernel?: AgentKernel;
  private sessionPersistence?: SessionPersistence;
  private _isGoalMode: boolean = false;
  private drainingInbox = false;
  private drainingSessionId?: string;
  private drainScheduled = false;
  private runQueues = new Map<string, Promise<string>>();
  private activeSession?: Session;

  constructor(
    kernelOrLLM: AgentKernel | any,
    toolRegistry?: ToolRegistry,
    options?: AgentLoopOptions
  ) {
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
      this.maxSteps = options?.maxSteps ?? 30;
      this.sessionPersistence = options?.sessionPersistence;
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
      this.sessionPersistence = options?.sessionPersistence;

      // Đăng ký các planning và memory tools vào toolRegistry
      this.toolRegistry.attachPlanManager(this.planManager);
      this.toolRegistry.attachMemoryManager(this.memoryManager);

      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(this._workspace).catch(() => {});
    }

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
    ).catch((error) => {
      this.setAgentStatus('error', session);
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
    this.planManager.bindSession(session);
    this.goalManager.bindSession(session);
    this.memoryManager.bindSession(session);
    this.subagentManager.bindSession(session);
    this.effectLedger.bindSession(session);
    this.reflectionEngine.reset();
    this.progressGuard.reset();
    let consecutiveEmptyTurns = 0;
    const maxEmptyRetries = 2;

    const isGoal = options?.isGoalMode ?? this._isGoalMode;
    const effectiveMaxSteps = options?.maxSteps ?? (isGoal ? Infinity : this.maxSteps);
    const turn = session.getEvents().filter((event) => event.type === 'turn/start').length + 1;
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
      await this.endTurn(session, turn, effectiveMaxSteps, isGoal, turnStartDecision.reason || 'turn-rejected');
      return `Agent turn rejected: ${turnStartDecision.reason || 'turn hook rejected execution.'}`;
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
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'cancelled');
        this.goalManager.disarm();
        return 'Agent stopped: cancellation requested.';
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
        session.append('step/end', { turn, step, reason: preStepDecision.reason || 'pre-step-rejected' });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: preStepDecision.reason || 'pre-step-rejected',
        });
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, preStepDecision.reason || 'pre-step-rejected');
        return `Agent step rejected: ${preStepDecision.reason || 'pre-step hook rejected execution.'}`;
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
        session.append('step/end', { turn, step, reason: requestDecision.reason || 'request-rejected' });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: requestDecision.reason || 'request-rejected',
        });
        await this.endTurn(session, turn, effectiveMaxSteps, isGoal, requestDecision.reason || 'request-rejected');
        return `Agent request rejected: ${requestDecision.reason || 'request hook rejected execution.'}`;
      }

      // 3. Gửi session hiện tại cho LLM (ưu tiên Real-time Streaming)
      let response;
      const requestOptions = { systemPrompt: this.promptAssembler.assemble() };
      if (typeof this.llm.generateStream === 'function') {
        response = await this.llm.generateStream(session, toolDeclarations, {
          onThoughtToken: (token: string) => {
            this.kernel?.ctx.events.emit('model:thought', token);
          },
          onContentToken: (token: string) => {
            this.kernel?.ctx.events.emit('model:token', token);
          },
        }, requestOptions);
      } else {
        response = await this.llm.generate(session, toolDeclarations, requestOptions);
      }

      // System 2: Hiển thị mạch suy luận nội tâm sâu (Deep Reasoning / CoT) nếu có
      if (response.reasoningContent) {
        CLI.renderReasoning(response.reasoningContent);
        this.kernel?.ctx.events.emit('model:thought', response.reasoningContent);
      }

      const hasToolCalls = Boolean(response.toolCalls && response.toolCalls.length > 0);
      const hasValidText = Boolean(response.text && response.text.trim().length > 0);
      const hasReasoning = Boolean(response.reasoningContent && response.reasoningContent.trim().length > 0);

      // 4. Nếu model muốn gọi tool (System 1: Action)
      if (hasToolCalls) {
        consecutiveEmptyTurns = 0;
        CLI.renderModelAction('tool_call', `Requesting ${response.toolCalls.length} tool call(s)`);

        const toolCallIds = response.toolCalls.map((call: any, callIndex: number) => (call as any).id || `call-${turn}-${step}-${callIndex}`);
        const toolCallsWithIds = response.toolCalls.map((call: any, callIndex: number) => ({
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

        let terminalStall: { toolName: string; repetitionCount: number } | undefined;

        // Thực thi từng Tool Call thông qua ToolRunner (5-stage pipeline)
        for (const [callIndex, call] of response.toolCalls.entries()) {
          const toolName = call.name || '';
          const toolArgs = (call.args as Record<string, any>) || {};

          if (!toolName) {
            continue;
          }

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

          const isSideEffectTool = ['write_file', 'replace_text', 'run_command'].includes(toolName);
          const effect = isSideEffectTool
            ? this.effectLedger.prepare(toolName, toolCallId, true)
            : undefined;
          if (effect) await this.persistSession(session);

          // Tạo Shadow Git Checkpoint trước các thao tác sửa đổi file hoặc chạy lệnh
          if (effect) {
            const checkpoint = await this.checkpointManager.createCheckpoint(`Tool ${toolName}: ${JSON.stringify(toolArgs)}`);
            this.effectLedger.attachCheckpoint(effect.id, checkpoint?.id);
            await this.persistSession(session);
          }

          this.kernel?.ctx.events.emit('tool:before', toolName, toolArgs);
          CLI.renderToolCall(toolName, toolArgs);

          // Chạy tool qua pipeline an toàn
          const executionResult = await this.toolRunner.run(toolName, toolArgs);

          CLI.renderToolResult(toolName, executionResult.durationMs, executionResult.result);
          this.kernel?.ctx.events.emit('tool:after', toolName, executionResult.result, executionResult.durationMs);

          // Phân tích kết quả qua ReflectionEngine (Tự vấn & Debugging Protocol)
          const reflectionAnalysis = this.reflectionEngine.analyze({
            toolName,
            args: toolArgs,
            result: executionResult.result,
            durationMs: executionResult.durationMs,
          });

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
            terminalStall = { toolName, repetitionCount: progressDecision.repetitionCount };
            break;
          }
        }

        const stepReason = terminalStall ? 'repeated-no-progress' : 'tool-results-recorded';
        session.append('step/end', { turn, step, reason: stepReason });
        await this.persistSession(session);
        await this.agentHooks.run('agent/after-step', {
          ...hookContext,
          reason: stepReason,
        });

        CLI.renderStepFooter();
        this.kernel?.ctx.events.emit('step:after', step);

        if (terminalStall) {
          const stallMessage = `Agent stopped: repeated no-progress tool call "${terminalStall.toolName}" ${terminalStall.repetitionCount} times with identical arguments and result.`;
          await this.endTurn(session, turn, effectiveMaxSteps, isGoal, 'repeated-no-progress');
          this.goalManager.disarm();
          return stallMessage;
        }

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 5. Continuation Protocol: Tự động khôi phục khi gặp Turn rỗng (Chống dừng sớm)
      if (!hasValidText) {
        consecutiveEmptyTurns++;

        if (consecutiveEmptyTurns <= maxEmptyRetries) {
          if (hasReasoning) {
            CLI.renderReflectionAlert(
              consecutiveEmptyTurns,
              'Model sinh suy luận System 2 nhưng chưa phát sinh tool_calls. Đang tự động kích hoạt Continuation Protocol...'
            );
            session.addUserMessage(
              '[SYSTEM NOTE]: You completed your internal reasoning monologue but did not provide any tool calls or final user-facing response. Please proceed immediately to execute the next tool call according to your plan or provide the final answer to the user.'
            );
            await this.persistSession(session);
          } else {
            CLI.renderReflectionAlert(
              consecutiveEmptyTurns,
              'Model trả về phản hồi rỗng. Đang tự động kích hoạt Continuation Protocol để tiếp tục tác vụ...'
            );
            session.addUserMessage(
              '[SYSTEM NOTE]: Your last turn produced an empty response with no tool calls and no text. Please continue solving the user request by calling the appropriate tool (e.g. read_file, search_text, replace_text, run_command, create_plan) or concluding the task with a final answer.'
            );
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
          const fallbackAnswer = `[Tóm tắt kết quả phân tích]:\n${response.reasoningContent}`;
          CLI.renderModelAction('final_answer');
          CLI.renderStepFooter();
          CLI.renderFinalAnswer(fallbackAnswer);
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

      // 6. Nếu model trả về câu trả lời cuối cùng hợp lệ (Final Answer)
      const finalAnswer = response.text || '(Nhiệm vụ đã hoàn tất)';
      consecutiveEmptyTurns = 0;
      
      CLI.renderModelAction('final_answer');
      CLI.renderStepFooter();
      CLI.renderFinalAnswer(finalAnswer);
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
    CLI.renderFinalAnswer(timeoutMessage);
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
