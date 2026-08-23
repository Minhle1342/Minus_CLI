import type { ToolExecutionContext } from '../tools/types.js';
import { detectFileCommandMisuse, type FileMisuseDetection } from '../tools/run-command.js';

export type PermissionMode = 'always_ask' | 'ask_sensitive' | 'auto_approve' | 'read_only';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface PermissionRequest {
  id: string;
  toolName: string;
  category: 'file_edit' | 'file_write' | 'command_execution' | 'destructive' | 'git_mutation' | 'general';
  target: string;
  summary: string;
  riskLevel: RiskLevel;
  details?: Record<string, any>;
  timestamp: string;
}

export type PermissionPromptHandler = (
  request: PermissionRequest
) => Promise<'approve' | 'reject' | 'approve_all_session'>;

/**
 * PermissionManager - Quản lý phân quyền và phê duyệt tương tác (Interactive Approval Gate)
 * 
 * Bảo vệ người dùng trước:
 * 1. Chỉnh sửa / ghi đè file ngoài ý muốn (replace_text, write_file)
 * 2. Lệnh terminal nguy hiểm hoặc nhạy cảm (rm, del, kill, npm -g, deploy, network)
 * 3. Lệnh đọc/duyệt file qua shell: Đưa qua kiểm duyệt, nếu Reject -> Tự động đề xuất tool chuyên dụng
 * 4. Thao tác Git ảnh hưởng mã nguồn (git push, git reset --hard)
 */
export class PermissionManager {
  private mode: PermissionMode;
  private promptHandler?: PermissionPromptHandler;
  private sessionApprovedCategories = new Set<string>();
  private requestHistory: PermissionRequest[] = [];

