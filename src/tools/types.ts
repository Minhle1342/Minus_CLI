import type { FunctionDeclaration } from '@google/genai';
import type { Workspace } from '../workspace/workspace.js';

export interface ToolExecutionContext {
  sessionId?: string;
  agentId?: string;
  turn?: number;
  /** Original human request for the current turn, before guard prompts. */
  userRequest?: string;
  /** Internal capability set by ToolRunner only after PermissionManager approval. */
  permissionGranted?: boolean;
  permissionRequestId?: string;
  permissionManager?: any;
  /** Durable binding between the model-visible tool set and runtime authority. */
  decisionId?: string;
  allowedToolNames?: string[];
  allowedToolSetHash?: string;
  classificationPhase?: string;
  classificationRisk?: string;
  /** Set only by the orchestrator after checking session-backed evidence. */
  completionEvidenceVerified?: boolean;
  maxToolCalls?: number;
  /** Optional cancellation signal to abort long-running tools and child processes. */
  signal?: AbortSignal;
}

/**
 * Định nghĩa chuẩn cho một Tool trong hệ thống Coding Agent.
 * 
 * Mỗi Tool gồm 4 thành phần:
 * 1. name: Tên định danh duy nhất của Tool (vd: read_file, replace_text, run_command)
 * 2. description: Mô tả công dụng rõ ràng để LLM hiểu khi nào và tại sao nên dùng
 * 3. parameters: Schema FunctionDeclaration mô tả kiểu dữ liệu tham số đầu vào cho LLM
 * 4. execute: Hàm thực thi thực tế nhận args và workspace context, trả về dữ liệu JSON thô
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: FunctionDeclaration['parameters'];
  /** Optional strict schema for the canonical JSON result returned by execute(). */
  outputSchema?: FunctionDeclaration['parameters'];
  execute(
    args: Record<string, any>,
    workspace: Workspace,
    context?: ToolExecutionContext,
  ): Promise<Record<string, any>>;
}
