import { ToolProvider } from './registry.js';
import { Workspace } from '../workspace/workspace.js';
import type { ToolExecutionContext } from './types.js';
import { cloneJsonStrict, deepFreeze, validateSchemaValue } from './schema-validator.js';
import type { PermissionManager } from '../security/permission-manager.js';
import { enrichMutationResultWithLsp } from '../lsp/mutation-feedback.js';
import { hashAllowedToolSet } from '../control/this-turn-tool-gate.js';

export interface ToolExecutionResult {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
  durationMs: number;
  permission?: {
    status: 'granted' | 'required' | 'denied' | 'error';
    requestId?: string;
  };
}

export interface ToolExecutionGuard {
  check(
    toolName: string,
    args: Record<string, any>,
    workspace: Workspace,
    context?: ToolExecutionContext,
  ): Promise<{ allow: boolean; reason?: string; errorCode?: string }>;
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
  private executionGuard?: ToolExecutionGuard;
  private scopedCallCount = 0;

  constructor(registry: ToolProvider, workspace: Workspace, permissionManager?: PermissionManager, executionGuard?: ToolExecutionGuard) {
    this.registry = registry;
    this.workspace = workspace;
    this.permissionManager = permissionManager;
    this.executionGuard = executionGuard;
  }

  setExecutionGuard(executionGuard?: ToolExecutionGuard): void {
    this.executionGuard = executionGuard;
  }

  setPermissionManager(permissionManager: PermissionManager): void {
    this.permissionManager = permissionManager;
  }

  getPermissionManager(): PermissionManager | undefined {
    return this.permissionManager;
  }

  createScoped(provider: ToolProvider): ToolRunner {
    return new ToolRunner(provider, this.workspace, this.permissionManager, this.executionGuard);
  }

  async run(
    toolName: string,
    args: Record<string, any>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let executionContext = context;
    let permissionMetadata: ToolExecutionResult['permission'];

    // Stage 0: bind runtime authority to the exact tool set shown to the model.
    if (context?.allowedToolNames || context?.allowedToolSetHash) {
      const names = context.allowedToolNames || [];
      if (!context.decisionId || !context.allowedToolSetHash || hashAllowedToolSet(names) !== context.allowedToolSetHash) {
        return {
          toolName,
          args,
          result: { error: 'The per-turn tool authorization binding is missing or invalid.', errorCode: 'INVALID_TOOL_DECISION_BINDING' },
          durationMs: Date.now() - startTime,
        };
      }
      if (!names.includes(toolName)) {
        return {
          toolName,
          args,
          result: { error: `Tool "${toolName}" is not authorized by decision ${context.decisionId}.`, errorCode: 'TOOL_NOT_ALLOWED_THIS_TURN' },
          durationMs: Date.now() - startTime,
        };
      }
      if (context.maxToolCalls !== undefined && this.scopedCallCount >= context.maxToolCalls) {
        return {
          toolName,
          args,
          result: { error: `Per-turn tool call budget (${context.maxToolCalls}) exhausted.`, errorCode: 'TOOL_CALL_BUDGET_EXHAUSTED' },
          durationMs: Date.now() - startTime,
        };
      }
      this.scopedCallCount++;
    }

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

    // Stage 3.25: durable orchestration policy (for example Compose spec/worktree gates).
    if (this.executionGuard) {
      const decision = await this.executionGuard.check(toolName, executionArgs, this.workspace, context);
      if (!decision.allow) {
        return {
          toolName,
          args: executionArgs,
          result: {
            error: decision.reason || 'Tool execution was rejected by the active orchestration policy.',
            errorCode: decision.errorCode || 'EXECUTION_GUARD_REJECTED',
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
          permission: {
            status: permCheck.errorCode === 'APPROVAL_REQUIRED'
              ? 'required'
              : permCheck.errorCode === 'PERMISSION_ERROR' ? 'error' : 'denied',
            ...(permCheck.permissionRequestId ? { requestId: permCheck.permissionRequestId } : {}),
          },
        };
      }
      if (permCheck.permissionGranted) {
        permissionMetadata = {
          status: 'granted',
          ...(permCheck.permissionRequestId ? { requestId: permCheck.permissionRequestId } : {}),
        };
        executionContext = {
          ...context,
          permissionGranted: true,
          ...(permCheck.permissionRequestId ? { permissionRequestId: permCheck.permissionRequestId } : {}),
        };
      }
    }

    // Stage 4: Safe Execution
    try {
      const rawResult = await tool.execute(executionArgs, this.workspace, executionContext);
      
      // Stage 5: Output Normalization
      let normalizedResult = typeof rawResult === 'object' && rawResult !== null
        ? rawResult
        : { output: String(rawResult) };
      normalizedResult = await enrichMutationResultWithLsp(toolName, executionArgs, normalizedResult, this.workspace);

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
        ...(permissionMetadata ? { permission: permissionMetadata } : {}),
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
