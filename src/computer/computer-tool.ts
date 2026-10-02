import { Type } from '@google/genai';
import { ToolDefinition } from '../tools/types.js';
import { Workspace } from '../workspace/workspace.js';
import { toolSuccess, toolError } from '../tools/tool-result.js';
import { ComputerController } from './computer-controller.js';
import type { ComputerActionParams } from './types.js';

/**
 * Factory tạo Computer Use tool.
 * Cung cấp khả năng tương tác trực tiếp với giao diện máy tính (GUI/Desktop).
 */
export function createComputerTool(controller: ComputerController): ToolDefinition {
  return {
    name: 'computer',
    description:
      'Computer control tool (Computer Use) that interacts directly with the operating system and desktop GUI. Supports screenshots, mouse_move, mouse clicks (left_click, right_click, double_click, triple_click, middle_click), drag, Unicode text typing (type), key presses / keyboard shortcuts (key - e.g. "enter", "tab", "esc", "ctrl+c", "ctrl+v", "win+r", "alt+tab"), mouse scroll (scroll), and waiting for UI render (wait). On screenshot, the image is automatically loaded into the Vision context for the agent to observe directly.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description:
            'Action to perform: "screenshot" (capture the screen), "left_click", "right_click", "double_click", "triple_click", "middle_click", "mouse_move", "drag", "mouse_down", "mouse_up", "type" (type text), "key" (press a shortcut), "scroll" (scroll), "wait" (wait), "cursor_position", "screen_size".',
        },
        coordinate: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description:
            '[x, y] coordinates for mouse actions. These correspond to coordinates on the most recent screenshot (the system automatically scales them to real physical coordinates).',
        },
        x: {
          type: Type.INTEGER,
          description: 'X coordinate (replaces or equals element 0 of coordinate).',
        },
        y: {
          type: Type.INTEGER,
          description: 'Y coordinate (replaces or equals element 1 of coordinate).',
        },
        start_coordinate: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: 'Start coordinates [start_x, start_y] for drag operations.',
        },
        end_coordinate: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: 'End coordinates [end_x, end_y] for drag operations.',
        },
        text: {
          type: Type.STRING,
          description: 'Text to type for action="type". Full Unicode support.',
        },
        key: {
          type: Type.STRING,
          description:
            'Key or keyboard shortcut for action="key" (e.g. "enter", "escape", "tab", "backspace", "delete", "up", "down", "ctrl+a", "ctrl+c", "ctrl+v", "alt+f4", "alt+tab", "win+r", "f5").',
        },
        direction: {
          type: Type.STRING,
          description: 'Scroll direction for action="scroll": "up", "down", "left", or "right" (default: "down").',
        },
        amount: {
          type: Type.INTEGER,
          description: 'Number of mouse-wheel notches for action="scroll" (default: 3).',
        },
        duration_ms: {
          type: Type.INTEGER,
          description: 'Duration in milliseconds for action="wait" or the duration of a drag operation.',
        },
        interval_ms: {
          type: Type.INTEGER,
          description: 'Delay in milliseconds between keystrokes for action="type" (default 15ms).',
        },
        coordinateSpace: {
          type: Type.STRING,
          description:
            'Coordinate space: "auto" (default: automatically maps screenshot coordinates to physical screen coordinates), "scaled" (image coordinates), or "screen" (real physical screen coordinates).',
        },
        attachToContext: {
          type: Type.BOOLEAN,
          description:
            'Defaults to true for action="screenshot". Automatically attaches the image to the Vision conversation context for the model to observe directly.',
        },
        description: {
          type: Type.STRING,
          description: 'Purpose of the action (e.g. "Take a screenshot to find the Login button" or "Click the search bar").',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const rawAction = String(args.action || '').trim();
      if (!rawAction) {
        return toolError('The "action" parameter is required.', 'INVALID_ARGS');
      }

      try {
        const params: ComputerActionParams = {
          action: rawAction as any,
          coordinate: args.coordinate,
          x: args.x !== undefined ? Number(args.x) : undefined,
          y: args.y !== undefined ? Number(args.y) : undefined,
          start_coordinate: args.start_coordinate,
          end_coordinate: args.end_coordinate,
          start_x: args.start_x !== undefined ? Number(args.start_x) : undefined,
          start_y: args.start_y !== undefined ? Number(args.start_y) : undefined,
          end_x: args.end_x !== undefined ? Number(args.end_x) : undefined,
          end_y: args.end_y !== undefined ? Number(args.end_y) : undefined,
          button: args.button,
          clicks: args.clicks !== undefined ? Number(args.clicks) : undefined,
          text: args.text !== undefined ? String(args.text) : undefined,
          key: args.key !== undefined ? String(args.key) : undefined,
          direction: args.direction,
          amount: args.amount !== undefined ? Number(args.amount) : undefined,
          duration_ms: args.duration_ms !== undefined ? Number(args.duration_ms) : undefined,
          interval_ms: args.interval_ms !== undefined ? Number(args.interval_ms) : undefined,
          coordinateSpace: args.coordinateSpace,
          attachToContext: args.attachToContext,
          description: args.description,
        };

        const result = await controller.execute(params, undefined, workspace.rootDir);

        if (!result.success) {
          return toolError(
            result.error || `Failed to execute computer action (${rawAction}).`,
            'EXECUTION_ERROR'
          );
        }

        return toolSuccess(result);
      } catch (err: any) {
        return toolError(`Error executing computer action: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };
}
