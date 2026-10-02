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
    description: 'Broadcast an event (topic-based) to other listening subagents in the Multi-Agent system.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: {
          type: Type.STRING,
          description: 'Name of the topic to publish (e.g. "schema:updated", "build:success", "test:failed").',
        },
        payload: {
          type: Type.OBJECT,
          description: 'Event payload data (JSON object).',
        },
        senderId: {
          type: Type.STRING,
          description: 'ID of the publishing agent (default: "agent").',
        },
      },
      required: ['topic', 'payload'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const topic = String(args.topic || '').trim();
      const payload = args.payload && typeof args.payload === 'object' ? args.payload : { data: args.payload };
      const senderId = String(args.senderId || 'agent').trim();

      if (!topic) {
        return { error: 'The "topic" parameter is required.' };
      }

      await eventBus.publish(senderId, topic, payload);

      return {
        success: true,
        message: `Successfully published event on topic '${topic}'.`,
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
