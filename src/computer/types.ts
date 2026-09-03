/**
 * Types and schemas for Computer Use Agent capability
 */

export type ComputerAction =
  | 'screenshot'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'triple_click'
  | 'middle_click'
  | 'click'
  | 'mouse_down'
  | 'mouse_up'
  | 'drag'
  | 'left_click_drag'
  | 'scroll'
  | 'type'
  | 'key'
  | 'wait'
  | 'cursor_position'
  | 'screen_size';

export type CoordinateSpace = 'auto' | 'scaled' | 'screen';

export interface ComputerActionParams {
  action: ComputerAction;
  coordinate?: [number, number];
  x?: number;
  y?: number;
  start_coordinate?: [number, number];
  end_coordinate?: [number, number];
  start_x?: number;
  start_y?: number;
  end_x?: number;
  end_y?: number;
  button?: 'left' | 'right' | 'middle';
  clicks?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  duration_ms?: number;
  interval_ms?: number;
  coordinateSpace?: CoordinateSpace;
  attachToContext?: boolean;
  description?: string;
  max_width?: number;
  max_height?: number;
  return_base64?: boolean;
  out_path?: string;
}

export interface ComputerActionResult {
  success: boolean;
  action: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  original_width?: number;
  original_height?: number;
  scale_x?: number;
  scale_y?: number;
  path?: string;
  base64?: string;
  button?: string;
  clicks?: number;
  textLength?: number;
  key?: string;
  direction?: string;
  amount?: number;
  duration_ms?: number;
  error?: string;
  message?: string;
  attachedToMultimodalContext?: boolean;
  translatedCoordinates?: {
    inputX: number;
    inputY: number;
    screenX: number;
    screenY: number;
    scaleX: number;
    scaleY: number;
  };
}

export interface LastScreenshotMetadata {
  originalWidth: number;
  originalHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  scaleX: number;
  scaleY: number;
  filePath: string;
  capturedAt: number;
}

export interface ComputerControllerOptions {
  pythonPath?: string;
  driverPath?: string;
  defaultMaxWidth?: number;
  defaultMaxHeight?: number;
  safeMode?: boolean;
  rateLimitMs?: number;
}
