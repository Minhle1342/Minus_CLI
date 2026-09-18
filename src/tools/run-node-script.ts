import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Type } from '@google/genai';
import { ToolDefinition, ToolExecutionContext } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import {
  calculateComprehensiveBlastRadius,
  invalidateTopologyCache,
  ImpactRiskLevel,
} from './mutation-blast-radius.js';
import {
  classifyToolFailure,
  DEFAULT_TOOL_ALTERNATIVES,
  type ToolFailureDiagnosis,
} from './tool-use-guardian.js';

const execFileAsync = promisify(execFile);

/**
 * Giới hạn kích thước mã nguồn script (Pre-Call Payload Size Guard)
 */
const MAX_SCRIPT_BYTES = 128 * 1024; // 128 KB

/**
 * Biểu thức chính quy nhận diện lỗi/ngoại lệ bị nuốt hoặc in ra console (Error-as-200)
 */
const ERROR_AS_200_PATTERNS = [
  /(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError):\s+[^\n]+/i,
  /UnhandledPromiseRejection(?:Warning)?:\s+[^\n]+/i,
  /uncaughtException:\s+[^\n]+/i,
  /\bERR_[A-Z0-9_]+\b/,
  /Error:\s*ENOENT:[^\n]+/i,
  /Cannot find module\s+['"][^'"]+['"]/i,
  /FATAL ERROR:[^\n]+/i,
  /Command failed:[^\n]+/i,
];

/**
 * Trích xuất thông điệp lỗi súc tích, chính xác từ stderr hoặc execErr
 * Loại bỏ tiền tố Command failed dài dòng chứa đường dẫn tuyệt đối của node.exe và scratch file
 */
