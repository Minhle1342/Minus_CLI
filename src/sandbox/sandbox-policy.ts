import path from 'node:path';

export type SandboxPolicyMode = 'strict' | 'workspace-write' | 'ephemeral-scratch' | 'unrestricted';

export type CommandRiskLevel = 'SAFE_READ_ONLY' | 'WORKSPACE_MUTATION' | 'SYSTEM_RISK' | 'UNAUTHORIZED_ESCAPE';

export interface CommandPolicyEvaluation {
  allowed: boolean;
  riskLevel: CommandRiskLevel;
  reason?: string;
  sanitizedCommand?: string;
  violations?: string[];
}

// Danh sách các mẫu lệnh hủy diệt hệ thống / nguy hiểm cực cao
const SYSTEM_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|-f[a-zA-Z]*r[a-zA-Z]*)\s+[\/\\]/i, // rm -rf /
  /rmdir\s+\/s\s+\/q\s+[c-zC-Z]:\\/i,                               // rmdir /s /q C:\
  /format\s+[c-zC-Z]:/i,                                             // format C:
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,                       // Bash fork bomb
  />\s*[\/\\]dev[\/\\]sd[a-z]/i,                                     // overwrite block devices
  /mkfs\./i,                                                         // format filesystems
  /dd\s+if=.*of=[\/\\]dev/i,                                         // dd to raw device
  /nc\s+-e\s+/i,                                                     // netcat reverse shell
  /bash\s+-i\s+>&/i,                                                 // interactive reverse shell
];

// Danh sách các file cấu hình và chứng chỉ nhạy cảm không được phép rò rỉ hoặc ghi đè mù
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env(\..+)?$/i,
  /\.gitconfig$/i,
  /\.ssh[\/\\]/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.aws[\/\\]credentials/i,
  /\.npmrc/i,
];

// Các lệnh đọc an toàn
const SAFE_READ_ONLY_PREFIXES = [
  'cat', 'head', 'tail', 'less', 'more', 'type', 'Get-Content', 'gc',
  'ls', 'dir', 'tree', 'Get-ChildItem', 'gci',
  'grep', 'rg', 'ripgrep', 'findstr', 'Select-String', 'sls', 'find', 'fd',
  'wc', 'which', 'where', 'pwd', 'echo', 'printf', 'env', 'printenv', 'jq',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
];

/**
 * SandboxPolicyEngine - Bộ Thực thi Quy tắc Bảo mật & Giới hạn Ranh giới Workspace (Codex Standard)
 */
export class SandboxPolicyEngine {
  private mode: SandboxPolicyMode;
  private workspaceRoot: string;
  private allowedPaths: Set<string> = new Set();

  constructor(workspaceRoot: string, mode: SandboxPolicyMode = 'workspace-write') {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.mode = mode;
    this.allowedPaths.add(this.workspaceRoot);
  }

  getMode(): SandboxPolicyMode {
    return this.mode;
  }

  setMode(mode: SandboxPolicyMode): void {
    this.mode = mode;
  }

  /**
   * Kiểm tra xem đường dẫn tệp tin có nằm hoàn toàn bên trong ranh giới Sandbox Workspace không
   */
  isPathContained(targetPath: string, customRoot?: string): boolean {
    const root = customRoot ? path.resolve(customRoot) : this.workspaceRoot;
    const resolved = path.resolve(root, targetPath);
    const relative = path.relative(root, resolved);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Kiểm tra xem tệp tin có thuộc diện nhạy cảm / chứa secrets không
   */
  isSensitiveFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  /**
   * Đánh giá rủi ro và phê duyệt lệnh shell trước khi cho phép thực thi
   */
  evaluateCommand(command: string, cwd?: string): CommandPolicyEvaluation {
    if (!command || !command.trim()) {
      return { allowed: false, riskLevel: 'SAFE_READ_ONLY', reason: 'Lệnh rỗng.' };
    }

    const trimmed = command.trim();

    // 1. Chặn các lệnh hủy diệt hệ điều hành nghiêm trọng
    for (const pattern of SYSTEM_DESTRUCTIVE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          riskLevel: 'SYSTEM_RISK',
          reason: `Lệnh bị từ chối bởi Sandbox Policy Engine: Phát hiện mẫu lệnh hủy diệt hệ thống nguy hiểm (${pattern}).`,
        };
      }
    }

    // 2. Kiểm tra chế độ Unrestricted
    if (this.mode === 'unrestricted') {
      return { allowed: true, riskLevel: 'WORKSPACE_MUTATION', sanitizedCommand: trimmed };
    }

    // 3. Phân loại Read-Only
    const isReadOnly = SAFE_READ_ONLY_PREFIXES.some(
      (prefix) => trimmed === prefix || trimmed.startsWith(prefix + ' ')
    );

    if (isReadOnly) {
      return { allowed: true, riskLevel: 'SAFE_READ_ONLY', sanitizedCommand: trimmed };
    }

    // 4. Nếu ở chế độ strict (chỉ đọc), từ chối các lệnh thay đổi dữ liệu
    if (this.mode === 'strict') {
      return {
        allowed: false,
        riskLevel: 'WORKSPACE_MUTATION',
        reason: `Sandbox đang hoạt động ở chế độ nghiêm ngặt (strict / read-only). Lệnh sửa đổi trạng thái "${trimmed}" bị chặn.`,
      };
    }

    // 5. Kiểm tra CWD có nằm trong workspace không nếu có truyền vào
    if (cwd) {
      const resolvedCwd = path.resolve(this.workspaceRoot, cwd);
      if (!this.isPathContained(resolvedCwd)) {
        return {
          allowed: false,
          riskLevel: 'UNAUTHORIZED_ESCAPE',
          reason: `Từ chối thực thi: Thư mục làm việc "${cwd}" nằm ngoài ranh giới cho phép của Sandbox Workspace (${this.workspaceRoot}).`,
        };
      }
    }

    return {
      allowed: true,
      riskLevel: 'WORKSPACE_MUTATION',
      sanitizedCommand: trimmed,
    };
  }

  /**
   * Lọc và làm sạch biến môi trường, loại bỏ các secret hoặc biến nguy hiểm
   */
  sanitizeEnvironment(rawEnv: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const blockedKeys = new Set([
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
    ]);

    for (const [key, value] of Object.entries(rawEnv)) {
      if (value !== undefined && !blockedKeys.has(key)) {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
