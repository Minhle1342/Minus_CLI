import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { SubagentManager } from '../agent/subagent-manager.js';
import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
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

export function createSpawnAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'spawn_agent',
    description: 'Spawn a clean-context child agent with an explicit task brief and scoped capabilities.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        brief: { type: Type.STRING, description: 'Detailed prompt brief and task instructions for the child agent.' },
        maxSteps: { type: Type.INTEGER, description: 'Maximum step budget for the child agent.' },
        toolNames: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional list of allowed tool names.' },
        worktreePath: { type: Type.STRING, description: 'Optional isolated worktree path for this agent.' },
      },
      required: ['brief'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const brief = String(args.brief || '').trim();
      if (!brief) return { error: 'Param "brief" is required.' };
      const handle = manager.spawn(brief, {
        maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
        toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
        worktreePath: args.worktreePath ? String(args.worktreePath) : undefined,
      });
      return { success: true, agentId: handle.id, agent: handle };
    },
  };
}

export function createWaitAgentTool(manager: SubagentManager): ToolDefinition {
  return {
    name: 'wait_agent',
    description: 'Wait synchronously for a spawned child agent to complete its task without polling.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: { type: Type.STRING, description: 'The child agent ID to wait for.' },
        timeoutMs: { type: Type.INTEGER, description: 'Timeout in milliseconds (default 60000ms).' },
      },
      required: ['agentId'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const agentId = String(args.agentId || '').trim();
      if (!agentId) return { error: 'Param "agentId" is required.' };
      try {
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60000;
        const result = await manager.waitFor(agentId, timeoutMs);
        return {
          success: true,
          agentId: result.id,
          status: result.status,
          answer: result.answer,
          error: result.error,
        };
      } catch (err: any) {
        return { success: false, error: err.message, agentId };
      }
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

export function createAllocateAgentTaskTool(orchestrator: AgentOrchestrator): ToolDefinition {
  return {
    name: 'allocate_agent_task',
    description: 'Phân bổ và điều phối một tác vụ cho một Agent phù hợp dựa trên danh sách năng lực (capabilities matching).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: {
          type: Type.STRING,
          description: 'Mục tiêu độc lập cần thực hiện.',
        },
        requiredCapabilities: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Danh sách các năng lực bắt buộc cần có của agent (ví dụ: ["frontend", "react"], ["database", "sql"]).',
        },
        maxSteps: {
          type: Type.INTEGER,
          description: 'Giới hạn số bước thực thi cho agent.',
        },
        toolNames: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Danh sách các công cụ được phép sử dụng.',
        },
        priority: {
          type: Type.STRING,
          description: 'Mức độ ưu tiên tác vụ: "high" (tối đa chất lượng), "normal", "low" (tiết kiệm chi phí/tải).',
        },
        preferCostEfficient: {
          type: Type.BOOLEAN,
          description: 'Nếu true, ưu tiên các mô hình chi phí thấp và tốc độ cao.',
        },
        memoize: {
          type: Type.BOOLEAN,
          description: 'Nếu true, lưu và tái sử dụng kết quả trong bộ nhớ đệm khi lặp lại cùng mục tiêu.',
        },
      },
      required: ['objective'],
    },
    async execute(args: Record<string, any>, _workspace: Workspace): Promise<Record<string, any>> {
      const objective = String(args.objective || '').trim();
      if (!objective) return { error: 'Tham số "objective" là bắt buộc.' };
      const requiredCapabilities = Array.isArray(args.requiredCapabilities)
        ? args.requiredCapabilities.map(String)
        : [];
      try {
        const handle = orchestrator.allocateTask(objective, requiredCapabilities, {
          maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : undefined,
          toolNames: Array.isArray(args.toolNames) ? args.toolNames.map(String) : undefined,
          priority: args.priority === 'high' || args.priority === 'low' ? args.priority : undefined,
          preferCostEfficient: args.preferCostEfficient === true,
          memoize: args.memoize === true,
        });
        return { success: true, agent: handle };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
}
