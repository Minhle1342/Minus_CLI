import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { toolSuccess, toolError } from './tool-result.js';
import type { Session } from '../session/session.js';

export interface ImageMetadata {
  format: string;
  mimeType: string;
  fileSizeBytes: number;
  width?: number;
  height?: number;
  aspectRatio?: string;
}

/**
 * Trích xuất định dạng và kích thước cơ bản từ header nhị phân của ảnh (PNG, JPEG, GIF, WEBP)
 */
export function extractImageDimensions(buffer: Buffer, mimeType: string): { width?: number; height?: number } {
  try {
    if (mimeType === 'image/png' && buffer.length >= 24) {
      // PNG IHDR chunk chứa width ở byte 16-19, height ở byte 20-23
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    if (mimeType === 'image/gif' && buffer.length >= 10) {
      // GIF Header chứa width ở byte 6-7, height ở byte 8-9 (Little Endian)
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }

    if (mimeType === 'image/webp' && buffer.length >= 30) {
      // WebP VP8 hoặc VP8L chunk
      if (buffer.toString('ascii', 12, 16) === 'VP8L') {
        const b0 = buffer[21];
        const b1 = buffer[22];
        const b2 = buffer[23];
        const b3 = buffer[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
    }

    if (mimeType === 'image/jpeg' && buffer.length >= 32) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        // SOF0 - SOF2 markers
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }
  } catch {
    // Trả về không xác định nếu buffer không chuẩn
  }
  return {};
}

export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'image/png';
  }
}

/**
 * Factory tạo inspect_image tool
 */
export function createInspectImageTool(sessionAccessor?: () => Session | undefined): ToolDefinition {
  return {
    name: 'inspect_image',
    description: 'Đọc và phân tích ảnh (PNG, JPG, JPEG, WEBP, GIF, SVG) trong workspace. Trích xuất kích thước, dung lượng, và đính kèm trực tiếp vào ngữ cảnh hội thoại đa phương thức (Multimodal Vision) để LLM có thể quan sát trực quan.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: 'Đường dẫn tương đối tới file ảnh trong workspace (ví dụ: "screenshots/login.png" hoặc "assets/logo.jpg")',
        },
        description: {
          type: Type.STRING,
          description: 'Mô tả ngắn về mục đích kiểm tra ảnh (ví dụ: "Kiểm tra lỗi giao diện responsive trên mobile")',
        },
        attachToContext: {
          type: Type.BOOLEAN,
          description: 'Mặc định true. Đính kèm ảnh dạng Base64 vào ngữ cảnh multimodal của phiên làm việc để LLM quan sát trực tiếp.',
        },
      },
      required: ['path'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const rawPath = String(args.path || '').trim();
      if (!rawPath) {
        return toolError('Tham số "path" là bắt buộc.', 'INVALID_ARGS');
      }

      try {
        const safePath = workspace.resolveSafePath(rawPath);
        const stat = await fs.stat(safePath);

        if (!stat.isFile()) {
          return toolError(`Đường dẫn "${rawPath}" không phải là tệp.`, 'INVALID_ARGS');
        }

        // Giới hạn dung lượng ảnh tối đa 15MB để tránh quá tải RAM/Token
        const MAX_IMAGE_SIZE = 15 * 1024 * 1024;
        if (stat.size > MAX_IMAGE_SIZE) {
          return toolError(`Dung lượng ảnh (${(stat.size / 1024 / 1024).toFixed(2)} MB) vượt quá giới hạn 15MB.`, 'EXECUTION_ERROR');
        }

        const buffer = await fs.readFile(safePath);
        const mimeType = detectMimeType(safePath);
        const dimensions = extractImageDimensions(buffer, mimeType);
        const base64Data = buffer.toString('base64');
        const attachToContext = args.attachToContext !== false;

        const session = sessionAccessor?.();
        let attached = false;
        if (attachToContext && session) {
          session.addMultimodalUserMessage(
            args.description || `[Đã đính kèm ảnh: ${path.relative(workspace.rootDir, safePath)}]`,
            [
              {
                mimeType,
                data: base64Data,
                description: args.description,
                filePath: path.relative(workspace.rootDir, safePath),
              },
            ],
            'injected'
          );
          attached = true;
        }

        return toolSuccess({
          filePath: path.relative(workspace.rootDir, safePath).replace(/\\/g, '/'),
          mimeType,
          fileSizeBytes: stat.size,
          fileSizeFormatted: `${(stat.size / 1024).toFixed(1)} KB`,
          width: dimensions.width,
          height: dimensions.height,
          aspectRatio: dimensions.width && dimensions.height ? `${(dimensions.width / dimensions.height).toFixed(2)}:1` : undefined,
          attachedToMultimodalContext: attached,
          message: attached
            ? `Ảnh đã được nạp và đính kèm vào ngữ cảnh Vision của mô hình. LLM có thể phân tích trực quan.`
            : `Đã đọc siêu dữ liệu ảnh thành công.`,
        });
      } catch (err: any) {
        return toolError(`Không thể đọc file ảnh "${rawPath}": ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };
}

export const inspectImageTool = createInspectImageTool();