export function extractCleanScriptErrorMessage(stderr: string, execErr?: any): string {
  const combined = `${stderr || ''}\n${execErr?.message || ''}`.trim();
  if (!combined) return 'Unknown runtime error';

  // 1. Nhận diện các mẫu lỗi ngoại lệ JavaScript/Node chuẩn (TypeError, SyntaxError, Error [ERR_...], v.v.)
  const errorPatterns = [
    /(?:^|\n)((?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|AssertionError|Error)(?:\s*\[[^\]]+\])?:\s*[^\n]+)/i,
    /(?:^|\n)(Cannot find (?:module|package)\s+['"][^'"]+['"][^\n]*)/i,
    /(?:^|\n)(ERR_[A-Z0-9_]+:\s*[^\n]+)/i,
    /(?:^|\n)(UnhandledPromiseRejection(?:Warning)?:\s*[^\n]+)/i,
    /(?:^|\n)(FATAL ERROR:[^\n]+)/i,
  ];

  for (const pattern of errorPatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // 2. Nếu không khớp mẫu chuẩn, tách các dòng và lọc bỏ rác hệ thống
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const cleanLines = lines.filter((line) => {
    if (/^Command failed:\s*/i.test(line)) return false;
    if (/^Node\.js v\d+/i.test(line)) return false;
    if (/^\(Use `node --trace-warnings/i.test(line)) return false;
    if (/^\^+\s*$/.test(line)) return false; // Caret pointers
    if (/^at\s+/i.test(line)) return false; // Stack trace frame
    return true;
  });

  if (cleanLines.length > 0) {
    return cleanLines[0];
  }

  // 3. Fallback: Nếu chỉ còn thông báo Command failed, cố gắng bóc tách phần lệnh
  if (execErr?.message) {
    const stripped = execErr.message.replace(/^Command failed:[^\n]*\n?/i, '').trim();
    if (stripped) return stripped.split(/\r?\n/)[0].trim();
  }

  return 'Unknown runtime error';
}

/**
 * Trích xuất bản đồ trạng thái git snapshot dạng { relativePath: mtimeMs }
 */
function getGitStatusSnapshot(rootDir: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const stdout = execSync('git status --porcelain', {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const lines = stdout.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const filePart = trimmed.slice(2).trim();
      const target = filePart.includes('->') ? filePart.split('->')[1].trim() : filePart;
      const norm = target.replace(/\\/g, '/');
      const fullPath = path.resolve(rootDir, norm);
      try {
        const stat = fsSync.statSync(fullPath);
        map.set(norm, stat.mtimeMs);
      } catch {
        map.set(norm, 0);
      }
    }
  } catch {
    // Không phải git repo hoặc git lỗi -> bỏ qua
  }
  return map;
}

function riskWeight(risk: ImpactRiskLevel): number {
  switch (risk) {
    case 'CRITICAL': return 4;
    case 'HIGH': return 3;
    case 'MEDIUM': return 2;
    case 'LOW':
    default: return 1;
  }
}

/**
 * Tool: run_node_script
 * 
 * Thiết kế theo chuẩn toàn diện:
 * 1. tool-design:
 *    - Tool Description Engineering: Cấu trúc 4 câu hỏi (What it does, When to use, When NOT to use, Returns) kèm ví dụ 1-shot trực quan.
 *    - The Consolidation Principle & Architectural Reduction: Hợp nhất toàn diện quy trình multi-file batch updates (chuẩn bị, kiểm tra cú pháp, thực thi cách ly, tracking file, blast radius, dọn dẹp) trong 1 công cụ duy nhất; không over-constrain khả năng suy luận tự nhiên của LLM.
 *    - Response Format Optimization: Hỗ trợ tham số `responseFormat` ("concise" mặc định vs "detailed") để kiểm soát kích thước context và tối ưu token.
 *    - Actionable Error Messages: Cung cấp `actionableFix` và `recoveryAction` giúp mô hình tự chữa lành (Self-Healing).
 * 2. tool-use-guardian:
 *    - Pre-Call Validation (kích thước payload <= 128KB, cú pháp in-memory với vm.Script, Pre-Mutation Gate).
 *    - 9-Category Failure Classification (API_TIMEOUT, ERROR_AS_200, SCHEMA_MISMATCH).
 *    - Error-as-200 Detection & Unmasking (phát hiện ngoại lệ/lỗi bị nuốt dù exitCode = 0).
 *    - Fallback Alternatives & Circuit Breaker (apply_patch, replace_text, run_command).
 * 3. agent-tool-builder:
 *    - Ranh giới mục đích tường minh, Negative Guidance chống tool confusion.
 */
export const runNodeScriptTool: ToolDefinition = {
  name: 'run_node_script',
  description:
    'Executes a Node.js script in an isolated subprocess to perform programmatic, multi-file codebase modifications.\n' +
    '• WHAT IT DOES: Runs a self-contained JavaScript (ESM/CJS) script to automate multi-file refactoring, batch regex string transformations, AST codemods, directory migrations, or bulk formatting.\n' +
    '• WHEN TO USE: Use when modifying 2 or more files programmatically where applying manual diffs with apply_patch is too tedious, repetitive, or token-costly.\n' +
    '• WHEN NOT TO USE: DO NOT use for surgical single-file edits (always use apply_patch or replace_text). DO NOT use for running terminal shell commands or build scripts (use run_command). DO NOT use for read-only codebase exploration (use read_file or grep_search).\n' +
    '• INPUTS: scriptContent (executable Node.js code), description (rationale), optional timeoutMs (default 15000, max 30000), optional targetFiles, optional responseFormat ("concise" | "detailed").\n' +
    '• RETURNS: Standard JSON object with execution status, totalModifiedFiles, list of modifiedFiles, durationMs, and blast radius impact.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      scriptContent: {
        type: Type.STRING,
        description:
          'The complete JavaScript/Node.js source code (ESM or CJS) to execute. Must be self-contained and perform file updates using workspace-relative or absolute paths.\n' +
          'Example:\n' +
          '  import fs from "node:fs/promises";\n' +
          '  const targets = ["src/a.ts", "src/b.ts"];\n' +
          '  for (const file of targets) {\n' +
          '    const content = await fs.readFile(file, "utf-8");\n' +
          '    await fs.writeFile(file, content.replace(/oldPattern/g, "newPattern"));\n' +
          '  }',
      },
      description: {
        type: Type.STRING,
        description:
          'A concise explanation of what this script modifies and why automated batch modification is necessary.',
      },
      timeoutMs: {
        type: Type.INTEGER,
        description:
          'Optional execution timeout in milliseconds (default: 15000, max: 30000). Terminates process to prevent infinite loops.',
      },
      targetFiles: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description:
          'Optional list of workspace-relative file paths that this script intends to modify. Used for pre-mutation validation and targeted blast radius computation.',
      },
      responseFormat: {
        type: Type.STRING,
        description:
          'Output verbosity level. "concise" (default) returns essential status, summary, and preview to conserve context window tokens. "detailed" returns full stdout, stderr, and complete blast radius topology.',
      },
    },
    required: ['scriptContent', 'description'],
  },
  async execute(
    args: Record<string, any>,
    workspace: Workspace,
    context?: ToolExecutionContext,
  ): Promise<Record<string, any>> {
    const scriptContent = typeof args.scriptContent === 'string' ? args.scriptContent.trim() : '';
    const scriptDesc = typeof args.description === 'string' ? args.description.trim() : '';
    const requestedTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : 15000;
    const effectiveTimeout = Math.min(Math.max(1000, requestedTimeout), 30000);
    const responseFormat: 'concise' | 'detailed' = args.responseFormat === 'detailed' ? 'detailed' : 'concise';
    const suggestedAlternative = DEFAULT_TOOL_ALTERNATIVES['run_node_script']?.[0] || 'apply_patch';

    // =========================================================================
    // STEP 1: Pre-Call Validation (tool-design & tool-use-guardian)
    // =========================================================================

    // 1.1 Kiểm tra tham số bắt buộc
    if (!scriptContent) {
      const diag: ToolFailureDiagnosis = {
        category: 'SCHEMA_MISMATCH',
        message: 'scriptContent must be a non-empty string containing executable Node.js code.',
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Provide valid, non-empty JavaScript/Node.js code in scriptContent.',
        suggestedAlternative,
      };
      return {
        success: false,
        is_error: true,
        errorCode: 'INVALID_ARGS',
        error: diag.message,
        category: diag.category,
        recoveryAction: diag.recoveryAction,
        actionableFix: 'Provide a valid non-empty JavaScript string in scriptContent adhering to ESM/CJS syntax.',
        suggestedAlternative: diag.suggestedAlternative,
        guardianDiagnosis: diag,
      };
    }

    if (!scriptDesc) {
      const diag: ToolFailureDiagnosis = {
        category: 'SCHEMA_MISMATCH',
        message: 'description is required to explain the intent of this batch modification.',
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Provide a concise explanation of what the script does and why automated modification is needed.',
        suggestedAlternative,
      };
      return {
        success: false,
        is_error: true,
        errorCode: 'INVALID_ARGS',
        error: diag.message,
        category: diag.category,
        recoveryAction: diag.recoveryAction,
        actionableFix: 'Include a description field explaining what files will be modified and the purpose of the batch update.',
        suggestedAlternative: diag.suggestedAlternative,
        guardianDiagnosis: diag,
      };
    }

    // 1.2 Kiểm tra giới hạn kích thước payload (Payload Size Guard)
    const scriptBytes = Buffer.byteLength(scriptContent, 'utf-8');
    if (scriptBytes > MAX_SCRIPT_BYTES) {
      const diag: ToolFailureDiagnosis = {
        category: 'SCHEMA_MISMATCH',
        message: `scriptContent exceeds maximum payload limit of 128KB (${scriptBytes} bytes).`,
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Decompose script into smaller batches or split logic into separate files.',
        suggestedAlternative,
      };
      return {
        success: false,
        is_error: true,
        errorCode: 'PAYLOAD_TOO_LARGE',
        error: diag.message,
        category: diag.category,
        recoveryAction: diag.recoveryAction,
        actionableFix: `Payload size (${scriptBytes} bytes) exceeds limit (128KB). Split your script into smaller sequential batches or extract helper logic into a standalone workspace module.`,
        suggestedAlternative: diag.suggestedAlternative,
        guardianDiagnosis: diag,
      };
    }

    // 1.3 In-Memory Syntax Pre-validation: Bắt lỗi cú pháp sớm mà không tốn chi phí spawn subprocess
    try {
      new vm.Script(scriptContent, { filename: 'script-precheck.js' });
    } catch (syntaxErr: any) {
      const diag: ToolFailureDiagnosis = {
        category: 'SCHEMA_MISMATCH',
        message: `JavaScript Syntax Error in scriptContent: ${syntaxErr.message}`,
        isRetryable: false,
        maxRetries: 0,
        backoffMs: 0,
        recoveryAction: 'Fix the syntax error in scriptContent before running the script.',
        suggestedAlternative,
      };
      return {
        success: false,
        is_error: true,
        errorCode: 'SYNTAX_ERROR',
        error: diag.message,
        category: diag.category,
        recoveryAction: diag.recoveryAction,
        actionableFix: `Inspect syntax near the reported token (${syntaxErr.message}). Verify unmatched brackets, valid import statements, and valid JavaScript syntax.`,
        suggestedAlternative: diag.suggestedAlternative,
        guardianDiagnosis: diag,
      };
    }

    // 1.4 Pre-Mutation Evidence Gate Integration: Chặn sửa đổi khi chưa đủ bằng chứng trong bugfix/refactor
    const gateContext = (context as any)?.preMutationGateContext || (context as any)?.preMutationGate;
    const isEvidenceControlledTask = Boolean(
      gateContext?.isBugfixTask ||
      gateContext?.taskIntent === 'bugfix' ||
      gateContext?.taskClass === 'bugfix' ||
      gateContext?.taskClass === 'refactor' ||
      gateContext?.taskClass === 'security'
    );
    if (isEvidenceControlledTask && gateContext) {
      const targetFiles: string[] = Array.isArray(args.targetFiles) ? args.targetFiles : [];
      const hasValidated = Boolean(gateContext.hasValidatedHypothesis);
      const risk = gateContext.risk || 'R2';
      const isHighRisk = gateContext.taskClass === 'security' || ['R3', 'R4', 'R5'].includes(risk);
      const evidenceThreshold = Math.max(1, gateContext.evidenceThreshold || (isHighRisk ? 5 : risk === 'R2' ? 3 : 2));
      const evidenceScore = Number(gateContext.evidenceScore || 0);

      const inspectedFiles = (gateContext.inspectedFiles || []).map((f: string) => f.replace(/\\/g, '/').toLowerCase());
      const allTargetsInspected = targetFiles.length > 0 && targetFiles.every((t: string) =>
        inspectedFiles.includes(t.replace(/\\/g, '/').toLowerCase())
      );

      if (!hasValidated && evidenceScore < evidenceThreshold && !allTargetsInspected) {
        const diag: ToolFailureDiagnosis = {
          category: 'PRE_MUTATION_GATE_BLOCKED',
          message: `[UNVERIFIED_MUTATION_BLOCKED]: Cổng Pareto chặn "run_node_script" vì mức độ chắc chắn chưa đạt ngưỡng (evidence ${evidenceScore}/${evidenceThreshold}, risk ${risk}). Cần khảo sát code và hình thành giả thuyết được kiểm chứng trước khi thực thi script sửa mã nguồn.`,
          isRetryable: false,
          maxRetries: 0,
          backoffMs: 0,
          recoveryAction: 'Khảo sát mã nguồn với read_file / grep_search và ghi nhận giả thuyết với formulate_and_verify_hypothesis trước khi chạy script sửa file.',
          suggestedAlternative: 'read_file',
        };
        return {
          success: false,
          is_error: true,
          errorCode: 'UNVERIFIED_MUTATION_BLOCKED',
          error: diag.message,
          category: diag.category,
          recoveryAction: diag.recoveryAction,
          actionableFix: 'Inspect target files first with read_file or grep_search, and formulate a validated hypothesis before running batch modification scripts.',
          suggestedAlternative: diag.suggestedAlternative,
          guardianDiagnosis: diag,
        };
      }
    }

    // =========================================================================
    // STEP 2: Chuẩn bị môi trường thực thi cách ly (Chain Protection & Consolidation)
    // =========================================================================
    const scratchDir = path.resolve(workspace.rootDir, '.codingagent', 'scratch');
    await fs.mkdir(scratchDir, { recursive: true });

    const scriptFileName = `batch-script-${Date.now()}-${randomUUID().slice(0, 8)}.mjs`;
    const tempScriptPath = path.resolve(scratchDir, scriptFileName);

    const startTime = Date.now();
    const preSnapshot = getGitStatusSnapshot(workspace.rootDir);

    try {
      await fs.writeFile(tempScriptPath, scriptContent, 'utf-8');

      // =========================================================================
      // STEP 3: Thực thi script trong subprocess độc lập với Hard Timeout
      // =========================================================================
      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      try {
        const result = await execFileAsync(process.execPath, [tempScriptPath], {
          cwd: workspace.rootDir,
          timeout: effectiveTimeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          env: {
            ...process.env,
            FORCE_COLOR: '0',
            NODE_ENV: process.env.NODE_ENV || 'development',
          },
        });
        stdout = result.stdout || '';
        stderr = result.stderr || '';
      } catch (execErr: any) {
        stdout = execErr.stdout || '';
        stderr = execErr.stderr || '';
        exitCode = typeof execErr.code === 'number' ? execErr.code : 1;

        // Xử lý Timeout cụ thể (API_TIMEOUT)
        if (execErr.killed || execErr.signal === 'SIGTERM' || execErr.code === 'ETIMEDOUT') {
          const diag: ToolFailureDiagnosis = {
            category: 'API_TIMEOUT',
            message: `Script execution timed out after ${effectiveTimeout}ms. Potential infinite loop or blocking operation detected. Terminated by ToolUseGuardian.`,
            isRetryable: true,
            maxRetries: 1,
            backoffMs: 1500,
            recoveryAction: 'Check for unbounded while/for loops or hanging network/I/O requests, or increase timeoutMs up to 30000ms. Consider decomposing into smaller batches.',
            suggestedAlternative,
          };
          return {
            success: false,
            is_error: true,
            errorCode: 'COMMAND_TIMEOUT',
            error: diag.message,
            category: diag.category,
            recoveryAction: diag.recoveryAction,
            actionableFix: `Check for infinite while/for loops, missing loop termination conditions, or hanging asynchronous calls. If the workload is large, set timeoutMs up to 30000ms or decompose into smaller batches.`,
            suggestedAlternative: diag.suggestedAlternative,
            exitCode: -1,
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000),
            modifiedFiles: [],
            durationMs: Date.now() - startTime,
            guardianDiagnosis: diag,
          };
        }

        // Phân loại lỗi runtime với classifyToolFailure
        const cleanErrorMsg = extractCleanScriptErrorMessage(stderr, execErr);
        const failureDiag = classifyToolFailure('run_node_script', new Error(cleanErrorMsg));
        const recoveryAction = failureDiag.recoveryAction || 'Inspect stderr and syntax in scriptContent before retrying.';
        return {
          success: false,
          is_error: true,
          errorCode: 'SCRIPT_EXECUTION_FAILED',
          error: `Script execution failed with exit code ${exitCode}: ${cleanErrorMsg}`,
          category: failureDiag.category,
          recoveryAction,
          actionableFix: `Inspect the stderr stack trace. Confirm that target files and directories exist, that imported modules are available, and that file permissions allow writes.`,
          suggestedAlternative: failureDiag.suggestedAlternative || suggestedAlternative,
          exitCode,
          stdout: stdout.slice(0, 2000),
          stderr: stderr.slice(0, 2000),
          durationMs: Date.now() - startTime,
          guardianDiagnosis: failureDiag,
        };
      }

      const durationMs = Date.now() - startTime;

      // =========================================================================
      // STEP 4: Modified Files Tracking & Blast Radius Computation
      // =========================================================================
      const postSnapshot = getGitStatusSnapshot(workspace.rootDir);
      const modifiedFilesSet = new Set<string>();

      for (const [file, mtime] of postSnapshot.entries()) {
        if (file.includes('.codingagent/scratch') || file.includes('.codingagent\\scratch')) {
          continue;
        }
        const preMtime = preSnapshot.get(file);
        if (preMtime === undefined || mtime >= startTime - 500) {
          modifiedFilesSet.add(file);
        }
      }

      const modifiedFiles = Array.from(modifiedFilesSet);

      // =========================================================================
      // STEP 5: Error-as-200 Detection & Unmasking (Theo tool-use-guardian)
      // =========================================================================
      const combinedLogs = `${stdout}\n${stderr}`;
      const matchedPattern = ERROR_AS_200_PATTERNS.find((re) => re.test(combinedLogs));

      if (matchedPattern && (stderr.trim().length > 0 || modifiedFiles.length === 0)) {
        const match = combinedLogs.match(matchedPattern);
        const errorSnippet = match ? match[0] : 'Unhandled error detected in output';
        const diag: ToolFailureDiagnosis = {
          category: 'ERROR_AS_200',
          message: `Script returned exit code 0 but emitted unhandled error in output: "${errorSnippet}".`,
          isRetryable: false,
          maxRetries: 0,
          backoffMs: 0,
          recoveryAction: 'Inspect stderr and stdout. Ensure try/catch blocks do not swallow fatal errors, and fix the underlying exception.',
          suggestedAlternative,
          errorAs200Unmasked: true,
        };
        return {
          success: false,
          is_error: true,
          errorCode: 'ERROR_AS_200',
          category: diag.category,
          error: diag.message,
          errorAs200Unmasked: true,
          recoveryAction: diag.recoveryAction,
          actionableFix: `The script printed fatal errors/exceptions but exited with code 0. Remove swallowed try/catch blocks or call process.exit(1) on failure. Error detected: "${errorSnippet}".`,
          suggestedAlternative: diag.suggestedAlternative,
          exitCode: 0,
          stdout: stdout.slice(0, 2000),
          stderr: stderr.slice(0, 2000),
          modifiedFiles,
          durationMs,
          guardianDiagnosis: diag,
        };
      }

      // =========================================================================
      // STEP 6: Blast Radius & Result Formation (Theo tool-design Response Format)
      // =========================================================================
      let blastRadius: any = undefined;
      if (modifiedFiles.length > 0) {
        invalidateTopologyCache();

        let maxRisk: ImpactRiskLevel = 'LOW';
        const allConsumers = new Set<string>();
        const allTestSuites = new Set<string>();

        for (const file of modifiedFiles.slice(0, 5)) {
          try {
            const blast = calculateComprehensiveBlastRadius({ workspace, filePath: file });
            if (riskWeight(blast.risk) > riskWeight(maxRisk)) {
              maxRisk = blast.risk;
            }
            blast.directConsumers?.forEach((c) => allConsumers.add(c));
            blast.impactedTestSuites?.forEach((t) => allTestSuites.add(t));
          } catch {
            // File không thuộc topology code -> bỏ qua
          }
        }

        if (responseFormat === 'concise') {
          // Định dạng súc tích: Chỉ giữ thông tin cốt lõi để tiết kiệm token
          blastRadius = {
            risk: maxRisk,
            totalFilesModified: modifiedFiles.length,
          };
        } else {
          // Định dạng chi tiết: Đầy đủ đồ thị blast radius
          blastRadius = {
            risk: maxRisk,
            totalFilesModified: modifiedFiles.length,
            sampleModifiedFiles: modifiedFiles.slice(0, 10),
            directConsumers: Array.from(allConsumers).slice(0, 5),
            impactedTestSuites: Array.from(allTestSuites).slice(0, 3),
          };
        }
      }

      const summary = modifiedFiles.length > 0
        ? `Batch script executed successfully. Modified ${modifiedFiles.length} file(s).`
        : 'Batch script executed successfully. No workspace files were modified.';

      const guidance = modifiedFiles.length > 0
        ? `Modified ${modifiedFiles.length} file(s). Recommended next step: run "get_diagnostics" or targeted tests to verify changes.`
        : 'No files were modified. Verify script selector logic if file changes were intended.';

      // Xử lý Response Format Optimization theo tool-design
      if (responseFormat === 'concise') {
        const conciseStdout = stdout.length > 300
          ? `${stdout.slice(0, 150)}\n... [truncated ${stdout.length - 300} chars for token efficiency; use responseFormat: "detailed" for full logs] ...\n${stdout.slice(-150)}`
          : stdout;

        const displayedFiles = modifiedFiles.length <= 10
          ? modifiedFiles
          : modifiedFiles.slice(0, 10);

        return {
          success: true,
          exitCode: 0,
          summary,
          guidance,
          totalModifiedFiles: modifiedFiles.length,
          modifiedFiles: displayedFiles,
          ...(modifiedFiles.length > 10 ? { omittedFilesCount: modifiedFiles.length - 10 } : {}),
          durationMs,
          blastRadius,
          stdout: conciseStdout,
        };
      }

      // Detailed Response Format
      return {
        success: true,
        exitCode: 0,
        summary,
        description: scriptDesc,
        guidance,
        totalModifiedFiles: modifiedFiles.length,
        modifiedFiles,
        durationMs,
        blastRadius,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 4000),
      };
    } finally {
      // Dọn dẹp file script tạm an toàn
      await fs.unlink(tempScriptPath).catch(() => {});
    }
  },
};
