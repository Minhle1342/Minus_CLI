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
      'Công cụ điều khiển máy tính (Computer Use) tương tác trực tiếp với hệ điều hành và giao diện đồ hoạ (Desktop GUI). Cho phép chụp màn hình (screenshot), di chuột (mouse_move), click chuột (left_click, right_click, double_click, triple_click, middle_click), kéo thả (drag), gõ văn bản Unicode (type), bấm phím/tổ hợp phím tắt (key - ví dụ: "enter", "tab", "esc", "ctrl+c", "ctrl+v", "win+r", "alt+tab"), cuộn chuột (scroll), và chờ UI render (wait). Khi chụp màn hình, ảnh sẽ tự động được nạp trực tiếp vào ngữ cảnh Vision để Agent quan sát trực quan.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description:
            'Hành động cần thực hiện: "screenshot" (chụp ảnh màn hình), "left_click", "right_click", "double_click", "triple_click", "middle_click", "mouse_move", "drag", "mouse_down", "mouse_up", "type" (gõ chữ), "key" (bấm phím tắt), "scroll" (cuộn), "wait" (chờ), "cursor_position", "screen_size".',
        },
        coordinate: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description:
            'Toạ độ [x, y] để thao tác chuột. Toạ độ này tương ứng với toạ độ trên ảnh chụp màn hình gần nhất (hệ thống sẽ tự động phóng tỉ lệ sang toạ độ vật lý thật).',
        },
        x: {
          type: Type.INTEGER,
          description: 'Toạ độ hoành độ x (thay thế hoặc tương đương phần tử 0 của coordinate).',
        },
        y: {
          type: Type.INTEGER,
          description: 'Toạ độ tung độ y (thay thế hoặc tương đương phần tử 1 của coordinate).',
        },
        start_coordinate: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: 'Toạ độ bắt đầu [start_x, start_y] khi thực hiện thao tác kéo thả (drag).',
        },
        end_coordinate: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: 'Toạ độ kết thúc [end_x, end_y] khi thực hiện thao tác kéo thả (drag).',
        },
        text: {
          type: Type.STRING,
          description: 'Văn bản cần gõ cho action="type". Hỗ trợ đầy đủ bảng mã Unicode và tiếng Việt có dấu.',
        },
        key: {
          type: Type.STRING,
          description:
            'Phím hoặc tổ hợp phím tắt cho action="key" (ví dụ: "enter", "escape", "tab", "backspace", "delete", "up", "down", "ctrl+a", "ctrl+c", "ctrl+v", "alt+f4", "alt+tab", "win+r", "f5").',
        },
        direction: {
          type: Type.STRING,
          description: 'Hướng cuộn cho action="scroll": "up", "down", "left", hoặc "right" (mặc định: "down").',
        },
        amount: {
          type: Type.INTEGER,
          description: 'Số nấc cuộn chuột cho action="scroll" (mặc định: 3).',
        },
        duration_ms: {
          type: Type.INTEGER,
          description: 'Thời gian mili-giây cho action="wait" hoặc thời lượng thực hiện thao tác drag.',
        },
        interval_ms: {
          type: Type.INTEGER,
          description: 'Độ trễ mili-giây giữa các phím gõ cho action="type" (mặc định 15ms).',
        },
        coordinateSpace: {
          type: Type.STRING,
          description:
            'Không gian toạ độ: "auto" (mặc định: tự động dịch chuyển từ toạ độ ảnh chụp sang toạ độ màn hình vật lý), "scaled" (toạ độ ảnh), hoặc "screen" (toạ độ vật lý thực của màn hình).',
        },
        attachToContext: {
          type: Type.BOOLEAN,
          description:
            'Mặc định true khi action="screenshot". Tự động đính kèm ảnh vào ngữ cảnh hội thoại Vision để mô hình quan sát trực quan.',
        },
        description: {
          type: Type.STRING,
          description: 'Mô tả mục đích của thao tác (ví dụ: "Chụp ảnh màn hình để tìm nút Login" hoặc "Click vào thanh tìm kiếm").',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const rawAction = String(args.action || '').trim();
      if (!rawAction) {
        return toolError('Tham số "action" là bắt buộc.', 'INVALID_ARGS');
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
            result.error || `Thực thi thao tác computer (${rawAction}) thất bại.`,
            'EXECUTION_ERROR'
          );
        }

        return toolSuccess(result);
      } catch (err: any) {
        return toolError(`Lỗi khi thực thi thao tác computer: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };
}
