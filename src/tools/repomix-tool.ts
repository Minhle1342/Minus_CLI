import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { pack, loadFileConfig, mergeConfigs } from 'repomix';
import path from 'node:path';

/**
 * createReadCompressedCodeTool
 * Sử dụng Repomix & Tree-sitter để nén cấu trúc code (trích xuất signatures, types, classes và lược bỏ chi tiết)
 * Tiết kiệm 70% - 85% Token so với read_file thông thường.
 */
export function createReadCompressedCodeTool(): ToolDefinition {
  return {
    name: 'read_compressed_code',
    description:
      'Đọc cấu trúc và nội dung mã nguồn được nén bằng Tree-sitter qua Repomix. ' +
      'Tự động giữ lại các định nghĩa quan trọng (functions, classes, types, interfaces, exports) ' +
      'và lược bỏ thân hàm chi tiết. Giúp tiết kiệm 70% - 85% Token LLM khi khảo sát mã nguồn.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        paths: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Danh sách các đường dẫn tệp tương đối hoặc tuyệt đối cần đọc ở dạng nén (vd: ["src/agent/agent-loop.ts", "src/llm/gemini.ts"]).',
        },
        compress: {
          type: Type.BOOLEAN,
          description: 'Có bật chế độ nén Tree-sitter hay không (mặc định: true).',
        },
      },
      required: ['paths'],
    },
    async execute(args, workspace: Workspace) {
      const filePaths: string[] = Array.isArray(args.paths) ? args.paths : [String(args.paths)];
      const shouldCompress = args.compress !== false;

      if (!filePaths || filePaths.length === 0) {
        return { error: 'Tham số "paths" là bắt buộc và phải chứa ít nhất 1 đường dẫn file.' };
      }

      // Chuẩn hóa đường dẫn tương đối theo workspace root
      const relativePaths = filePaths.map((p) => {
        const resolved = workspace.resolveSafePath(p);
        return path.relative(workspace.rootDir, resolved).replace(/\\/g, '/');
      });

      try {
        const baseConfig = await loadFileConfig(workspace.rootDir, null);
        const config = mergeConfigs(workspace.rootDir, baseConfig, {
          output: {
            filePath: '',
            compress: shouldCompress,
          },
          include: relativePaths,
          ignore: {
            useDefaultPatterns: true,
            customPatterns: ['node_modules/**', '.git/**', 'dist/**', '.codingagent/**'],
          },
        });

        const result = await pack([workspace.rootDir], config);

        const files = (result.processedFiles || []).map((f) => ({
          path: f.path,
          content: f.content,
          tokens: result.fileTokenCounts?.[f.path] ?? null,
        }));

        return {
          totalFiles: result.totalFiles,
          totalTokens: result.totalTokens,
          compressionEnabled: shouldCompress,
          files,
          message: `Đã nén và đọc thành công ${result.totalFiles} tệp với tổng số ước tính ~${result.totalTokens} tokens (Tiết kiệm đáng kể dung lượng context).`,
        };
      } catch (err: any) {
        return {
          error: `Lỗi khi thực thi repomix read_compressed_code: ${err.message}`,
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
      'Đóng gói toàn bộ hoặc một nhóm thư mục/tệp của repository thành bản tóm tắt có nén cấu trúc Tree-sitter để AI nắm bắt toàn cảnh dự án.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        include: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Danh sách glob patterns cần bao gồm (vd: ["src/**/*.ts"]). Nếu để trống sẽ quét toàn bộ repo.',
        },
        compress: {
          type: Type.BOOLEAN,
          description: 'Bật nén cấu trúc Tree-sitter để tiết kiệm Token (mặc định: true).',
        },
      },
    },
    async execute(args, workspace: Workspace) {
      const include = Array.isArray(args.include) && args.include.length > 0 ? args.include : undefined;
      const shouldCompress = args.compress !== false;

      try {
        const baseConfig = await loadFileConfig(workspace.rootDir, null);
        const config = mergeConfigs(workspace.rootDir, baseConfig, {
          output: {
            filePath: '',
            compress: shouldCompress,
          },
          include,
          ignore: {
            useDefaultPatterns: true,
            customPatterns: ['node_modules/**', '.git/**', 'dist/**', '.codingagent/**', '*.lock', 'package-lock.json'],
          },
        });

        const result = await pack([workspace.rootDir], config);

        return {
          totalFiles: result.totalFiles,
          totalTokens: result.totalTokens,
          totalCharacters: result.totalCharacters,
          fileSummary: (result.processedFiles || []).map((f) => ({
            path: f.path,
            tokens: result.fileTokenCounts?.[f.path] ?? null,
          })),
          summary: `Đã đóng gói ${result.totalFiles} tệp (~${result.totalTokens} tokens). Bạn có thể dùng tool "read_compressed_code" để đọc chi tiết các file cụ thể.`,
        };
      } catch (err: any) {
        return {
          error: `Lỗi khi đóng gói codebase: ${err.message}`,
          errorCode: 'REPOMIX_PACK_ERROR',
        };
      }
    },
  };
}
