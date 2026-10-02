import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { pack, loadFileConfig, mergeConfigs, setLogLevel } from 'repomix';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { buildAdaptiveCodeBundle, type FocusRange } from '../search/adaptive-code-reader.js';

// Tắt hoàn toàn banner/warning của Repomix ra stdout để đảm bảo UI CLI tinh gọn
try {
  setLogLevel(-1);
  process.env.REPOMIX_LOG_LEVEL = '-1';
} catch {}

async function packWithTemporaryOutput(
  rootDir: string,
  config: Parameters<typeof pack>[1],
): Promise<Awaited<ReturnType<typeof pack>>> {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-repomix-'));
  try {
    return await pack([rootDir], {
      ...config,
      output: {
        ...config.output,
        filePath: path.join(temporaryDir, 'repomix-output.xml'),
      },
    });
  } finally {
    await fs.rm(temporaryDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }).catch(() => undefined);
  }
}

/**
 * createReadCompressedCodeTool
 * Sử dụng Repomix & Tree-sitter để nén cấu trúc code (trích xuất signatures, types, classes và lược bỏ chi tiết)
 * Tiết kiệm 70% - 85% Token so với read_file thông thường.
 */
export function createReadCompressedCodeTool(): ToolDefinition {
  return {
    name: 'read_compressed_code',
    description:
      'Read Tree-sitter-compressed source structure and content via Repomix. ' +
      'Automatically keep important definitions (functions, classes, types, interfaces, exports) ' +
      'and drop detailed function bodies. Saves 70% - 85% LLM tokens when surveying source code.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        paths: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of relative or absolute file paths to read in compressed form (e.g. ["src/agent/agent-loop.ts", "src/llm/gemini.ts"]).',
        },
        path: {
          type: Type.STRING,
          description: 'Alias for paths when reading a single file (e.g. "src/agent/agent-loop.ts").',
        },
        compress: {
          type: Type.BOOLEAN,
          description: 'Whether to enable Tree-sitter compression (default: true).',
        },
        fidelity: {
          type: Type.STRING,
          enum: ['compressed', 'adaptive', 'full'],
          description: 'Detail level: compressed, multi-resolution adaptive, or full. Default keeps the legacy compress behavior.',
        },
        focusSymbols: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Symbols needing full function/class bodies in adaptive mode.',
        },
        focusRanges: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              path: { type: Type.STRING },
              start: { type: Type.INTEGER, minimum: 1 },
              end: { type: Type.INTEGER, minimum: 1 },
            },
            required: ['path', 'start', 'end'],
          },
          description: 'Line ranges to return verbatim in adaptive mode.',
        },
        previewLines: {
          type: Type.INTEGER,
          minimum: 4,
          maximum: 200,
          description: 'Number of preview lines around nearby symbols (default 24).',
        },
        maxTokens: {
          type: Type.INTEGER,
          minimum: 64,
          maximum: 100000,
          description: 'Hard token budget for adaptive segments (default 8000).',
        },
        includeDirectoryStructure: {
          type: Type.BOOLEAN,
          description: 'Include the path tree of selected files (default true).',
        },
      },
      required: [],
    },
    async execute(args, workspace: Workspace) {
      // Tool-Use Guardian: Parameter Coercion cho paths, path, filePath, file
      const rawPaths = args.paths ?? args.path ?? args.filePath ?? args.file;
      const filePaths: string[] = Array.isArray(rawPaths)
        ? rawPaths.map(String).map(s => s.trim()).filter((p) => p && p !== 'undefined')
        : rawPaths && String(rawPaths).trim() !== 'undefined'
          ? [String(rawPaths).trim()]
          : [];
      const fidelity = ['compressed', 'adaptive', 'full'].includes(String(args.fidelity))
        ? String(args.fidelity) as 'compressed' | 'adaptive' | 'full'
        : undefined;
      const adaptiveEnabled = process.env.MINUS_ADAPTIVE_CODE_READ !== 'off';
      if (fidelity === 'adaptive' && !adaptiveEnabled) {
        return { error: 'Adaptive code reading is disabled by MINUS_ADAPTIVE_CODE_READ=off.', errorCode: 'FEATURE_DISABLED' };
      }
      const shouldCompress = fidelity === 'full' ? false : (fidelity === 'adaptive' ? true : args.compress !== false);

      if (!filePaths || filePaths.length === 0) {
        return { error: 'The "paths" (or "path") parameter is required and must contain at least 1 file path.' };
      }

      // Chuẩn hóa đường dẫn tương đối theo workspace root
      const relativePaths = filePaths.map((p) => {
        const resolved = workspace.resolveSafePath(p);
        return path.relative(workspace.rootDir, resolved).replace(/\\/g, '/');
      });

      try {
        try { setLogLevel(-1); } catch {}
        const baseConfig = await loadFileConfig(workspace.rootDir, null);
        const config = mergeConfigs(workspace.rootDir, { ...baseConfig, include: [] }, {
          output: {
            compress: shouldCompress,
          },
          include: relativePaths,
          ignore: {
            useDefaultPatterns: true,
            customPatterns: ['node_modules/**', '.git/**', 'dist/**', '.codingagent/**'],
          },
        });

        const result = await packWithTemporaryOutput(workspace.rootDir, config);

        const files = (result.processedFiles || []).map((f) => ({
          path: f.path,
          content: f.content,
          tokens: result.fileTokenCounts?.[f.path] ?? null,
        }));

        if (fidelity === 'adaptive') {
          const compressedByPath = new Map(files.map((file) => [file.path.replace(/\\/g, '/'), file.content]));
          const sourceFiles = await Promise.all(relativePaths.map(async (relativePath) => ({
            path: relativePath,
            content: await fs.readFile(workspace.resolveSafePath(relativePath), 'utf8'),
            compressedContent: compressedByPath.get(relativePath),
          })));
          const focusRanges: FocusRange[] = Array.isArray(args.focusRanges)
            ? args.focusRanges.map((range: any) => ({
                path: String(range.path || ''),
                start: Number(range.start),
                end: Number(range.end),
              }))
            : [];
          const bundle = buildAdaptiveCodeBundle(sourceFiles, {
            focusSymbols: Array.isArray(args.focusSymbols) ? args.focusSymbols.map(String) : [],
            focusRanges,
            previewLines: args.previewLines === undefined ? undefined : Number(args.previewLines),
            maxTokens: args.maxTokens === undefined ? undefined : Number(args.maxTokens),
            includeDirectoryStructure: args.includeDirectoryStructure !== false,
          });
          return {
            totalFiles: result.totalFiles,
            totalTokens: bundle.estimatedTokens,
            compressionEnabled: true,
            fidelity: 'adaptive',
            ...bundle,
            message: `Read ${result.totalFiles} file(s) in a multi-resolution bundle with ~${bundle.estimatedTokens} tokens.`,
          };
        }

        const MAX_UNMASKED_REPOMIX_TOKENS = 4000;
        const totalEstimatedTokens = result.totalTokens || 0;
        if (totalEstimatedTokens > MAX_UNMASKED_REPOMIX_TOKENS && files.length > 0) {
          const scratchDir = path.join(workspace.rootDir, '.codingagent', 'scratch');
          await fs.mkdir(scratchDir, { recursive: true }).catch(() => undefined);
          const timestamp = Date.now();
          const offloadFilename = `repomix-packed-${timestamp}.txt`;
          const offloadRelativePath = `.codingagent/scratch/${offloadFilename}`;
          const offloadAbsolutePath = path.join(scratchDir, offloadFilename);

          const fullTextPayload = files
            .map((f) => `=== FILE: ${f.path} (~${f.tokens ?? 'n/a'} tokens) ===\n${f.content || ''}`)
            .join('\n\n');

          await fs.writeFile(offloadAbsolutePath, fullTextPayload, 'utf8').catch(() => undefined);

          const maskedFiles = files.map((f) => {
            const rawContent = f.content || '';
            const previewLines = rawContent.split(/\r?\n/).slice(0, 15).join('\n');
            return {
              path: f.path,
              tokens: f.tokens,
              preview: previewLines,
              status: 'MASKED_TO_SCRATCH',
            };
          });

          return {
            totalFiles: result.totalFiles,
            totalTokens: result.totalTokens,
            compressionEnabled: shouldCompress,
            fidelity: fidelity || (shouldCompress ? 'compressed' : 'full'),
            observationMasked: true,
            offloadFilePath: offloadRelativePath,
            files: maskedFiles,
            message: `[OBSERVATION MASKED]: Detailed content of ${result.totalFiles} file(s) (~${result.totalTokens} tokens) was offloaded to "${offloadRelativePath}" to prevent context overflow. Returning a 15-line preview per file. Use the "read_file" tool with startLine/maxLines to read the exact locations to edit.`,
          };
        }

        return {
          totalFiles: result.totalFiles,
          totalTokens: result.totalTokens,
          compressionEnabled: shouldCompress,
          fidelity: fidelity || (shouldCompress ? 'compressed' : 'full'),
          files,
          message: `Compressed and read ${result.totalFiles} file(s) successfully with an estimated total of ~${result.totalTokens} tokens (significant context savings).`,
        };
      } catch (err: any) {
        return {
          error: `Failed to run repomix read_compressed_code: ${err.message}`,
          errorCode: 'REPOMIX_COMPRESS_ERROR',
        };
      }
    },
  };
}

