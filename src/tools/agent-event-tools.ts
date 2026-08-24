import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { AgentEventBus } from '../agent/agent-event-bus.js';

/**
 * Tool: publish_agent_event
 * Phát sự kiện thông điệp theo Topic cho các Agent khác (Peer-to-Peer Pub/Sub)
 */
export function createPublishAgentEventTool(eventBus: AgentEventBus): ToolDefinition {
  return {
    name: 'publish_agent_event',
    description: 'Phát một sự kiện (broadcast event) theo Topic đến các Subagents khác đang lắng nghe trong hệ thống Multi-Agent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: 'Tên topic cần phát (ví dụ: "schema:updated", "build:success", "test:failed").',
        },
        payload: {
          type: Type.OBJECT,
          description: 'Dữ liệu đính kèm sự kiện (JSON object).',
        },
        senderId: {
          type: Type.STRING,
          description: 'Định danh của Agent phát sự kiện (mặc định: "agent").',
        },
      },
      required: ['topic', 'payload'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const topic = String(args.topic || '').trim();
      const payload = args.payload && typeof args.payload === 'object' ? args.payload : { data: args.payload };
      const senderId = String(args.senderId || 'agent').trim();

      if (!topic) {
        return { error: 'Tham số "topic" là bắt buộc.' };
      }

      await eventBus.publish(senderId, topic, payload);

      return {
        success: true,
        message: `Đã phát sự kiện topic '${topic}' thành công.`,
        event: {
          senderId,
          topic,
          payload,
          timestamp: new Date().toISOString(),
        },
      };
    },
  };
}
