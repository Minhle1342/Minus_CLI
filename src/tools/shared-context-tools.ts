import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { SharedContextService } from '../agent/shared-context-service.js';

/**
 * Tool: read_shared_context
 * Đọc dữ liệu từ Blackboard Memory chia sẻ giữa các Agent
 */
export function createReadSharedContextTool(sharedContext: SharedContextService): ToolDefinition {
  return {
    name: 'read_shared_context',
    description: 'Read data from the shared memory (Shared Blackboard Context) across subagents, or list all keys with versionHash.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Key to read in the shared context. If empty, returns the list of all available keys.',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const key = args.key ? String(args.key).trim() : undefined;

      if (!key) {
        const keys = sharedContext.listKeys();
        const entries = keys.map((k) => sharedContext.get(k));
        return {
          success: true,
          count: keys.length,
          keys,
          entries,
        };
      }

      const entry = sharedContext.get(key);
      if (!entry) {
        return {
          success: false,
          key,
          error: `Key '${key}' not found in shared context.`,
        };
      }

      return {
        success: true,
        entry,
      };
    },
  };
}

/**
 * Tool: write_shared_context
 * Ghi hoặc cập nhật dữ liệu vào Blackboard Memory với Khóa Lạc Quan (OCC)
 */
export function createWriteSharedContextTool(sharedContext: SharedContextService): ToolDefinition {
  return {
    name: 'write_shared_context',
    description: 'Write or update data in the shared memory (Shared Blackboard) across agents with Optimistic Concurrency Control (OCC) against overwrite conflicts.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: 'Data key to store (e.g. "api_contracts", "design_tokens", "backend_endpoints").',
        },
        value: {
          type: Type.STRING,
          description: 'Data to store (string or JSON stringified).',
        },
        agentId: {
          type: Type.STRING,
          description: 'ID of the writing agent (default: "agent").',
        },
        expectedVersionHash: {
          type: Type.STRING,
          description: 'Expected version hash (OCC versionHash) to ensure no other agent overwrites mid-write.',
        },
        filePath: {
          type: Type.STRING,
          description: 'Linked file path (optional) to enable the File-bound OCC mechanism.',
        },
        expectedFileHash: {
          type: Type.STRING,
          description: 'Expected SHA-256 hash of the linked file to prevent file-data overwrite conflicts.',
        },
      },
      required: ['key', 'value'],
    },
    async execute(args: Record<string, any>): Promise<Record<string, any>> {
      const key = String(args.key || '').trim();
      const rawValue = args.value;
      const agentId = String(args.agentId || 'agent').trim();
      const expectedVersionHash = args.expectedVersionHash ? String(args.expectedVersionHash).trim() : undefined;
      const filePath = args.filePath ? String(args.filePath).trim() : undefined;
      const expectedFileHash = args.expectedFileHash ? String(args.expectedFileHash).trim() : undefined;

      if (!key) {
        return { error: 'The "key" parameter is required.' };
      }
      if (rawValue === undefined) {
        return { error: 'The "value" parameter is required.' };
      }

      let parsedValue: any = rawValue;
      if (typeof rawValue === 'string') {
        try {
          parsedValue = JSON.parse(rawValue);
        } catch {
          parsedValue = rawValue;
        }
      }

      try {
        const entry = sharedContext.set(key, parsedValue, agentId, {
          expectedVersionHash,
          filePath,
          expectedFileHash,
        });
        return {
          success: true,
          message: `Successfully wrote key '${key}' to shared context.`,
          entry,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message,
          conflict: err.message.includes('Optimistic concurrency conflict'),
        };
      }
    },
  };
}
