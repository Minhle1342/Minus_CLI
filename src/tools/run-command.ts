import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { Type } from '@google/genai';
import { ToolDefinition, type ToolExecutionContext } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { diagnoseCommandFailure } from '../sandbox/command-diagnostics.js';
import { LocalProcessSandbox } from '../sandbox/local-sandbox.js';
import { executeRipgrepEmulation, parseRipgrepCommand } from './rg-emulator.js';
import { TaskManager } from '../tasks/task-manager.js';
import { analyzeShellCommand } from '../security/shell-segmenter.js';

// Danh sách các tiền tố lệnh an toàn khi chạy ở chế độ Host / Unsandboxed (Terminal-First Exploration & Build)
const ALLOWED_COMMAND_PREFIXES = [
  // Khám phá Codebase & Điều tra tệp tin (Terminal-First)
  'cat ',
  'cat',
  'type ',
  'type',
  'Get-Content',
  'gc ',
  'head ',
  'head',
  'tail ',
  'tail',
  'more ',
  'less ',
  'ls',
  'ls ',
  'dir',
  'dir ',
  'tree',
  'Get-ChildItem',
  'gci ',
  'grep ',
  'rg ',
  'ripgrep ',
  'findstr ',
  'Select-String',
  'sls ',
  'find ',
  'find.',
  'fd ',
  'wc ',
  'wc',
  'which ',
  'where ',
  'pwd',
  'echo ',
  'printf ',
  'env',
  'printenv',
  'jq ',
  'sed ',
  'awk ',
  // Build, Test & Package Management
  'npm test',
  'npm run ',
  'npm start',
  'npm --version',
  'npm list',
  'npx tsx',
  'npx tsc',
  'npx eslint',
  'npx prettier',
  'npx jest',
  'npx vitest',
  'node ',
  'node -v',
  'node --version',
  'dotnet ',
  'dotnet',
  'python ',
  'python3 ',
  'pip ',
  'pip3 ',
  'pytest ',
  'mvn ',
  'gradle ',
  './gradlew',
  'gradlew',
  'go ',
  'cargo ',
  'rustc ',
  'tsc',
  'curl ',
  'wget ',
  // Read-only Git commands
  'git status',
  'git diff',
  'git log',
  'git branch',
  'git show',
  'git rev-parse',
  'git describe',
];

/**
 * Cắt ngắn output nếu quá dài để bảo vệ context window của LLM.
 */
function truncateOutput(text: string, maxLength: number = 50000): string {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  const half = Math.floor(maxLength / 2);
  return `${text.slice(0, half)}\n\n[... Đã cắt bớt ${text.length - maxLength} ký tự output ...]\n\n${text.slice(-half)}`;
}

/**
 * Kiểm tra xem lệnh có nằm trong danh sách an toàn hay không (cho Host mode).
 */
export function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_COMMAND_PREFIXES.some((prefix) => {
    const exact = prefix.trim();
    return trimmed === exact || (prefix.endsWith(' ') && trimmed.startsWith(prefix));
  });
}

export function isAllowedShellCommand(command: string): boolean {
  const analysis = analyzeShellCommand(command);
  return !analysis.error && !analysis.complex && analysis.segments.every(isAllowedCommand);
}

