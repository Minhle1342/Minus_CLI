import { ToolProvider } from './registry.js';
import { Workspace } from '../workspace/workspace.js';
import type { ToolExecutionContext } from './types.js';
import { cloneJsonStrict, deepFreeze, validateSchemaValue } from './schema-validator.js';
import type { PermissionManager } from '../security/permission-manager.js';

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
 *    3.5. Permission & Approval Gate: Phê duyệt của người dùng trước khi sửa file / chạy lệnh nhạy cảm
 * 4. Safe Execution: Thực thi hàm trong khối try/catch an toàn
 * 5. Output Normalization: Chuẩn hoá kết quả trả về dưới dạng JSON thô cho Session/LLM
 */
export class ToolRunner {
  private registry: ToolProvider;
  private workspace: Workspace;
  private permissionManager?: PermissionManager;

  constructor(registry: ToolProvider, workspace: Workspace, permissionManager?: PermissionManager) {
    this.registry = registry;
    this.workspace = workspace;
    this.permissionManager = permissionManager;
  }

  setPermissionManager(permissionManager: PermissionManager): void {
    this.permissionManager = permissionManager;
  }

  getPermissionManager(): PermissionManager | undefined {
    return this.permissionManager;
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

    // Stage 2: lossless JSON snapshot + recursive schema validation.
    let executionArgs: Record<string, any>;
    try {
      executionArgs = deepFreeze(cloneJsonStrict(args || {}, `Arguments for ${toolName}`));
    } catch (error: any) {
      return {
        toolName,
        args,
        result: { error: error.message, errorCode: 'INVALID_ARGS' },
        durationMs: Date.now() - startTime,
      };
    }
    const validation = validateSchemaValue(executionArgs, tool.parameters as any, '$', {
      rejectUnknownProperties: true,
    });
    if (!validation.valid) {
      return {
        toolName,
        args: executionArgs,
        result: {
          error: `Invalid arguments for tool "${toolName}": ${validation.errors.join('; ')}`,
          errorCode: 'INVALID_ARGS',
          validationErrors: validation.errors,
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Stage 3: Workspace & Safety Policy Check
    if (executionArgs.path) {
      const rawPath = String(executionArgs.path);
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

    // Stage 3.5: Permission & Interactive Operator Approval Check
    if (this.permissionManager) {
      const permCheck = await this.permissionManager.checkPermission(toolName, executionArgs, context);
      if (!permCheck.allowed) {
        const errorResult: Record<string, any> = {
          error: permCheck.reason || 'Thao tác bị từ chối do chưa được người dùng cấp quyền.',
          errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
        };
        if (permCheck.recommendedTool) {
          errorResult.recommendedTool = permCheck.recommendedTool;
        }
        if (permCheck.recommendedArgs) {
          errorResult.recommendedArgs = permCheck.recommendedArgs;
        }
        return {
          toolName,
          args: executionArgs,
          result: errorResult,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // Stage 4: Safe Execution
    try {
      const rawResult = await tool.execute(executionArgs, this.workspace, context);
      
      // Stage 5: Output Normalization
      const normalizedResult = typeof rawResult === 'object' && rawResult !== null
        ? rawResult
        : { output: String(rawResult) };

      let resultSnapshot: Record<string, any>;
      try {
        resultSnapshot = cloneJsonStrict(normalizedResult, `Result for ${toolName}`, {
          omitUndefinedObjectProperties: true,
        });
      } catch (error: any) {
        return {
          toolName,
          args: executionArgs,
          result: { error: error.message, errorCode: 'INVALID_TOOL_RESULT' },
          durationMs: Date.now() - startTime,
        };
      }
      const outputValidation = validateSchemaValue(resultSnapshot, tool.outputSchema as any, '$', {
        rejectUnknownProperties: true,
      });
      if (!outputValidation.valid) {
        return {
          toolName,
          args: executionArgs,
          result: {
            error: `Tool "${toolName}" returned an invalid result: ${outputValidation.errors.join('; ')}`,
            errorCode: 'INVALID_TOOL_RESULT',
            validationErrors: outputValidation.errors,
          },
          durationMs: Date.now() - startTime,
        };
      }

      return {
        toolName,
        args: executionArgs,
        result: deepFreeze(resultSnapshot),
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