/**
 * createPackCodebaseTool
 * Đóng gói toàn bộ hoặc các phần được chọn của codebase theo định dạng tối ưu Token cho AI.
 */
export function createPackCodebaseTool(): ToolDefinition {
  return {
    name: 'pack_codebase',
    description:
      'Pack the whole repository or a group of directories/files into a Tree-sitter structure-compressed summary so the AI grasps the project overview.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        include: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of glob patterns to include (e.g. ["src/**/*.ts"]). Leave empty to scan the whole repo.',
        },
        compress: {
          type: Type.BOOLEAN,
          description: 'Enable Tree-sitter structure compression to save tokens (default: true).',
        },
      },
    },
    async execute(args, workspace: Workspace) {
      const include = Array.isArray(args.include) && args.include.length > 0 ? args.include : undefined;
      const shouldCompress = args.compress !== false;

      try {
        try { setLogLevel(-1); } catch {}
        const baseConfig = await loadFileConfig(workspace.rootDir, null);
        const config = mergeConfigs(workspace.rootDir, baseConfig, {
          output: {
            compress: shouldCompress,
          },
          include,
          ignore: {
            useDefaultPatterns: true,
            customPatterns: ['node_modules/**', '.git/**', 'dist/**', '.codingagent/**', '*.lock', 'package-lock.json'],
          },
        });

        const result = await packWithTemporaryOutput(workspace.rootDir, config);

        return {
          totalFiles: result.totalFiles,
          totalTokens: result.totalTokens,
          totalCharacters: result.totalCharacters,
          fileSummary: (result.processedFiles || []).map((f) => ({
            path: f.path,
            tokens: result.fileTokenCounts?.[f.path] ?? null,
          })),
          summary: `Packed ${result.totalFiles} file(s) (~${result.totalTokens} tokens). You can use the "read_compressed_code" tool to read specific files in detail.`,
        };
      } catch (err: any) {
        return {
          error: `Failed to pack codebase: ${err.message}`,
          errorCode: 'REPOMIX_PACK_ERROR',
        };
      }
    },
  };
}
