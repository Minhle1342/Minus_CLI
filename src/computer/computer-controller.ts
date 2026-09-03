import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Session } from '../session/session.js';
import type {
  ComputerActionParams,
  ComputerActionResult,
  ComputerControllerOptions,
  LastScreenshotMetadata,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ComputerController {
  private pythonPath: string;
  private driverPath: string;
  private defaultMaxWidth: number;
  private defaultMaxHeight: number;
  private safeMode: boolean;
  private rateLimitMs: number;
  private lastActionTime = 0;
  private lastScreenshot: LastScreenshotMetadata | null = null;
  private sessionAccessor?: () => Session | undefined;

  constructor(
    options: ComputerControllerOptions = {},
    sessionAccessor?: () => Session | undefined
  ) {
    this.pythonPath = options.pythonPath || process.env.PYTHON_BIN || 'python';
    this.driverPath = options.driverPath || path.join(__dirname, 'desktop-driver.py');
    this.defaultMaxWidth = options.defaultMaxWidth ?? 1280;
    this.defaultMaxHeight = options.defaultMaxHeight ?? 800;
    this.safeMode = options.safeMode ?? false;
    this.rateLimitMs = options.rateLimitMs ?? 50;
    this.sessionAccessor = sessionAccessor;
  }

  setSessionAccessor(accessor: () => Session | undefined): void {
    this.sessionAccessor = accessor;
  }

  getLastScreenshot(): LastScreenshotMetadata | null {
    return this.lastScreenshot;
  }

  clearLastScreenshot(): void {
    this.lastScreenshot = null;
  }

  /**
   * Translate coordinates from scaled screenshot space into physical screen space.
   */
  private translateCoordinates(
    x?: number,
    y?: number,
    space: 'auto' | 'scaled' | 'screen' = 'auto'
  ): { targetX?: number; targetY?: number; translated: boolean } {
    if (x === undefined || y === undefined) {
      return { targetX: x, targetY: y, translated: false };
    }

    if (space === 'screen' || !this.lastScreenshot) {
      return { targetX: Math.round(x), targetY: Math.round(y), translated: false };
    }

    // Space is 'scaled' or 'auto' (with active screenshot scale factors)
    const targetX = Math.round(x * this.lastScreenshot.scaleX);
    const targetY = Math.round(y * this.lastScreenshot.scaleY);
    return { targetX, targetY, translated: true };
  }

  async execute(
    params: ComputerActionParams,
    overrideSession?: Session,
    workspaceDir?: string
  ): Promise<ComputerActionResult> {
    // 1. Rate limiting
    const now = Date.now();
    const elapsed = now - this.lastActionTime;
    if (elapsed < this.rateLimitMs) {
      await new Promise((r) => setTimeout(r, this.rateLimitMs - elapsed));
    }
    this.lastActionTime = Date.now();

    // 2. Normalize and translate coordinates
    const coordSpace = params.coordinateSpace || 'auto';
    let inputX = params.x;
    let inputY = params.y;
    if (params.coordinate && Array.isArray(params.coordinate) && params.coordinate.length === 2) {
      inputX = params.coordinate[0];
      inputY = params.coordinate[1];
    }

    let screenX = inputX;
    let screenY = inputY;
    let wasTranslated = false;

    if (inputX !== undefined && inputY !== undefined) {
      const trans = this.translateCoordinates(inputX, inputY, coordSpace);
      screenX = trans.targetX;
      screenY = trans.targetY;
      wasTranslated = trans.translated;
    }

    // Normalize drag coordinates
    let startX = params.start_x;
    let startY = params.start_y;
    if (params.start_coordinate && Array.isArray(params.start_coordinate) && params.start_coordinate.length === 2) {
      startX = params.start_coordinate[0];
      startY = params.start_coordinate[1];
    }
    let endX = params.end_x;
    let endY = params.end_coordinate ? params.end_coordinate[1] : params.end_y;
    if (params.end_coordinate && Array.isArray(params.end_coordinate) && params.end_coordinate.length === 2) {
      endX = params.end_coordinate[0];
      endY = params.end_coordinate[1];
    }

    if (startX !== undefined && startY !== undefined) {
      const transStart = this.translateCoordinates(startX, startY, coordSpace);
      startX = transStart.targetX;
      startY = transStart.targetY;
    }
    if (endX !== undefined && endY !== undefined) {
      const transEnd = this.translateCoordinates(endX, endY, coordSpace);
      endX = transEnd.targetX;
      endY = transEnd.targetY;
    }

    // 3. Build payload for python desktop-driver
    const payload: Record<string, any> = {
      action: params.action,
      button: params.button,
      clicks: params.clicks,
      text: params.text,
      key: params.key,
      direction: params.direction,
      amount: params.amount,
      duration_ms: params.duration_ms,
      interval_ms: params.interval_ms,
    };

    if (screenX !== undefined && screenY !== undefined) {
      payload.x = screenX;
      payload.y = screenY;
    }
    if (startX !== undefined && startY !== undefined) {
      payload.start_x = startX;
      payload.start_y = startY;
    }
    if (endX !== undefined && endY !== undefined) {
      payload.end_x = endX;
      payload.end_y = endY;
    }

    // Prepare screenshot paths if action is screenshot
    if (params.action === 'screenshot') {
      const baseDir = workspaceDir || process.cwd();
      const screenshotsDir = path.join(baseDir, '.minus', 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });
      const filename = `screen_${Date.now()}.png`;
      payload.out_path = params.out_path || path.join(screenshotsDir, filename);
      payload.max_width = params.max_width ?? this.defaultMaxWidth;
      payload.max_height = params.max_height ?? this.defaultMaxHeight;
      payload.return_base64 = true; // Always fetch base64 to inject into multimodal context
    }

    // 4. Run python driver
    const driverResult = await this.invokeDriver(payload);

    if (!driverResult.success) {
      return driverResult;
    }

    // 5. Post-process actions
    if (params.action === 'screenshot') {
      this.lastScreenshot = {
        originalWidth: driverResult.original_width || 1920,
        originalHeight: driverResult.original_height || 1080,
        scaledWidth: driverResult.width || payload.max_width,
        scaledHeight: driverResult.height || payload.max_height,
        scaleX: driverResult.scale_x || 1.0,
        scaleY: driverResult.scale_y || 1.0,
        filePath: driverResult.path || payload.out_path,
        capturedAt: Date.now(),
      };

      const session = overrideSession || this.sessionAccessor?.();
      const shouldAttach = params.attachToContext !== false;
      let attached = false;

      if (shouldAttach && session && driverResult.base64) {
        const relativePath = workspaceDir ? path.relative(workspaceDir, this.lastScreenshot.filePath) : this.lastScreenshot.filePath;
        session.addMultimodalUserMessage(
          params.description || `[Computer Use: Screen captured] (${driverResult.width}x${driverResult.height}, scaled from ${driverResult.original_width}x${driverResult.original_height})`,
          [
            {
              mimeType: 'image/png',
              data: driverResult.base64,
              description: `Desktop screen capture (${driverResult.width}x${driverResult.height})`,
              filePath: relativePath,
            },
          ],
          'injected'
        );
        attached = true;
      }

      // Drop large base64 payload from the returned tool result to prevent token bloat
      const cleanResult: ComputerActionResult = {
        ...driverResult,
        base64: undefined,
        attachedToMultimodalContext: attached,
        message: attached
          ? `Đã chụp màn hình (${driverResult.width}x${driverResult.height}) và tự động nạp vào bộ nhớ Vision của Agent. Agent có thể quan sát trực tiếp các thành phần UI.`
          : `Đã chụp màn hình thành công và lưu tại: ${driverResult.path}`,
      };
      return cleanResult;
    }

    if (wasTranslated && inputX !== undefined && inputY !== undefined && screenX !== undefined && screenY !== undefined) {
      driverResult.translatedCoordinates = {
        inputX,
        inputY,
        screenX,
        screenY,
        scaleX: this.lastScreenshot?.scaleX ?? 1.0,
        scaleY: this.lastScreenshot?.scaleY ?? 1.0,
      };
    }

    return driverResult;
  }

  private invokeDriver(payload: Record<string, any>): Promise<ComputerActionResult> {
    return new Promise((resolve) => {
      const payloadStr = JSON.stringify(payload);
      const b64Arg = `b64:${Buffer.from(payloadStr, 'utf8').toString('base64')}`;

      const child = spawn(this.pythonPath, [this.driverPath, b64Arg], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve({
          success: false,
          action: payload.action || 'unknown',
          error: `Computer driver timed out after 15,000ms`,
        });
      }, 15000);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          resolve({
            success: false,
            action: payload.action || 'unknown',
            error: stderr.trim() || `Driver exited with code ${code}`,
          });
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch (err: any) {
          resolve({
            success: false,
            action: payload.action || 'unknown',
            error: `Failed to parse driver response: ${err.message}. Output was: ${stdout.slice(0, 300)}`,
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          action: payload.action || 'unknown',
          error: `Failed to spawn python desktop driver: ${err.message}`,
        });
      });
    });
  }
}
