import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { SubagentManager } from '../agent/subagent-manager.js';
import { Workspace } from '../workspace/workspace.js';

export function createDelegateAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'delegate_agent',
    description: 'Khởi chạy một subagent nền cho một nhiệm vụ độc lập; trả về agentId để poll kết quả.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: { type: Type.STRING, description: 'Mục tiêu độc lập cần subagent thực hiện.' },
        maxSteps: { type: Type.INTEGER, description: 'Giới hạn step của subagent (mặc định theo agent).' },
        toolNames: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Allowlist tool tùy chọn cho subagent.' },
      },
      required: ['objective'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const objective = String(args.objective || '').trim();
      if (!objective) return { error: 'Tham số "objective" là bắt buộc.' };
      const handle = manager.start(objective, {
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
      });
      return { success: true, agent: handle };
    },
  };
}

export function createGetAgentResultTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'get_agent_result',
    description: 'Đọc trạng thái và kết quả hiện tại của subagent đã delegate.',
    parameters: {
      type: Type.OBJECT,
      properties: { agentId: { type: Type.STRING, description: 'ID trả về từ delegate_agent.' } },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      const agent = manager.get(agentId);
      return agent ? { success: true, agent } : { success: false, error: 'SUBAGENT_NOT_FOUND', agentId };
    },
  };
}

export function createStopAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'stop_agent',
    description: 'Yêu cầu dừng một subagent đang chạy.',
    parameters: {
      type: Type.OBJECT,
      properties: { agentId: { type: Type.STRING, description: 'ID subagent cần dừng.' } },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      return { agentId, success: manager.stop(agentId) };
    },
  };
}

export function createResumeAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'resume_agent',
    description: 'Tiếp tục một subagent đã stopped/failed sau khi người vận hành xác nhận muốn chạy lại.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'ID subagent cần resume.' },
        maxSteps: { type: Type.INTEGER, description: 'Giới hạn step cho lần resume.' },
        toolNames: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Allowlist tool cho lần resume.' },
      },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      const agent = manager.resume(agentId, {
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
      });
      return agent
        ? { success: true, agent }
        : { success: false, error: 'SUBAGENT_NOT_RESUMABLE', agentId };
    },
  };
}
