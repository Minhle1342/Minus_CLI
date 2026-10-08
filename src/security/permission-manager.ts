import type { ToolExecutionContext } from '../tools/types.js';
import { detectFileCommandMisuse, type FileMisuseDetection } from '../tools/run-command.js';
import { analyzeShellCommand } from './shell-segmenter.js';
import { isMutationTool, generateFileToolDiff } from '../tools/diff-generator.js';
import { CLI } from '../ui/cli-ui.js';
import { ToolDescriptorRegistry } from '../control/tool-descriptor-registry.js';
import { SandboxPolicyEngine } from '../sandbox/sandbox-policy.js';

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
  diff?: string;
}

export type PermissionPromptHandler = (
  request: PermissionRequest
) => Promise<'approve' | 'reject' | 'approve_all_session'>;

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  errorCode?: string;
  recommendedTool?: string;
  recommendedArgs?: Record<string, any>;
  permissionGranted?: boolean;
  permissionRequestId?: string;
  /** True when a human explicitly denied via the prompt ([n]/Esc/Ctrl+C). */
  deniedByUser?: boolean;
}

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
  /** Item 9: per-category command prefixes approved via approve_all_session (run_command only). */
  private sessionApprovedPrefixes = new Map<string, Set<string>>();
  private requestHistory: PermissionRequest[] = [];
  private workspaceRoot?: string;

  constructor(mode: PermissionMode = 'ask_sensitive') {
    this.mode = mode;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
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

  /**
   * F3: True when a user-facing prompt handler is attached (interactive session).
   * Tool suggestions use this to avoid dead-end "ask the user" advice when no
   * approval can ever arrive (headless/CI runs deny permission requests).
   */
  hasApprovalChannel(): boolean {
    return typeof this.promptHandler === 'function';
  }

  clearSessionApprovals(): void {
    this.sessionApprovedCategories.clear();
    this.sessionApprovedPrefixes.clear();
  }

  /** Raw command text behind a run_command permission request. */
  private commandTextForApproval(request: PermissionRequest): string {
    const details = (request.details || {}) as Record<string, any>;
    return String(
      details.command || details.CommandLine || details.commandLine || details.cmd || request.target || '',
    );
  }

  /** First token of every shell segment (e.g. npm, git, pytest) for prefix-scoped approvals. */
  private commandPrefixesForApproval(command: string): string[] {
    const text = command.trim();
    if (!text || text === '(empty command)') return [];
    try {
      const segments = analyzeShellCommand(text).segments;
      const sources = segments.length > 0 ? segments : [text];
      const prefixes = sources
        .map((segment) => segment.trim().split(/\s+/)[0]?.toLowerCase() || '')
        .filter(Boolean);
      return [...new Set(prefixes)];
    } catch {
      const first = text.split(/\s+/)[0]?.toLowerCase();
      return first ? [first] : [];
    }
  }

  /** True when every segment prefix of a run_command was session-approved. */
  private isSessionPrefixApproved(request: PermissionRequest): boolean {
    const prefixes = this.commandPrefixesForApproval(this.commandTextForApproval(request));
    const allowed = this.sessionApprovedPrefixes.get(request.category);
    return prefixes.length > 0 && !!allowed && prefixes.every((prefix) => allowed.has(prefix));
  }

  /**
   * Đánh giá và kiểm tra quyền trước khi thực thi tool
   */
  async checkPermission(
    toolName: string,
    args: Record<string, any>,
    context?: ToolExecutionContext,
  ): Promise<PermissionCheckResult> {
    // 2. Chế độ Read-Only (Chỉ cho phép đọc, cấm mọi thao tác ghi / chạy lệnh)
    if (this.mode === 'read_only') {
      const descriptor = new ToolDescriptorRegistry().describe({ name: toolName, description: '', parameters: {}, execute: async () => ({}) });
      const command = String(args.command || args.CommandLine || args.commandLine || args.cmd || args.rawCommand || args.script || '');
      const safeCommand = toolName === 'run_command'
        && new SandboxPolicyEngine(this.workspaceRoot || process.cwd(), 'strict').evaluateCommand(command, args.cwd).allowed;
      if ((toolName === 'run_command' && !safeCommand) || toolName === 'run_test_suite' || descriptor.mutates) {
        return {
          allowed: false,
          errorCode: 'PERMISSION_DENIED',
          reason: `Read-Only mode is on: state-changing tool "${toolName}" is not allowed.`,
        };
      }
      return { allowed: true };
    }

    // Phân loại rủi ro của Tool Call
    const request = this.classifyToolCall(toolName, args);
    this.requestHistory.push(request);

    // Sinh Diff View xem trước nếu là tool sửa/thao tác file
    if (isMutationTool(toolName)) {
      try {
        request.diff = await generateFileToolDiff(toolName, args, this.workspaceRoot);
      } catch {
        request.diff = undefined;
      }
    }

    // 1. Chế độ Auto-Approve (Tự động duyệt tất cả nhưng vẫn in Diff View nếu là tool sửa file)
    if (this.mode === 'auto_approve') {
      if (request.diff && ['file_edit', 'file_write', 'destructive'].includes(request.category)) {
        CLI.renderSessionAutoApprovedDiff(request);
      }
      return { allowed: true, permissionGranted: toolName === 'run_command' };
    }

    // Nếu rủi ro LOW và ở chế độ ask_sensitive -> Cho phép tự động
    if (this.mode === 'ask_sensitive' && request.riskLevel === 'LOW') {
      return { allowed: true };
    }

    // Nếu người dùng đã chọn "Luôn đồng ý danh mục này trong phiên" (approve_all_session):
    // Vẫn hiển thị Diff View trực quan để người dùng theo dõi thay đổi mã nguồn trong thời gian thực!
    // Item 9: run_command approvals are additionally scoped to the approved
    // command prefixes so one approval cannot blanket-authorize every shell command.
    const sessionCategoryApproved = this.sessionApprovedCategories.has(request.category)
      && (toolName !== 'run_command' || this.isSessionPrefixApproved(request));
    if (sessionCategoryApproved) {
      if (request.diff && ['file_edit', 'file_write', 'destructive'].includes(request.category)) {
        CLI.renderSessionAutoApprovedDiff(request);
      }
      return {
        allowed: true,
        permissionGranted: toolName === 'run_command',
        permissionRequestId: request.id,
      };
    }

    // Nếu không có Prompt Handler (môi trường non-interactive / headless CI)
    if (!this.promptHandler) {
      return {
          allowed: false,
          errorCode: 'APPROVAL_REQUIRED',
          permissionRequestId: request.id,
          reason: `Operation "${request.target}" requires direct EXECUTION PERMISSION (MINUS PERMISSION APPROVAL), but no approval channel is available.`,
      };
    }

    // Hỏi ý kiến người dùng qua Interactive Prompt Handler
    try {
      const decision = await this.promptHandler(request);

      if (decision === 'approve') {
        return {
          allowed: true,
          permissionGranted: toolName === 'run_command',
          permissionRequestId: request.id,
        };
      }

      if (decision === 'approve_all_session') {
        this.sessionApprovedCategories.add(request.category);
        if (toolName === 'run_command') {
          let prefixes = this.sessionApprovedPrefixes.get(request.category);
          if (!prefixes) {
            prefixes = new Set<string>();
            this.sessionApprovedPrefixes.set(request.category, prefixes);
          }
          for (const prefix of this.commandPrefixesForApproval(this.commandTextForApproval(request))) {
            prefixes.add(prefix);
          }
        }
        return {
          allowed: true,
          permissionGranted: toolName === 'run_command',
          permissionRequestId: request.id,
        };
      }

      // Khi người dùng từ chối (reject):
      // Nếu là lệnh shell đọc/duyệt file (misuse) -> Tự động đề xuất tool chuyên dụng để chuyển hướng LLM
      const misuse = request.details?.misuse as FileMisuseDetection | undefined;
      if (misuse) {
        return {
          allowed: false,
          errorCode: 'PERMISSION_DENIED',
          permissionRequestId: request.id,
          deniedByUser: true,
          reason: `User rejected shell command "${request.target}". Please switch to the recommended dedicated tool: "${misuse.tool}" (${misuse.reason}).`,
          recommendedTool: misuse.tool,
          recommendedArgs: misuse.suggestedArgs,
        };
      }

      return {
        allowed: false,
        errorCode: 'PERMISSION_DENIED',
        permissionRequestId: request.id,
        deniedByUser: true,
        reason: `User rejected the operation "${request.summary}" (${request.toolName}: ${request.target}).`,
      };
    } catch (err: any) {
      return {
        allowed: false,
        errorCode: 'PERMISSION_ERROR',
        permissionRequestId: request.id,
        reason: `Error while processing permission approval: ${err.message}`,
      };
    }
  }

  private classifyToolCall(toolName: string, args: Record<string, any>): PermissionRequest {
    const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = new Date().toISOString();

    if (toolName === 'apply_patch') {
      let target = (args.path || args.filePath || args.targetFile) ? String(args.path || args.filePath || args.targetFile).trim() : '';
      if (!target && typeof args.patch === 'string') {
        const fileMatches = Array.from(args.patch.matchAll(/^(?:---|\+\+\+)\s+[ab]?\/?([^\s\r\n]+)/gm))
          .map((m: any) => m[1])
          .filter((f: string) => f && f !== '/dev/null' && f !== 'dev/null');
        const uniqueFiles = Array.from(new Set(fileMatches));
        if (uniqueFiles.length === 1) {
          target = uniqueFiles[0];
        } else if (uniqueFiles.length > 1) {
          target = `${uniqueFiles.slice(0, 2).join(', ')}${uniqueFiles.length > 2 ? ` (+${uniqueFiles.length - 2} files)` : ''}`;
        }
      }
      if (!target) {
        target = 'unified patch';
      }
      return {
        id,
        toolName,
        category: 'file_edit',
        target,
        summary: `Apply Unified Patch to source code (${target})`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'replace_text') {
      const target = String(args.path || args.filePath || args.targetFile || 'unknown file');
      return {
        id,
        toolName,
        category: 'file_edit',
        target,
        summary: `Edit source code in file "${target}"`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'write_file') {
      const target = String(args.path || args.filePath || args.targetFile || 'unknown file');
      const isCritical = target.includes('package.json') || target.includes('.env') || target.includes('tsconfig');
      return {
        id,
        toolName,
        category: 'file_write',
        target,
        summary: `Create or overwrite file "${target}"`,
        riskLevel: isCritical ? 'HIGH' : 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'create_file') {
      const target = String(args.path || args.filePath || args.targetFile || 'unknown file');
      return {
        id,
        toolName,
        category: 'file_write',
        target,
        summary: `Create new file "${target}"`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'delete_file') {
      const target = String(args.path || args.filePath || args.targetFile || 'unknown file');
      const reasonSuffix = args.reason ? `: ${args.reason}` : '';
      return {
        id,
        toolName,
        category: 'destructive',
        target,
        summary: `Delete file "${target}" from workspace${reasonSuffix}`,
        riskLevel: 'HIGH',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'move_file') {
      const source = String(args.sourcePath || args.from || 'unknown source');
      const target = String(args.targetPath || args.to || 'unknown target');
      return {
        id,
        toolName,
        category: 'file_edit',
        target: `${source} -> ${target}`,
        summary: `Move / rename file from "${source}" to "${target}"`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName === 'run_command') {
      const cmd = String(
        args.command ||
        args.CommandLine ||
        args.commandLine ||
        args.cmd ||
        args.rawCommand ||
        args.script ||
        ''
      ).trim();
      const lower = cmd.toLowerCase();
      const shellAnalysis = analyzeShellCommand(cmd);
      const misuse = detectFileCommandMisuse(cmd);

      // Nếu không có câu lệnh hợp lệ nào được truyền vào
      if (!cmd) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: '(empty command)',
          summary: 'Execute terminal command (empty or unknown command parameter)',
          riskLevel: 'LOW',
          details: { ...args, shellAnalysis, misuse },
          timestamp,
        };
      }

      // 1. Phân loại lệnh nguy hiểm (Destructive) -> CRITICAL
      if (/\b(rm\s+-rf|del\s+\/f|rmdir\s+\/s|Remove-Item|erase|format|mkfs|dd|kill|taskkill|shutdown)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'destructive',
          target: cmd,
          summary: `Execute dangerous delete/system command: "${cmd}"`,
          riskLevel: 'CRITICAL',
          details: { ...args, shellAnalysis, misuse },
          timestamp,
        };
      }

      // 2. Phân loại lệnh cài đặt / mạng / quyền hệ thống -> HIGH
      if (/\b(npm\s+(?:i|install)(?:\s|$)|pnpm\s+(?:add|install)(?:\s|$)|yarn\s+add(?:\s|$)|pip\s+install|chmod|chown|sudo|curl\s+.*\|\s*bash)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Execute config / install command: "${cmd}"`,
          riskLevel: 'HIGH',
          details: { ...args, shellAnalysis, misuse },
          timestamp,
        };
      }

      const safeSegment = /^(?:cat|type|get-content|gc|head|tail|more|less|ls|dir|tree|get-childitem|gci|grep|rg|ripgrep|findstr|select-string|sls|find|fd|wc|which|where|pwd|echo|printf|node\s+-v|npm\s+-v|git\s+(?:status|diff|log)|env|printenv|sed\s+-n|awk|npm\s+test|npm\s+run\s+(?:build|test|lint|typecheck)|npx\s+tsc|dotnet\s+test|pytest|cargo\s+test|ctest|(?:\.?[\/\\])?(?:bin|target|build|x64|x86)[\/\\](?:debug|release)[\/\\][a-zA-Z0-9_.-]*test[a-zA-Z0-9_.-]*(?:\.exe)?)\b/i;
      if (shellAnalysis.error || shellAnalysis.complex || shellAnalysis.segments.some((segment) => !safeSegment.test(segment.trim()))) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Execute terminal command chain requiring approval: "${cmd}"`,
          riskLevel: 'MEDIUM',
          details: { ...args, shellAnalysis, misuse },
          timestamp,
        };
      }

      // 3. Khám phá Codebase / Đọc file / Tìm kiếm (Terminal-First Codex Standard) -> LOW
      if (/^(?:cat|type|get-content|gc|head|tail|more|less|ls|dir|tree|get-childitem|gci|grep|rg|ripgrep|findstr|select-string|sls|find|fd|wc|which|where|pwd|echo|printf|node\s+-v|npm\s+-v|git\s+status|git\s+diff|git\s+log|env|printenv|sed\s+-n|awk)\b/i.test(lower)) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Explore codebase / read terminal data: "${cmd}"`,
          riskLevel: 'LOW',
          details: { ...args, shellAnalysis, misuse },
          timestamp,
        };
      }

      // 4. Lệnh build / test an toàn -> LOW
      if (
        /\b(npm\s+test|npm\s+run\s+build|npx\s+tsc|node\s+-v|dotnet\s+test|pytest|cargo\s+test|ctest)\b/i.test(lower)
        || /^(?:\.?[\/\\])?(?:bin|target|build|x64|x86)[\/\\](?:debug|release)[\/\\][a-zA-Z0-9_.-]*test[a-zA-Z0-9_.-]*(?:\.exe)?(?:\s+.*)?$/i.test(lower)
      ) {
        return {
          id,
          toolName,
          category: 'command_execution',
          target: cmd,
          summary: `Run test / build command: "${cmd}"`,
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
        summary: `Run terminal command: "${cmd}"`,
        riskLevel: 'MEDIUM',
        details: args,
        timestamp,
      };
    }

    if (toolName.startsWith('browser_')) {
      const navTarget = String(args.url || args.selector || args.ref || toolName);
      const isWrite = toolName === 'browser_click' || toolName === 'browser_type';
      return {
        id,
        toolName,
        category: 'general',
        target: navTarget.slice(0, 300),
        summary: isWrite ? `Out-of-codebase browser interaction (${toolName})` : `Read web via autonomous browser (${toolName})`,
        riskLevel: isWrite ? 'HIGH' : 'MEDIUM',
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
        summary: `Git operation: ${toolName}`,
        riskLevel: isPushOrReset ? 'HIGH' : 'LOW',
        details: args,
        timestamp,
      };
    }

    const descriptor = new ToolDescriptorRegistry().describe({ name: toolName, description: '', parameters: {}, execute: async () => ({}) });
    return {
      id,
      toolName,
      category: 'general',
      target: toolName,
      summary: `Execute tool ${toolName}`,
      riskLevel: descriptor.mutates || descriptor.requiresApproval ? 'MEDIUM' : 'LOW',
      details: args,
      timestamp,
    };
  }
}