/** All Git commands use argv-based Git tools so aliases/shell text cannot bypass policy. */
export function findGitSubcommand(command: string): string | undefined {
  const invocations = command.toLowerCase().matchAll(/\bgit(?:\.exe)?\b([^;&|\n]*)/g);
  for (const invocation of invocations) {
    const tokens = (String(invocation[1] || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
      .map((token) => token.replace(/^["']|["']$/g, ''));
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith('--git-dir=') || token.startsWith('--work-tree=') || token.startsWith('--namespace=')) {
        index++;
        continue;
      }
      if (token.startsWith('-')) {
        index++;
        continue;
      }
      return token;
    }
  }
  return undefined;
}

export interface FileMisuseDetection {
  tool: string;
  reason: string;
  suggestedArgs?: Record<string, any>;
}

/** Phát hiện hành vi dùng nhầm run_command để đọc file / duyệt thư mục / tìm kiếm */
export function detectFileCommandMisuse(command: string): FileMisuseDetection | undefined {
  const trimmed = command.trim();

  // 1.1. Đọc cắt đoạn file qua sed -n 'start,endp' filePath
  const sedSliceMatch = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (sedSliceMatch) {
    const startLine = parseInt(sedSliceMatch[1], 10);
    const endLine = sedSliceMatch[2] ? parseInt(sedSliceMatch[2], 10) : startLine;
    const filePath = sedSliceMatch[3].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Đọc file theo khoảng dòng chính xác (không tốn lượt cấp quyền, cung cấp contentHash) thay vì chia nhỏ bằng sed',
      suggestedArgs: { path: filePath, startLine, endLine },
    };
  }

  // 1.2. Đọc file qua shell (cat, type, Get-Content, gc, head, tail, more, less, sed)
  const readMatch = trimmed.match(/^(?:cat|type|Get-Content|gc|head|tail|more|less)\s+([^\s;&|]+)/i);
  if (readMatch) {
    const filePath = readMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Đọc nội dung file với hashing và an toàn token',
      suggestedArgs: { path: filePath },
    };
  }

  // 1.3. Trích xuất text hoặc code qua awk
  const awkMatch = trimmed.match(/^awk\s+.*?((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (awkMatch && !trimmed.includes('|')) {
    const filePath = awkMatch[1].replace(/^["']|["']$/g, '');
    return {
      tool: 'read_file',
      reason: 'Đọc nội dung file hoặc trích xuất symbol với read_file (symbol) / inspect_symbol',
      suggestedArgs: { path: filePath },
    };
  }

  // 2. Duyệt file/thư mục qua shell (ls, dir, tree, Get-ChildItem, gci)
  const listMatch = trimmed.match(/^(?:ls|dir|tree|Get-ChildItem|gci)(?:\s+([^\s;&|]+))?$/i);
  if (listMatch) {
    const dirPath = (listMatch[1] || '').replace(/^["']|["']$/g, '') || undefined;
    return {
      tool: 'list_files',
      reason: 'Liệt kê cấu trúc thư mục với bộ lọc tự động bỏ qua node_modules/.git',
      suggestedArgs: dirPath ? { dirPath } : {},
    };
  }

  // 3. Tìm kiếm chuỗi qua shell (grep, findstr, Select-String, sls)
  const grepMatch = trimmed.match(/^(?:grep|findstr|Select-String|sls)\s+(?:-[a-zA-Z0-9-]+\s+)*['"]?([^'"]+)['"]?/i);
  if (grepMatch) {
    const query = grepMatch[1];
    return {
      tool: 'search_codebase_fast',
      reason: 'Tìm kiếm BM25 nhanh trên toàn bộ codebase không tốn token',
      suggestedArgs: { query },
    };
  }

  return undefined;
}

export interface SedSliceOptions {
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Phân tích cú pháp lệnh sed cắt dòng (ví dụ: sed -n '2228,2280p' server.js)
 */
export function parseSedSliceCommand(command: string): SedSliceOptions | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+((?:'[^']+')|(?:"[^"]+")|(?:[^\s;&|]+))$/i);
  if (!match) return null;
  const startLine = parseInt(match[1], 10);
  const endLine = match[2] ? parseInt(match[2], 10) : startLine;
  const filePath = match[3].replace(/^["']|["']$/g, '');
  return {
    filePath,
    startLine,
    endLine,
  };
}

/**
 * Giả lập thực thi sed cắt dòng siêu tốc qua Node.js I/O (tránh độ trễ 3-13s khi spawn shell trên Windows)
 */
export async function executeSedSliceEmulation(
  parsed: SedSliceOptions,
  workspace: Workspace,
): Promise<{ stdout: string; success: boolean; durationMs: number; exitCode: number }> {
  const startTime = Date.now();
  try {
    const safePath = workspace.resolveSafePath(parsed.filePath);
    const content = await fs.readFile(safePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const s = Math.max(1, parsed.startLine);
    const e = Math.min(lines.length, parsed.endLine);
    const selected = lines.slice(s - 1, e);
    return {
      stdout: selected.join('\n'),
      success: true,
      durationMs: Date.now() - startTime,
      exitCode: 0,
    };
  } catch {
    return {
      stdout: '',
      success: false,
      durationMs: Date.now() - startTime,
      exitCode: 1,
    };
  }
}

/**
 * Tạo Tool run_command có tích hợp SandboxManager và TaskManager (Chuẩn Antigravity CLI Unified Command Execution)
 */
export function createRunCommandTool(sandboxManager?: SandboxManager, taskManager?: TaskManager, permissionManager?: any): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Thực thi lệnh terminal (build, test, lint, script, git) trong Sandbox cô lập hoặc Host. Hỗ trợ tham số WaitMsBeforeAsync để tự động chuyển lệnh chạy lâu sang background task. LƯU Ý QUAN TRỌNG: Để đọc hoặc kiểm tra mã nguồn (file inspection), BẮT BUỘC dùng tool "read_file" (hỗ trợ trích xuất toàn bộ hàm qua "symbol" trong 1-shot hoặc dải dòng 150-300 dòng). KHÔNG dùng run_command với sed/cat/head để chia nhỏ file thành từng khúc 50 dòng gây lãng phí step.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'Lệnh terminal cần thực thi (ví dụ: "npm test", "rg \'my_function\' src/", "ls -la", "node -v"). Không dùng để đọc file (hãy dùng read_file).',
        },
        CommandLine: {
          type: Type.STRING,
          description: 'Bí danh chuẩn Antigravity của lệnh terminal cần thực thi.',
        },
        WaitMsBeforeAsync: {
          type: Type.INTEGER,
          description: 'Số milliseconds chờ đợi sau khi bắt đầu lệnh trước khi gửi xuống chạy nền (background task). Tối đa 10000ms. Nếu lệnh kết thúc trong khoảng này, trả về kết quả đồng bộ; nếu chưa, chuyển thành Background Task.',
        },
        timeout_ms: {
          type: Type.NUMBER,
          description: 'Timeout theo mili-giây (mặc định 120000, tối thiểu 1000, tối đa 300000). Tăng cho restore/build/test lớn.',
        },
        execution_target: {
          type: Type.STRING,
          description: 'Nơi thực thi: "auto" (mặc định, ưu tiên sandbox) hoặc "host" (host OS, chỉ dành cho lệnh allowlist khi dependency native không tương thích container).',
        },
      },
      required: [],
    },
    async execute(args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext): Promise<Record<string, any>> {
      const rawCommand = String(args.command || args.CommandLine || args.commandLine || args.cmd || '').trim();
      let hasExplicitPermission = context?.permissionGranted === true;
      const effectivePermissionManager = context?.permissionManager || permissionManager;
      const executionTarget = String(args.execution_target || 'auto').trim().toLowerCase();
      const configuredTimeout = Number(process.env.RUN_COMMAND_TIMEOUT_MS || 120000);
      const requestedTimeout = Number(args.timeout_ms);
      const defaultTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
      const timeoutMs = Math.min(
        300000,
        Math.max(1000, Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : defaultTimeout),
      );

      if (!rawCommand) {
        return { error: 'Tham số "command" hoặc "CommandLine" là bắt buộc.' };
      }

      // Parse and authorize the entire command before any synchronous or background dispatch.
      const shellAnalysis = analyzeShellCommand(rawCommand);

      const gitSubcommandBeforeDispatch = findGitSubcommand(rawCommand);
      const readOnlyGitSubcommands = new Set(['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'describe', 'tag']);
      const isGitMutation = Boolean(gitSubcommandBeforeDispatch && !readOnlyGitSubcommands.has(gitSubcommandBeforeDispatch));

      // Kích hoạt Interactive Permission Approval nếu lệnh phức tạp, là git mutation, hoặc chứa phân đoạn ngoài allowlist
      const needsApproval = Boolean(shellAnalysis.error)
        || shellAnalysis.complex
        || isGitMutation
        || !shellAnalysis.segments.every(isAllowedCommand);

      const permArgs = { ...args, command: rawCommand, CommandLine: rawCommand };

      if (needsApproval && !hasExplicitPermission && effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
        const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
        if (permCheck.allowed) {
          hasExplicitPermission = true;
          if (context) context.permissionGranted = true;
        } else {
          return {
            command: rawCommand,
            error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi hoặc chưa được cấp quyền (PERMISSION APPROVAL).`,
            errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
            permissionRequestId: permCheck.permissionRequestId,
          };
        }
      }

      if (shellAnalysis.error || (shellAnalysis.complex && !hasExplicitPermission)) {
        return {
          command: rawCommand,
          error: shellAnalysis.error || 'Complex shell grouping/substitution requires explicit permission.',
          errorCode: 'COMMAND_PARSE_REJECTED',
        };
      }
      if (isGitMutation && !hasExplicitPermission) {
        return {
          command: rawCommand,
          error: `Git mutation (${gitSubcommandBeforeDispatch}) phải được thực thi bằng git_command hoặc cần được cấp quyền (PERMISSION APPROVAL).`,
          errorCode: 'GIT_COMMAND_REQUIRES_GIT_TOOL',
          suggestion: `Use git_command with subcommand "${gitSubcommandBeforeDispatch}" and a separate args array so workspace scope and per-turn authorization can be verified, hoặc yêu cầu phê duyệt từ người dùng.`,
        };
      }
      if (!shellAnalysis.segments.every(isAllowedCommand) && !hasExplicitPermission) {
        const deniedSegments = shellAnalysis.segments.filter((segment) => !isAllowedCommand(segment));
        return {
          command: rawCommand,
          error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) từ người dùng. Các phân đoạn ngoài allowlist: ${deniedSegments.join(', ')}`,
          errorCode: 'COMMAND_NOT_ALLOWED',
          deniedSegments,
          suggestion: 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
        };
      }

      // Xử lý WaitMsBeforeAsync (Antigravity CLI Async Dispatch)
      const waitMsBeforeAsync = typeof args.WaitMsBeforeAsync === 'number'
        ? Math.min(10000, Math.max(0, args.WaitMsBeforeAsync))
        : (typeof args.wait_ms_before_async === 'number' ? Math.min(10000, Math.max(0, args.wait_ms_before_async)) : undefined);

      if (waitMsBeforeAsync !== undefined && waitMsBeforeAsync > 0 && taskManager) {
        const bgTask = taskManager.startTask(rawCommand, workspace.rootDir);
        const startTime = Date.now();
        const deadline = startTime + waitMsBeforeAsync;

        while (Date.now() < deadline) {
          if (bgTask.status !== 'running') break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        if (bgTask.status !== 'running') {
          return {
            command: rawCommand,
            exitCode: bgTask.exitCode ?? (bgTask.status === 'stopped' ? 0 : 1),
            stdout: truncateOutput(bgTask.logs.join('\n')),
            stderr: '',
            durationMs: Date.now() - startTime,
            success: bgTask.exitCode === 0 || bgTask.status === 'stopped',
            sandboxType: 'local',
          };
        }

        return {
          command: rawCommand,
          isBackgroundTask: true,
          taskId: bgTask.id,
          pid: bgTask.pid,
          status: 'running',
          message: `Tool is running as a background task with task id: ${bgTask.id}`,
          recentLogs: bgTask.logs.slice(-10),
          instruction: `Sử dụng tool manage_task với TaskId="${bgTask.id}" để xem status, gửi stdin (send_input), hoặc kill.`,
        };
      }
      if (!['auto', 'host'].includes(executionTarget)) {
        return {
          command: rawCommand,
          error: 'execution_target chỉ chấp nhận "auto" hoặc "host".',
          errorCode: 'INVALID_EXECUTION_TARGET',
        };
      }

      // Tự động tối ưu hoá sed cắt dòng (sed -n 'start,endp' file) bằng bộ giả lập siêu tốc Node.js (<5ms)
      const parsedSed = parseSedSliceCommand(rawCommand);
      if (parsedSed) {
        const emulatedSed = await executeSedSliceEmulation(parsedSed, workspace);
        if (emulatedSed.success) {
          return {
            command: rawCommand,
            stdout: truncateOutput(emulatedSed.stdout),
            stderr: '',
            exitCode: emulatedSed.exitCode,
            durationMs: emulatedSed.durationMs,
            sandbox: 'local',
            executionTarget,
            success: true,
            emulated: true,
            suggestion: 'Mẹo: Để tối ưu tốc độ và token, hãy dùng trực tiếp tool read_file với path, startLine, endLine hoặc symbol.',
          };
        }
      }

      if (executionTarget === 'host') {
        if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
            const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
            if (permCheck.allowed) {
              hasExplicitPermission = true;
              if (context) context.permissionGranted = true;
            } else {
              return {
                command: rawCommand,
                error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi trên Host.`,
                errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
                permissionRequestId: permCheck.permissionRequestId,
              };
            }
          }
        }
        if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          return {
            command: rawCommand,
            error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) để thực thi trên Host.`,
            errorCode: 'COMMAND_NOT_ALLOWED',
            suggestion: 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
          };
        }
        const hostSandbox = new LocalProcessSandbox(workspace.rootDir);
        await hostSandbox.init();
        const hostResult = await hostSandbox.exec(rawCommand, { cwd: workspace.rootDir, timeoutMs, signal: context?.signal });

        // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu binary không có sẵn trên Host
        const parsedSearch = parseRipgrepCommand(rawCommand);
        if (parsedSearch && hostResult.exitCode !== 0) {
          const emulated = await executeRipgrepEmulation(parsedSearch, workspace);
          const nativeCommandMissing = hostResult.exitCode === 127
            || hostResult.stderr.includes('not found')
            || hostResult.stderr.includes('not recognized');
          // Recover both a missing binary and shell-quoting differences when
          // the deterministic emulator can satisfy the search.
          if (emulated.success || nativeCommandMissing) {
            return {
              command: rawCommand,
              stdout: truncateOutput(emulated.stdout),
              stderr: '',
              exitCode: emulated.exitCode,
              durationMs: emulated.durationMs,
              sandbox: 'local',
              executionTarget: 'host',
              success: emulated.success,
              emulated: true,
            };
          }
        }

        const hostDiagnosis = diagnoseCommandFailure(rawCommand, hostResult, hostSandbox.getStatus());
        return {
          command: rawCommand,
          ...hostResult,
          ...hostDiagnosis,
          stdout: truncateOutput(hostResult.stdout),
          stderr: truncateOutput(hostResult.stderr),
          sandbox: hostResult.sandboxType,
          executionTarget: 'host',
        };
      }

      // Nếu có SandboxManager đang chạy
      if (sandboxManager) {
        const status = sandboxManager.getStatus();
        
        // Nếu không ở trong môi trường Docker Container cô lập, kiểm tra cấp quyền
        if (!status.isIsolated && !isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
            const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
            if (permCheck.allowed) {
              hasExplicitPermission = true;
              if (context) context.permissionGranted = true;
            } else {
              return {
                command: rawCommand,
                error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi trên Host.`,
                errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
                permissionRequestId: permCheck.permissionRequestId,
              };
            }
          }
        }

        if (!status.isIsolated && !isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
          return {
            command: rawCommand,
            error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) để thực thi trên Host. (Hoặc bật Docker Sandbox để chạy lệnh không giới hạn).`,
            errorCode: 'COMMAND_NOT_ALLOWED',
            suggestion: 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
          };
        }

        const res = await sandboxManager.exec(rawCommand, {
          cwd: workspace.rootDir,
          timeoutMs,
          signal: context?.signal,
        });

        // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu Docker Container thiếu binary hoặc gặp lỗi 127
        if (res.exitCode === 127 || res.stderr.includes('not found') || res.stderr.includes('not recognized')) {
          const isRg = parseRipgrepCommand(rawCommand);
          if (isRg) {
            const emulated = await executeRipgrepEmulation(isRg, workspace);
            return {
              command: rawCommand,
              stdout: truncateOutput(emulated.stdout),
              stderr: '',
              exitCode: emulated.exitCode,
              durationMs: emulated.durationMs,
              sandbox: res.sandboxType,
              executionTarget: 'auto',
              success: emulated.success,
              emulated: true,
            };
          }
        }

        const diagnosis = res.errorCode
          ? undefined
          : diagnoseCommandFailure(rawCommand, res, sandboxManager.getStatus());
        const hostRecoveryRecommended = process.platform === 'win32'
          && res.sandboxType === 'docker'
          && ['NATIVE_DEPENDENCY_MISSING', 'COMMAND_NOT_EXECUTABLE'].includes(diagnosis?.errorCode || '');
        const recoverySuggestion = hostRecoveryRecommended
          ? `${diagnosis!.suggestion} This host is Windows; if the project intentionally uses Windows-native packages, retry run_command with execution_target: "host".`
          : diagnosis?.suggestion;

        return {
          command: rawCommand,
          ...res,
          ...diagnosis,
          ...(recoverySuggestion ? { suggestion: recoverySuggestion } : {}),
          ...(hostRecoveryRecommended ? { recommendedExecutionTarget: 'host' } : {}),
          stdout: truncateOutput(res.stdout),
          stderr: truncateOutput(res.stderr),
          sandbox: res.sandboxType,
          executionTarget: 'auto',
        };
      }

      // Fallback mặc định
      if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
        if (effectivePermissionManager && typeof effectivePermissionManager.checkPermission === 'function') {
          const permCheck = await effectivePermissionManager.checkPermission('run_command', permArgs, context);
          if (permCheck.allowed) {
            hasExplicitPermission = true;
            if (context) context.permissionGranted = true;
          } else {
            return {
              command: rawCommand,
              error: permCheck.reason || `Lệnh "${rawCommand}" đã bị từ chối thực thi.`,
              errorCode: permCheck.errorCode || 'PERMISSION_DENIED',
              permissionRequestId: permCheck.permissionRequestId,
            };
          }
        }
      }

      if (!isAllowedShellCommand(rawCommand) && !hasExplicitPermission) {
        return {
          command: rawCommand,
          error: `Lệnh "${rawCommand}" cần XÁC NHẬN CẤP QUYỀN THỰC THI (PERMISSION APPROVAL) trước khi thực thi.`,
          errorCode: 'COMMAND_NOT_ALLOWED',
          suggestion: 'Yêu cầu người dùng duyệt quyền (Permission Approval) hoặc chuyển sang tool chuyên dụng.',
        };
      }

      return new Promise((resolve) => {
        exec(
          rawCommand,
          {
            cwd: workspace.rootDir,
            timeout: timeoutMs,
            signal: context?.signal,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const timedOut = error?.killed && error.signal === 'SIGTERM';
            const exitCode = error ? (error.code ?? 1) : 0;

            const rawResult = {
              command: rawCommand,
              exitCode,
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(stderr),
              timedOut: Boolean(timedOut),
              durationMs: 0,
              sandboxType: 'local' as const,
              success: exitCode === 0,
            };

            // Tự động kích hoạt Built-in Ripgrep/Grep Emulator nếu gặp lỗi 127
            if (exitCode === 127 || stderr.includes('not found') || stderr.includes('not recognized')) {
              const isRg = parseRipgrepCommand(rawCommand);
              if (isRg) {
                executeRipgrepEmulation(isRg, workspace).then((emulated) => {
                  resolve({
                    command: rawCommand,
                    stdout: truncateOutput(emulated.stdout),
                    stderr: '',
                    exitCode: emulated.exitCode,
                    durationMs: emulated.durationMs,
                    sandboxType: 'local' as const,
                    sandbox: 'local',
                    success: emulated.success,
                    emulated: true,
                  });
                });
                return;
              }
            }

            resolve({
              ...rawResult,
              ...diagnoseCommandFailure(rawCommand, rawResult),
            });
          }
        );
      });
    },
  };
}

export const runCommandTool: ToolDefinition = createRunCommandTool();
