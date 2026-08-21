import { ToolProvider } from './registry.js';
import { Workspace } from '../workspace/workspace.js';
import type { ToolExecutionContext } from './types.js';

export interface ToolExecutionResult {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
  durationMs: number;
}

/**
 * ToolRunner thực hiện quy trình 5 giai đoạn (5-stage Tool Execution Pipeline):
 * 
 * 1. Tool Lookup: Tìm kiếm tool trong ToolRegistry (Xử lý UNKNOWN_TOOL)
 * 2. Input Validation: Kiểm tra các tham số bắt buộc theo Schema (Xử lý INVALID_ARGS)
 * 3. Security Policy: Rà soát ranh giới workspace & file bảo vệ (Xử lý SECURITY_VIOLATION)
 * 4. Safe Execution: Thực thi hàm trong khối try/catch an toàn
 * 5. Output Normalization: Chuẩn hoá kết quả trả về dưới dạng JSON thô cho Session/LLM
 */
export class ToolRunner {
  private registry: ToolProvider;
  private workspace: Workspace;

  constructor(registry: ToolProvider, workspace: Workspace) {
    this.registry = registry;
    this.workspace = workspace;
  }

  async run(
    toolName: string,
    args: Record<string, any>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    // Stage 1: Tool Lookup
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        toolName,
        args,
        result: {
          error: `Tool "${toolName}" không tồn tại. Các tool có sẵn: ${this.registry.getAll().map(t => t.name).join(', ')}`,
          errorCode: 'UNKNOWN_TOOL',
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Stage 2: Input Validation (Kiểm tra tham số required theo parameters schema)
    const requiredParams = (tool.parameters as any)?.required || [];
    for (const param of requiredParams) {
      if (args[param] === undefined || args[param] === null || args[param] === '') {
        return {
          toolName,
          args,
          result: {
            error: `Tham số bắt buộc "${param}" bị thiếu khi gọi tool "${toolName}".`,
            errorCode: 'INVALID_ARGS',
          },
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Stage 3: Workspace & Safety Policy Check
    if (args.path) {
      const rawPath = String(args.path);
      try {
        this.workspace.resolveSafePath(rawPath);
      } catch (err: any) {
        return {
          toolName,
          args,
          result: {
            error: err.message,
            errorCode: 'SECURITY_VIOLATION',
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Nếu tool là thao tác ghi/sửa, kiểm tra xem file có thuộc danh sách bảo vệ không
      if (['replace_text', 'write_file'].includes(toolName) && this.workspace.isProtectedFile(rawPath)) {
        return {
          toolName,
          args,
          result: {
            error: `Bảo mật: Không được phép chỉnh sửa hoặc ghi đè file cấu hình nhạy cảm "${rawPath}".`,
            errorCode: 'SECURITY_VIOLATION',
          },
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Stage 4: Safe Execution
    try {
      const rawResult = await tool.execute(args, this.workspace, context);
      
      // Stage 5: Output Normalization
      const normalizedResult = typeof rawResult === 'object' && rawResult !== null
        ? rawResult
        : { output: String(rawResult) };

      return {
        toolName,
        args,
        result: normalizedResult,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        toolName,
        args,
        result: {
          error: `Lỗi khi thực thi tool "${toolName}": ${err.message}`,
          errorCode: 'EXECUTION_ERROR',
        },
        durationMs: Date.now() - startTime,
      };
    }
  }
}
