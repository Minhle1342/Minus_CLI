import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { toolSuccess, toolError } from './tool-result.js';
import { extractImageDimensions } from './inspect-image.js';
import type { Session } from '../session/session.js';

/**
 * Minimal subset of the GoogleGenAI client needed for image generation.
 * Declared as an interface so tests can inject a mock without network access.
 */
export interface ImageGenClient {
  models: {
    generateContent(request: {
      model: string;
      contents: string;
      config: { responseModalities: string[]; aspectRatio?: string };
    }): Promise<{
      candidates?: Array<{
        finishReason?: string;
        content?: {
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType?: string; data?: string };
          }>;
        };
      }>;
    }>;
  };
}

/** Nano Banana image model (text-to-image). */
export const IMAGE_GENERATION_MODEL = 'gemini-2.5-flash-image';
export const DEFAULT_IMAGE_OUTPUT_DIR = 'assets/generated';
export const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
const MAX_PROMPT_CHARS = 4000;

function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 40);
  return slug || 'image';
}

function buildDefaultOutputPath(prompt: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${DEFAULT_IMAGE_OUTPUT_DIR}/${slugifyPrompt(prompt)}-${timestamp}.png`;
}

function extractGeneratedImage(response: Awaited<ReturnType<ImageGenClient['models']['generateContent']>>): { mimeType: string; base64: string } | undefined {
  for (const candidate of response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        return { mimeType: part.inlineData.mimeType || 'image/png', base64: part.inlineData.data };
      }
    }
  }
  return undefined;
}

/**
 * Factory tạo generate_image tool — text-to-image qua Nano Banana model.
 * Ảnh được lưu trong workspace mà CLI đang code (workspace-relative path),
 * không bao giờ ghi ra ngoài workspace.
 */
export function createGenerateImageTool(
  sessionAccessor?: () => Session | undefined,
  options?: { client?: ImageGenClient; apiKey?: string },
): ToolDefinition {
  return {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt with the Nano Banana image model (gemini-2.5-flash-image), save it into the current workspace and attach it to the multimodal context. Use for banners, diagrams, mockups, icons, illustrations and any visual asset the task needs. Requires GEMINI_API_KEY.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description: 'Detailed text description of the image to generate (subject, style, colors, composition).',
        },
        outputPath: {
          type: Type.STRING,
          description: `Optional workspace-relative output path (e.g. "assets/banner.png"). Defaults to "${DEFAULT_IMAGE_OUTPUT_DIR}/<slug>-<timestamp>.png".`,
        },
        aspectRatio: {
          type: Type.STRING,
          enum: IMAGE_ASPECT_RATIOS,
          description: 'Optional aspect ratio of the generated image. Defaults to "1:1".',
        },
      },
      required: ['prompt'],
    },
    async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) {
        return toolError('The "prompt" parameter is required.', 'INVALID_ARGS');
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        return toolError(`Prompt is too long (${prompt.length} chars, max ${MAX_PROMPT_CHARS}).`, 'INVALID_ARGS');
      }

      const aspectRatio = String(args.aspectRatio || '').trim() || '1:1';
      if (!IMAGE_ASPECT_RATIOS.includes(aspectRatio)) {
        return toolError(
          `Invalid aspectRatio "${aspectRatio}". Allowed: ${IMAGE_ASPECT_RATIOS.join(', ')}.`,
          'INVALID_ARGS',
        );
      }

      const outputPath = String(args.outputPath || '').trim() || buildDefaultOutputPath(prompt);

      const apiKey = options?.apiKey || process.env.GEMINI_API_KEY || '';
      if (!apiKey) {
        return toolError(
          'GEMINI_API_KEY is not configured, so the image model cannot be called.',
          'EXECUTION_ERROR',
          undefined,
          'Set GEMINI_API_KEY in .env (free at https://aistudio.google.com/)',
        );
      }

      try {
        const client: ImageGenClient = options?.client || new GoogleGenAI({ apiKey });
        const response = await client.models.generateContent({
          model: IMAGE_GENERATION_MODEL,
          contents: prompt,
          config: { responseModalities: ['IMAGE'], aspectRatio },
        });

        const image = extractGeneratedImage(response);
        if (!image) {
          const finishReason = response.candidates?.[0]?.finishReason;
          return toolError(
            `The image model returned no image data${finishReason ? ` (finishReason: ${finishReason})` : ''}. Try a more concrete prompt.`,
            'EXECUTION_ERROR',
          );
        }

        const buffer = Buffer.from(image.base64, 'base64');
        const safePath = workspace.resolveSafePath(outputPath);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, buffer);

        const dimensions = extractImageDimensions(buffer, image.mimeType);
        const relativePath = path.relative(workspace.rootDir, safePath).replace(/\\/g, '/');

        const session = sessionAccessor?.();
        let attached = false;
        if (session) {
          session.addMultimodalUserMessage(
            `[Generated image: ${relativePath}]`,
            [
              {
                mimeType: image.mimeType,
                data: image.base64,
                description: `Generated from prompt: ${prompt}`,
                filePath: relativePath,
              },
            ],
            'injected',
          );
          attached = true;
        }

        return toolSuccess({
          filePath: relativePath,
          mimeType: image.mimeType,
          fileSizeBytes: buffer.length,
          fileSizeFormatted: `${(buffer.length / 1024).toFixed(1)} KB`,
          width: dimensions.width,
          height: dimensions.height,
          aspectRatio,
          model: IMAGE_GENERATION_MODEL,
          prompt,
          attachedToMultimodalContext: attached,
          message: attached
            ? 'Image generated, saved to the workspace and attached to the model Vision context.'
            : 'Image generated and saved to the workspace.',
        });
      } catch (err: any) {
        if (err?.message?.startsWith('Security Exception')) {
          return toolError(
            `Output path "${outputPath}" escapes the workspace and was rejected.`,
            'SECURITY_VIOLATION',
            undefined,
            'Provide a workspace-relative path (e.g. "assets/banner.png").',
          );
        }
        return toolError(`Image generation failed: ${err.message}`, 'EXECUTION_ERROR');
      }
    },
  };
}

export const generateImageTool = createGenerateImageTool();
