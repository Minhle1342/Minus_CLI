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

/**
 * AgentLoop - Trái tim điều phối vòng đời của Coding Agent (Phase 4 - Hierarchical Memory Ready)
 * 
 * Vòng lặp vận hành theo quy trình khép kín:
 * 1. Warm-Start: Nạp Project Knowledge Digest từ bộ nhớ dài hạn (.codingagent/).
 * 2. Tối ưu hoá Token và nén ngữ cảnh (Context Compaction).
 * 3. Gửi Session messages + Tools cho LLM.
 * 4. Nếu LLM yêu cầu gọi Tool:
 *    - Tự động tạo Shadow Git Checkpoint trước các thao tác sửa đổi file.
 *    - Chuyển tiếp qua ToolRunner (chạy 5-stage pipeline: validation, safety, timeout).
 *    - Phân tích kết quả qua ReflectionEngine (nếu lỗi -> kích hoạt Debugging Protocol).
 *    - Ghi nhận Tool Result (kèm Reflection Prompt nếu lỗi) vào Session.
 * 5. Nếu LLM cập nhật Kế hoạch -> Hiển thị Plan Tree trực quan.
 * 6. Nếu LLM trả về Final Answer -> Kết thúc nhiệm vụ và xuất báo cáo.
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

  constructor(llm: any, toolRegistry: ToolRegistry, options?: AgentLoopOptions) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this._workspace = options?.workspace ?? new Workspace();
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

  get workspace(): Workspace {
    return this._workspace;
  }

  setWorkspace(workspace: Workspace) {
    this._workspace = workspace;
    this.toolRunner = new ToolRunner(this.toolRegistry, this._workspace);
    (this as any).checkpointManager = new CheckpointManager(workspace.rootDir);
    (this as any).memoryManager = new ProjectMemoryManager(workspace.rootDir);
    this.checkpointManager.init().catch(() => {});
    this.memoryManager.init(workspace).catch(() => {});
  }

  setLLM(llm: any) {
    this.llm = llm;
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
      // Bổ sung digest ngắn vào prompt của user để LLM hiểu ngay ngữ cảnh dự án
      const userText = history[0].parts?.[0]?.text || '';
      if (!userText.includes('[PROJECT KNOWLEDGE BASE')) {
        history[0].parts = [{ text: `${digest}\n\n[USER INSTRUCTION]:\n${userText}` }];
      }
    }

    for (let step = 1; step <= this.maxSteps; step++) {
      CLI.renderStepHeader(step, this.maxSteps);

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

          CLI.renderToolCall(toolName, toolArgs);

          // Chạy tool qua pipeline an toàn
          const executionResult = await this.toolRunner.run(toolName, toolArgs);

          CLI.renderToolResult(toolName, executionResult.durationMs, executionResult.result);

          // Phân tích kết quả qua ReflectionEngine (Tự vấn & Debugging Protocol)
          const reflectionAnalysis = this.reflectionEngine.analyze({
            toolName,
            args: toolArgs,
            result: executionResult.result,
            durationMs: executionResult.durationMs,
          });

          if (reflectionAnalysis.isFailure) {
            CLI.renderReflectionAlert(reflectionAnalysis.consecutiveFailures, reflectionAnalysis.advice);
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

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 5. Nếu model trả về câu trả lời cuối cùng (Final Answer)
      const finalAnswer = response.text || '(Không có phản hồi từ model)';
      
      CLI.renderModelAction('final_answer');
      CLI.renderStepFooter();
      CLI.renderFinalAnswer(finalAnswer);

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