  constructor(mode: PermissionMode = 'ask_sensitive') {
    this.mode = mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setPromptHandler(handler: PermissionPromptHandler): void {
    this.promptHandler = handler;
  }

  clearSessionApprovals(): void {
    this.sessionApprovedCategories.clear();
  }

  /**
   * Đánh giá và kiểm tra quyền trước khi thực thi tool
   */
  async checkPermission(
    toolName: string,
    args: Record<string, any>,
    context?: ToolExecutionContext,
  ): Promise<{
    allowed: boolean;
    reason?: string;
    errorCode?: string;
    recommendedTool?: string;
    recommendedArgs?: Record<string, any>;
  }> {
    // 1. Chế độ Auto-Approve (Tự động duyệt tất cả)
    if (this.mode === 'auto_approve') {
      return { allowed: true };
    }

    // 2. Chế độ Read-Only (Chỉ cho phép đọc, cấm mọi thao tác ghi / chạy lệnh)
    if (this.mode === 'read_only') {
      if (['replace_text', 'apply_patch', 'write_file', 'run_command', 'git_commit', 'git_push'].includes(toolName)) {
        return {
          allowed: false,
          errorCode: 'PERMISSION_DENIED',
          reason: `Chế độ Read-Only đang bật: Không được phép thực thi tool thay đổi trạng thái "${toolName}".`,
        };
      }
      return { allowed: true };
    }

    // Phân loại rủi ro của Tool Call
    const request = this.classifyToolCall(toolName, args);
    this.requestHistory.push(request);

    // Nếu rủi ro LOW và ở chế độ ask_sensitive -> Cho phép tự động
    if (this.mode === 'ask_sensitive' && request.riskLevel === 'LOW') {
      return { allowed: true };
    }

    // Nếu người dùng đã chọn "Luôn đồng ý danh mục này trong phiên"
    if (this.sessionApprovedCategories.has(request.category)) {
      return { allowed: true };
    }

    // Nếu không có Prompt Handler (môi trường non-interactive / headless CI)
    if (!this.promptHandler) {
      if (request.riskLevel === 'CRITICAL') {
        return {
          allowed: false,
          errorCode: 'APPROVAL_REQUIRED',
          reason: `Lệnh "${request.target}" có mức độ rủi ro CRITICAL và yêu cầu người dùng phê duyệt trực tiếp.`,
        };
      }
      return { allowed: true };
    }

    // Hỏi ý kiến người dùng qua Interactive Prompt Handler
    try {
      const decision = await this.promptHandler(request);

      if (decision === 'approve') {
        return { allowed: true };
      }

      if (decision === 'approve_all_session') {
        this.sessionApprovedCategories.add(request.category);
        return { allowed: true };
      }

      // Khi người dùng từ chối (reject):
      // Nếu là lệnh shell đọc/duyệt file (misuse) -> Tự động đề xuất tool chuyên dụng để chuyển hướng LLM
      const misuse = request.details?.misuse as FileMisuseDetection | undefined;
      if (misuse) {
        return {
          allowed: false,
          errorCode: 'PERMISSION_DENIED',
          reason: `Người dùng đã từ chối thực thi lệnh shell "${request.target}". Vui lòng chuyển sang sử dụng tool chuyên dụng được khuyến nghị: "${misuse.tool}" (${misuse.reason}).`,
          recommendedTool: misuse.tool,
          recommendedArgs: misuse.suggestedArgs,
        };
      }

      return {
        allowed: false,
        errorCode: 'PERMISSION_DENIED',
        reason: `Người dùng đã từ chối thao tác "${request.summary}" (${request.toolName}: ${request.target}).`,
      };
    } catch (err: any) {
      return {
        allowed: false,
        errorCode: 'PERMISSION_ERROR',
        reason: `Lỗi khi xử lý phê duyệt quyền: ${err.message}`,
      };
    }
  }

  private classifyToolCall(toolName: string, args: Record<string, any>): PermissionRequest {
    const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();

    if (toolName === 'apply_patch') {
      const target = String(args.path || 'unified patch');
      return {
        id,
        toolName,
        category: 'file_edit',
        target,
        summary: `Áp dụng Unified Patch lên mã nguồn (${target})`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'replace_text') {
      const target = String(args.path || 'unknown file');
      return {
        id,
        toolName,
        category: 'file_edit',
        target,
        summary: `Chỉnh sửa mã nguồn trong file "${target}"`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'write_file') {
      const target = String(args.path || 'unknown file');
      const isCritical = target.includes('package.json') || target.includes('.env') || target.includes('tsconfig');
      return {
        id,
        toolName,
        category: 'file_write',
        target,
        summary: `Tạo mới hoặc ghi đè file "${target}"`,
        riskLevel: isCritical ? 'HIGH' : 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'run_command') {
      const cmd = String(args.command || '').trim();
      const lower = cmd.toLowerCase();

      // 1. Phân loại lệnh nguy hiểm (Destructive) -> CRITICAL
      if (/\b(rm\s+-rf|del\s+\/f|rmdir\s+\/s|Remove-Item|erase|format|mkfs|dd|kill|taskkill|shutdown)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'destructive',
          target: cmd,
          summary: `Thực thi lệnh xóa/hệ thống nguy hiểm: "${cmd}"`,
          riskLevel: 'CRITICAL',
          details: args,
          timestamp,
        };
      }

      // 2. Phân loại lệnh cài đặt / mạng / quyền hệ thống -> HIGH
      if (/\b(npm\s+(?:i|install)\s+-g|pip\s+install|chmod|chown|sudo|curl\s+.*\|\s*bash)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Thực thi lệnh cấu hình / cài đặt: "${cmd}"`,
          riskLevel: 'HIGH',
          details: args,
          timestamp,
        };
      }

      // 3. Khám phá Codebase / Đọc file / Tìm kiếm (Terminal-First Codex Standard) -> LOW
      if (/^(?:cat|type|get-content|gc|head|tail|more|less|ls|dir|tree|get-childitem|gci|grep|rg|ripgrep|findstr|select-string|sls|find|fd|wc|which|where|pwd|echo|printf|node\s+-v|npm\s+-v|git\s+status|git\s+diff|git\s+log|env|printenv)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Khám phá codebase / đọc dữ liệu terminal: "${cmd}"`,
          riskLevel: 'LOW',
          details: args,
          timestamp,
        };
      }

      // 4. Lệnh build / test an toàn -> LOW
      if (/\b(npm\s+test|npm\s+run\s+build|npx\s+tsc|node\s+-v|dotnet\s+test|pytest|cargo\s+test)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Chạy lệnh kiểm thử / build: "${cmd}"`,
          riskLevel: 'LOW',
          details: args,
          timestamp,
        };
      }

      return {
        id,
        toolName,
        category: 'command_execution',
        target: cmd,
        summary: `Chạy lệnh terminal: "${cmd}"`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName.startsWith('git_')) {
      const isPushOrReset = toolName === 'git_push' || toolName === 'git_reset' || String(args.subcommand || '').includes('push') || String(args.subcommand || '').includes('reset');
      return {
        id,
        toolName,
        category: 'git_mutation',
        target: toolName,
        summary: `Thao tác Git: ${toolName}`,
        riskLevel: isPushOrReset ? 'HIGH' : 'LOW',
        details: args,
        timestamp,
      };
    }

    return {
      id,
      toolName,
      category: 'general',
      target: toolName,
      summary: `Thực thi tool ${toolName}`,
      riskLevel: 'LOW',
      details: args,
      timestamp,
    };
  }
}