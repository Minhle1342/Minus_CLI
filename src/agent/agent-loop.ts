import { ToolRegistry } from '../tools/registry.js';
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

/**
 * AgentLoop - Trái tim điều phối vòng đời của Coding Agent (Phase 5 - Micro-Kernel Ready)
 * 
 * Vòng lặp vận hành theo kiến trúc Plugin & Micro-Kernel:
 * 1. Warm-Start: Nạp Project Knowledge Digest từ bộ nhớ dài hạn.
 * 2. Tối ưu hoá Token và nén ngữ cảnh (Context Compactor).
 * 3. Gửi Session messages + Tools cho LLM.
 * 4. System 2: Bóc tách và hiển thị Deep Reasoning / CoT Internal Monologue.
 * 5. System 1: Điều phối gọi Tool qua 5-stage pipeline an toàn.
 * 6. Reflection Engine: Kích hoạt Debugging Protocol khi gặp lỗi.
 */
export class AgentLoop {
  private llm: any;
  private toolRegistry: ToolRegistry;
  private toolRunner: ToolRunner;
  private _workspace: Workspace;
  readonly maxSteps: number;
  readonly checkpointManager: CheckpointManager;
  readonly contextCompactor: ContextCompactor;
  readonly planManager: PlanManager;
  readonly reflectionEngine: ReflectionEngine;
  readonly memoryManager: ProjectMemoryManager;
  readonly kernel?: AgentKernel;

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
      this.toolRunner = this.kernel.ctx.toolRunner;
      this.checkpointManager = this.kernel.ctx.checkpoints;
      this.contextCompactor = this.kernel.ctx.compactor;
      this.planManager = this.kernel.ctx.plan;
      this.reflectionEngine = this.kernel.ctx.reflection;
      this.memoryManager = this.kernel.ctx.memory;
      this.maxSteps = options?.maxSteps ?? 30;
      this.kernel.init().catch(() => {});
    } else {
      this.llm = kernelOrLLM;
      this._workspace = options?.workspace ?? new Workspace();
      this.toolRegistry = toolRegistry ?? new ToolRegistry();
      this.toolRunner = new ToolRunner(this.toolRegistry, this._workspace);
      this.maxSteps = options?.maxSteps ?? 30;
      this.checkpointManager = options?.checkpointManager ?? new CheckpointManager(this._workspace.rootDir);
      this.contextCompactor = options?.contextCompactor ?? new ContextCompactor();
      this.planManager = new PlanManager();
      this.reflectionEngine = new ReflectionEngine();
      this.memoryManager = new ProjectMemoryManager(this._workspace.rootDir);

      // Đăng ký các planning và memory tools vào toolRegistry
      this.toolRegistry.attachPlanManager(this.planManager);
      this.toolRegistry.attachMemoryManager(this.memoryManager);

      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(this._workspace).catch(() => {});
    }
  }

  get workspace(): Workspace {
    return this._workspace;
  }

  setWorkspace(workspace: Workspace) {
    this._workspace = workspace;
    if (this.kernel) {
      this.kernel.ctx.setWorkspace(workspace);
    } else {
      this.toolRunner = new ToolRunner(this.toolRegistry, this._workspace);
      (this as any).checkpointManager = new CheckpointManager(workspace.rootDir);
      (this as any).memoryManager = new ProjectMemoryManager(workspace.rootDir);
      this.checkpointManager.init().catch(() => {});
      this.memoryManager.init(workspace).catch(() => {});
    }
  }

  setLLM(llm: any) {
    this.llm = llm;
    if (this.kernel) {
      this.kernel.ctx.setLLM(llm);
    }
  }

  /**
   * Hoàn tác hành động sửa đổi gần nhất (/undo)
   */
  async rollback(): Promise<{ success: boolean; message: string }> {
    return this.checkpointManager.rollbackLast();
  }

  async run(session: Session): Promise<string> {
    const toolDeclarations = this.toolRegistry.getFunctionDeclarations();
    this.planManager.clear();
    this.reflectionEngine.reset();

    // 1. Warm-Start: Nạp tóm tắt trí nhớ Repo vào đầu Session nếu là phiên mới
    const history = session.getHistory();
    if (history.length === 1 && history[0].role === 'user') {
      const digest = this.memoryManager.getProjectDigest();
      const userText = history[0].parts?.[0]?.text || '';
      if (!userText.includes('[PROJECT KNOWLEDGE BASE')) {
        history[0].parts = [{ text: `${digest}\n\n[USER INSTRUCTION]:\n${userText}` }];
      }
    }

    for (let step = 1; step <= this.maxSteps; step++) {
      CLI.renderStepHeader(step, this.maxSteps);
      this.kernel?.ctx.events.emit('step:before', step, this.maxSteps);

      // 2. Tối ưu hoá ngữ cảnh và nén Token (Context Compaction)
      const compactionResult = this.contextCompactor.compact(session.getHistory());
      if (compactionResult.stats.charsSaved > 0) {
        session.setHistory(compactionResult.messages);
      }

      // 3. Gửi session hiện tại cho LLM
      const response = await this.llm.generate(session, toolDeclarations);

      // System 2: Hiển thị mạch suy luận nội tâm sâu (Deep Reasoning / CoT) nếu có
      if (response.reasoningContent) {
        CLI.renderReasoning(response.reasoningContent);
        this.kernel?.ctx.events.emit('model:thought', response.reasoningContent);
      }

      // 4. Nếu model muốn gọi tool (System 1: Action)
      if (response.toolCalls && response.toolCalls.length > 0) {
        CLI.renderModelAction('tool_call', `Requesting ${response.toolCalls.length} tool call(s)`);

        // Ghi lại phản hồi gọi tool của model vào Session
        session.addModelMessage({
          text: response.text,
          functionCalls: response.toolCalls,
          rawContent: response.rawContent,
        });

        // Thực thi từng Tool Call thông qua ToolRunner (5-stage pipeline)
        for (const call of response.toolCalls) {
          const toolName = call.name || '';
          const toolArgs = (call.args as Record<string, any>) || {};

          if (!toolName) {
            continue;
          }

          // Tạo Shadow Git Checkpoint trước các thao tác sửa đổi file hoặc chạy lệnh
          if (['write_file', 'replace_text', 'run_command'].includes(toolName)) {
            await this.checkpointManager.createCheckpoint(`Tool ${toolName}: ${JSON.stringify(toolArgs)}`);
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

          // Hiển thị Cây kế hoạch nếu có cập nhật từ planning tools
          if (['create_plan', 'update_plan_task'].includes(toolName) && this.planManager.hasPlan()) {
            CLI.renderPlan(this.planManager.getTasks());
          }

          // Ghi Tool Result vào Session (kèm Reflection Prompt hướng dẫn nếu có lỗi)
          const payloadToRecord = reflectionAnalysis.reflectionPrompt
            ? {
                ...executionResult.result,
                _system_reflection_prompt: reflectionAnalysis.reflectionPrompt,
              }
            : executionResult.result;

          session.addToolResult(toolName, payloadToRecord);
        }

        CLI.renderStepFooter();
        this.kernel?.ctx.events.emit('step:after', step);

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 5. Nếu model trả về câu trả lời cuối cùng (Final Answer)
      const finalAnswer = response.text || '(Không có phản hồi từ model)';
      
      CLI.renderModelAction('final_answer');
      CLI.renderStepFooter();
      CLI.renderFinalAnswer(finalAnswer);
      this.kernel?.ctx.events.emit('model:final_answer', finalAnswer);

      // Ghi nhận câu trả lời cuối cùng vào Session
      session.addModelMessage({ text: finalAnswer, rawContent: response.rawContent });

      return finalAnswer;
    }

    // 6. Nếu đạt maxSteps mà chưa hoàn thành
    const timeoutMessage = `Agent stopped: maximum steps (${this.maxSteps}) reached without final answer.`;
    CLI.renderModelAction('max_steps');
    CLI.renderStepFooter();
    CLI.renderFinalAnswer(timeoutMessage);
    
    return timeoutMessage;
  }
}
