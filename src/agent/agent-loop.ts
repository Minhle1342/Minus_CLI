import { ToolRegistry } from '../tools/registry.js';
import { ToolRunner } from '../tools/tool-runner.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';
import { AgentLoopOptions } from './types.js';
import { CLI } from '../ui/cli-ui.js';

/**
 * AgentLoop - Trái tim điều phối vòng đời của Coding Agent
 * 
 * Vòng lặp vận hành theo quy trình khép kín:
 * 1. Gửi Session messages + Tools cho LLM (Kèm System Prompt định hướng)
 * 2. Nếu LLM yêu cầu gọi Tool:
 *    - Ghi nhận Tool Call vào Session
 *    - Chuyển tiếp qua ToolRunner (chạy 5-stage pipeline: validation, safety, timeout)
 *    - Ghi nhận Tool Result vào Session
 *    - Tiếp tục bước lặp tiếp theo để LLM quan sát kết quả
 * 3. Nếu LLM trả về Final Answer:
 *    - Ghi nhận câu trả lời vào Session
 *    - Trả về kết quả và kết thúc vòng lặp
 * 4. Nếu đạt ngưỡng maxSteps:
 *    - Kích hoạt phanh an toàn và dừng lại
 */
export class AgentLoop {
  private llm: any;
  private toolRegistry: ToolRegistry;
  private toolRunner: ToolRunner;
  private _workspace: Workspace;
  readonly maxSteps: number;

  constructor(llm: any, toolRegistry: ToolRegistry, options?: AgentLoopOptions) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this._workspace = options?.workspace ?? new Workspace();
    this.toolRunner = new ToolRunner(this.toolRegistry, this._workspace);
    this.maxSteps = options?.maxSteps ?? 30;
  }

  get workspace(): Workspace {
    return this._workspace;
  }

  setWorkspace(workspace: Workspace) {
    this._workspace = workspace;
    this.toolRunner = new ToolRunner(this.toolRegistry, this._workspace);
  }

  setLLM(llm: any) {
    this.llm = llm;
  }

  async run(session: Session): Promise<string> {
    const toolDeclarations = this.toolRegistry.getFunctionDeclarations();

    for (let step = 1; step <= this.maxSteps; step++) {
      CLI.renderStepHeader(step, this.maxSteps);

      // 1. Gửi session hiện tại cho LLM
      const response = await this.llm.generate(session, toolDeclarations);

      // 2. Nếu model muốn gọi tool
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

          CLI.renderToolCall(toolName, toolArgs);

          // Chạy tool qua pipeline an toàn
          const executionResult = await this.toolRunner.run(toolName, toolArgs);

          CLI.renderToolResult(toolName, executionResult.durationMs, executionResult.result);

          // Ghi Tool Result vào Session để LLM đọc và quan sát ở bước tiếp theo
          session.addToolResult(toolName, executionResult.result);
        }

        CLI.renderStepFooter();

        // Quay lại đầu vòng lặp để LLM xử lý kết quả
        continue;
      }

      // 3. Nếu model trả về câu trả lời cuối cùng (Final Answer)
      const finalAnswer = response.text || '(Không có phản hồi từ model)';
      
      CLI.renderModelAction('final_answer');
      CLI.renderStepFooter();
      CLI.renderFinalAnswer(finalAnswer);

      // Ghi nhận câu trả lời cuối cùng vào Session
      session.addModelMessage({ text: finalAnswer, rawContent: response.rawContent });

      return finalAnswer;
    }

    // 4. Nếu đạt maxSteps mà chưa hoàn thành
    const timeoutMessage = `Agent stopped: maximum steps (${this.maxSteps}) reached without final answer.`;
    CLI.renderModelAction('max_steps');
    CLI.renderStepFooter();
    CLI.renderFinalAnswer(timeoutMessage);
    
    return timeoutMessage;
  }
}
