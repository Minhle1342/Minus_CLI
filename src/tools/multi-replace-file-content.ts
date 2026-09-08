import fs from 'node:fs/promises';
import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { computeStringHash } from '../workspace/workspace-digest.js';
import { toolError, toolSuccess } from './tool-result.js';
import { CodeSyntaxValidator } from '../workspace/syntax-diagnostics.js';
import {
  detectChangedSymbols,
  calculateComprehensiveBlastRadius,
  invalidateTopologyCache,
} from './mutation-blast-radius.js';

export interface ReplacementChunkInput {
  StartLine: number;
  EndLine: number;
  TargetContent: string;
  ReplacementContent: string;
  AllowMultiple: boolean;
}

/**
 * multi_replace_file_content Tool (Antigravity & Claude-Code Standard)
 * 
 * Thực hiện nhiều khối chỉnh sửa không liền kề (MULTIPLE, NON-CONTIGUOUS edits)
 * trên cùng một file trong một lần gọi nguyên tử (atomic edit).
 */
export const multiReplaceFileContentTool: ToolDefinition = {
  name: 'multi_replace_file_content',
  description: 'Thực hiện nhiều khối chỉnh sửa không liền kề (MULTIPLE, NON-CONTIGUOUS edits) trên cùng một file trong một lần gọi nguyên tử (atomic edit). Nhận danh sách ReplacementChunks, thẩm định tất cả các chunk trước khi ghi đĩa và áp dụng theo thứ tự từ dưới lên trên (bottom-up) để bảo toàn tuyệt đối chỉ số dòng. Tự động xử lý LF/CRLF và phân tích Blast Radius.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: {
        type: Type.STRING,
        description: 'Đường dẫn tuyệt đối hoặc tương đối tới file cần sửa đổi (ví dụ: "src/index.ts")',
      },
      Instruction: {
        type: Type.STRING,
        description: 'Mô tả tổng quát về tập hợp các thay đổi đang thực hiện trên file.',
      },
      Description: {
        type: Type.STRING,
        description: 'Giải thích lý do thay đổi và bối cảnh kỹ thuật cho người dùng.',
      },
      ReplacementChunks: {
        type: Type.ARRAY,
        description: 'Danh sách các khối thay thế cần thực hiện. Mỗi khối chỉ định phạm vi dòng và nội dung thay thế.',
        items: {
          type: Type.OBJECT,
          properties: {
            StartLine: {
              type: Type.INTEGER,
              description: 'Chỉ số dòng bắt đầu của chunk (1-indexed, inclusive).',
            },
            EndLine: {
              type: Type.INTEGER,
              description: 'Chỉ số dòng kết thúc của chunk (1-indexed, inclusive).',
            },
            TargetContent: {
              type: Type.STRING,
              description: 'Đoạn văn bản/mã nguồn chính xác cần thay thế.',
            },
            ReplacementContent: {
              type: Type.STRING,
              description: 'Nội dung mới thay thế cho TargetContent.',
            },
            AllowMultiple: {
              type: Type.BOOLEAN,
              description: 'Nếu true, cho phép thay thế nhiều lần nếu TargetContent xuất hiện nhiều lần trong phạm vi dòng của chunk.',
            },
          },
          required: [
            'StartLine',
            'EndLine',
            'TargetContent',
            'ReplacementContent',
            'AllowMultiple',
          ],
        },
      },
      ArtifactMetadata: {
        type: Type.OBJECT,
        description: 'Metadata tùy chọn nếu file được chỉnh sửa là một artifact.',
        properties: {
          Summary: { type: Type.STRING, description: 'Tóm tắt nội dung sau khi cập nhật' },
          UserFacing: { type: Type.BOOLEAN, description: 'True nếu hiển thị cho người dùng' },
          RequestFeedback: { type: Type.BOOLEAN, description: 'True nếu yêu cầu xác nhận' },
        },
      },
      TargetLintErrorIds: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Danh sách tùy chọn các mã lỗi lint mà thay đổi này nhằm giải quyết.',
      },
    },
    required: [
      'TargetFile',
      'Instruction',
      'Description',
      'ReplacementChunks',
    ],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const rawPath = String(args.TargetFile || args.targetFile || args.path || args.filePath || '').trim();
    const rawChunks = Array.isArray(args.ReplacementChunks || args.replacementChunks)
      ? (args.ReplacementChunks || args.replacementChunks)
      : [];

    if (!rawPath) {
      return toolError('Tham số "TargetFile" là bắt buộc.', 'INVALID_ARGS');
    }
    if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
      return toolError('Tham số "ReplacementChunks" phải là một mảng chứa ít nhất một khối thay thế.', 'INVALID_ARGS');
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);

      if (workspace.isProtectedFile(safePath)) {
        return toolError(
          `Bảo mật: Không được phép chỉnh sửa file cấu hình nhạy cảm "${rawPath}".`,
          'SECURITY_VIOLATION',
        );
      }

      let stat;
      try {
        stat = await fs.stat(safePath);
      } catch {
        return toolError(`File "${rawPath}" không tồn tại trên đĩa.`, 'FILE_NOT_FOUND', { TargetFile: rawPath });
      }

      if (!stat.isFile()) {
        return toolError(`"${rawPath}" không phải là file hợp lệ.`, 'INVALID_ARGS', { TargetFile: rawPath });
      }

      const originalRawContent = await fs.readFile(safePath, 'utf-8');
      const isCRLF = originalRawContent.includes('\r\n');
      const normalizedOriginal = originalRawContent.replace(/\r\n/g, '\n');

      // Chuẩn hoá các chunk đầu vào
      const chunks: ReplacementChunkInput[] = rawChunks.map((c: any) => ({
        StartLine: typeof c.StartLine === 'number' ? c.StartLine : typeof c.startLine === 'number' ? c.startLine : 1,
        EndLine: typeof c.EndLine === 'number' ? c.EndLine : typeof c.endLine === 'number' ? c.endLine : Infinity,
        TargetContent: String(c.TargetContent ?? c.targetContent ?? ''),
        ReplacementContent: String(c.ReplacementContent ?? c.replacementContent ?? ''),
        AllowMultiple: c.AllowMultiple === true || c.allowMultiple === true,
      }));

      // 1. Kiểm tra tính hợp lệ cơ bản của các chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.TargetContent === '') {
          return toolError(`Chunk index ${i} có TargetContent để trống.`, 'INVALID_ARGS', { chunkIndex: i });
        }
        if (chunk.StartLine > chunk.EndLine) {
          return toolError(
            `Chunk index ${i} có StartLine (${chunk.StartLine}) lớn hơn EndLine (${chunk.EndLine}).`,
            'INVALID_ARGS',
            { chunkIndex: i },
          );
        }
      }

      // 2. Sắp xếp chunks theo thứ tự StartLine tăng dần để kiểm tra chồng lấn (overlap)
      const sortedByStart = [...chunks].sort((a, b) => a.StartLine - b.StartLine);
      for (let i = 0; i < sortedByStart.length - 1; i++) {
        const curr = sortedByStart[i];
        const next = sortedByStart[i + 1];
        if (curr.EndLine >= next.StartLine) {
          return toolError(
            `Các chunk thay thế bị chồng lấn phạm vi dòng: chunk [${curr.StartLine}, ${curr.EndLine}] và chunk [${next.StartLine}, ${next.EndLine}]. Mỗi chunk phải nằm ở phạm vi dòng tách biệt.`,
            'INVALID_ARGS',
          );
        }
      }

      // 3. Thực hiện thay thế lần lượt theo thứ tự Bottom-Up (từ dòng lớn nhất xuống nhỏ nhất)
      // Cách làm này đảm bảo các thay đổi bên dưới không làm lệch số dòng của các chunk bên trên!
      const sortedBottomUp = [...chunks].sort((a, b) => b.StartLine - a.StartLine);
      let currentContent = normalizedOriginal;
      let totalChunksApplied = 0;

      for (let idx = 0; idx < sortedBottomUp.length; idx++) {
        const chunk = sortedBottomUp[idx];
        const normalizedTarget = chunk.TargetContent.replace(/\r\n/g, '\n');
        const normalizedReplacement = chunk.ReplacementContent.replace(/\r\n/g, '\n');

        const lines = currentContent.split('\n');
        const totalLines = lines.length;

        const clampedStart = Math.max(0, Math.min(chunk.StartLine - 1, totalLines - 1));
        const clampedEnd = Math.max(clampedStart, Math.min(chunk.EndLine, totalLines));

        const rangeLines = lines.slice(clampedStart, clampedEnd);
        const rangeText = rangeLines.join('\n');

        if (rangeText.includes(normalizedTarget)) {
          const occurrences = rangeText.split(normalizedTarget).length - 1;
          if (occurrences > 1 && !chunk.AllowMultiple) {
            return toolError(
              `Chunk dòng [${chunk.StartLine}, ${chunk.EndLine}]: TargetContent xuất hiện ${occurrences} lần và AllowMultiple=false.`,
              'AMBIGUOUS_REPLACEMENT',
              { chunk },
            );
          }

          const replacedRangeText = chunk.AllowMultiple
            ? rangeText.replaceAll(normalizedTarget, normalizedReplacement)
            : rangeText.replace(normalizedTarget, normalizedReplacement);

          const beforeRange = lines.slice(0, clampedStart).join('\n');
          const afterRange = lines.slice(clampedEnd).join('\n');

          const parts = [];
          if (clampedStart > 0) parts.push(beforeRange);
          parts.push(replacedRangeText);
          if (clampedEnd < totalLines) parts.push(afterRange);

          currentContent = parts.join('\n');
          totalChunksApplied++;
        } else if (currentContent.includes(normalizedTarget)) {
          // Fallback nếu target content nằm ở vị trí duy nhất trong file
          const totalOccurrences = currentContent.split(normalizedTarget).length - 1;
          if (totalOccurrences > 1 && !chunk.AllowMultiple) {
            return toolError(
              `Chunk dòng [${chunk.StartLine}, ${chunk.EndLine}]: TargetContent không nằm đúng phạm vi dòng nhưng xuất hiện ${totalOccurrences} lần trong file.`,
              'AMBIGUOUS_REPLACEMENT',
              { chunk },
            );
          }

          currentContent = chunk.AllowMultiple
            ? currentContent.replaceAll(normalizedTarget, normalizedReplacement)
            : currentContent.replace(normalizedTarget, normalizedReplacement);

          totalChunksApplied++;
        } else {
          return toolError(
            `Chunk dòng [${chunk.StartLine}, ${chunk.EndLine}]: Không tìm thấy TargetContent trong file "${rawPath}". Hãy kiểm tra lại nội dung và thụt lề dòng.`,
            'PATCH_ERROR',
            { chunk },
          );
        }
      }

      // Khôi phục kiểu ngắt dòng
      const finalContent = isCRLF ? currentContent.replace(/\n/g, '\r\n') : currentContent;

      await fs.writeFile(safePath, finalContent, 'utf-8');
      invalidateTopologyCache();

      let blastRadiusSummary: any;
      try {
        const modifiedSymbols = detectChangedSymbols(rawPath, originalRawContent, finalContent);
        const blast = calculateComprehensiveBlastRadius({
          workspace,
          filePath: rawPath,
          modifiedSymbols,
          depth: 2,
        });
        blastRadiusSummary = {
          risk: blast.risk,
          score: blast.score,
          depth: blast.depth,
          modifiedSymbols: blast.modifiedSymbols.map((s) => s.name),
          directConsumers: blast.directConsumers,
          transitiveFiles: blast.transitiveFiles,
          impactedTestSuites: blast.impactedTestSuites,
          callersCount: blast.callers.length,
          publicApiAffected: blast.publicApiAffected,
          breakingChange: blast.breakingChange,
          warnings: blast.warnings,
          recommendedActions: blast.recommendedActions,
        };
      } catch {}

      const contentHash = computeStringHash(finalContent);

      let diagnosticWarning: string | undefined;
      let syntaxErrors: any[] | undefined;
      try {
        const diags = await CodeSyntaxValidator.validateFile(rawPath, workspace);
        if (diags.length > 0) {
          syntaxErrors = diags;
          diagnosticWarning = `⚠️ LINTER ALERT (${diags.length} unresolved syntax / missing import issue(s)):\n` +
            diags.map((d) => `  • Line ${d.line}: ${d.message}`).join('\n') +
            `\n👉 ACTION REQUIRED: Fix the syntax errors or missing imports in "${rawPath}".`;
        }
      } catch {}

      return toolSuccess({
        path: workspace.toRelativePath(safePath),
        TargetFile: workspace.toRelativePath(safePath),
        chunksApplied: totalChunksApplied,
        contentHash,
        message: `Đã áp dụng thành công ${totalChunksApplied}/${chunks.length} khối chỉnh sửa vào file "${rawPath}".`,
        ...(blastRadiusSummary ? { blastRadius: blastRadiusSummary } : {}),
        ...(diagnosticWarning ? { diagnosticWarning, syntaxErrors } : {}),
      });
    } catch (err: any) {
      return toolError(`Lỗi khi áp dụng nhiều khối thay thế: ${err.message}`, 'EXECUTION_ERROR', { TargetFile: rawPath });
    }
  },
};
