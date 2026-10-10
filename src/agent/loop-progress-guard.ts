import { isVerificationCommand } from './completion-evidence.js';
import { isMutationTool } from '../tools/diff-generator.js';
import { hasObservedMutation, toolResultFailed } from './completion-observations.js';
import {
  deterministicBlockCode,
  deterministicBlockFingerprint,
  deterministicRemediation,
} from '../tools/deterministic-failure-dedup.js';

export interface ToolProgressObservation {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
}

export interface ToolProgressDecision {
  repetitionCount: number;
  message?: string;
  shouldStop: boolean;
}

interface SeenObservation {
  resultFingerprint: string;
  repetitionCount: number;
}

const WORKSPACE_MUTATING_TOOLS = new Set([
  'write_file',
  'replace_text',
  'apply_patch',
  'create_file',
  'delete_file',
  'move_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_worktree',
  'remove_worktree',
  'git_commit',
  'git_add',
  'git_push',
]);

const GUARDED_INSPECTION_TOOLS = new Set([
  'list_files',
  'read_file',
  'search_text',
  'search_codebase_fast',
  'web_search',
  'read_compressed_code',
  'pack_codebase',
  'read_memory',
  'git_status',
  'list_worktrees',
  'submit_solution',
  'inspect_symbol',
  'find_references',
  'get_diagnostics',
]);

export interface TrajectoryOscillationStatus {
  isOscillating: boolean;
  message?: string;
  affectedFiles?: string[];
  oscillationType?: 'ping-pong' | 'hyper-mutation';
}

/**
 * Detects successful tool calls that repeatedly return the same observation,
 * as well as alternating Ping-Pong loops (e.g. submit_solution <-> run_command),
 * and Semantic Oscillation in File Mutations (Trajectory Dysregulation - Life-Harness 2026).
 * State is intentionally scoped to one live turn and reset before each run.
 */
export class LoopProgressGuard {
  private readonly seen = new Map<string, SeenObservation>();
  private readonly callHistory: Array<{ toolName: string; callFingerprint: string }> = [];
  private readonly fileMutationHistory: Array<{ file: string; toolName: string; timestamp: number; fingerprint?: string }> = [];
  /** Đếm lặp cho deterministic blocks (được guard dù là failure). */
  private readonly deterministicBlocks = new Map<string, number>();

  reset(): void {
    this.seen.clear();
    this.callHistory.length = 0;
    this.fileMutationHistory.length = 0;
    this.deterministicBlocks.clear();
  }

  observe(observation: ToolProgressObservation): ToolProgressDecision {
    const { toolName, args, result } = observation;

    // Deterministic infra/policy blocks (ISOLATED_SANDBOX_REQUIRED, ...): retry
    // y hệt trong cùng turn mà state không đổi là vô ích → guard riêng với
    // remediation cụ thể. Check trước isFailure vì blocked_preflight được tính
    // là non-failing theo thiết kế (command-outcome.ts) nhưng vẫn lặp vô ích.
    const blockCode = deterministicBlockCode(result);
    if (blockCode) {
      return this.recordDeterministicBlock(toolName, args, blockCode);
    }

    const isFailure = toolResultFailed(result);
    if (isFailure) {
      return { repetitionCount: 0, shouldStop: false };
    }

    // Pure verification run_commands (e.g. npm test, npm run build, pytest) are treated as guarded observations rather than workspace mutations
    const isPureVerification = toolName === 'run_command' && isVerificationCommand(args.command);
    const verified = (isPureVerification && result.exitCode === 0 && !result.isBackgroundTask && result.processStarted !== false)
      || (toolName === 'get_diagnostics' && result.clean === true && !result.totalErrors)
      || (toolName === 'run_test_suite' && result.exitCode === 0 && result.isPassed === true && !args.useScratchWorkspace);

    // Ghi nhận verification command để giải tỏa cảnh báo hyper-mutation
    if (verified) this.fileMutationHistory.length = 0;

    if (WORKSPACE_MUTATING_TOOLS.has(toolName) || isMutationTool(toolName) || hasObservedMutation(toolName, result)) {
      // Ghi nhận file mutation vào quỹ đạo Trajectory
      const rawFile = String(args.path || args.filePath || args.TargetFile || args.targetFile || args.file || '').trim();
      if (rawFile) {
        const normalizedFile = rawFile.replace(/\\/g, '/').toLowerCase();
        this.fileMutationHistory.push({
          file: normalizedFile,
          toolName,
          timestamp: Date.now(),
          fingerprint: mutationFingerprint(args, result),
        });
        if (this.fileMutationHistory.length > 10) {
          this.fileMutationHistory.shift();
        }

        // Kiểm tra Semantic Oscillation (Trajectory Dysregulation - Life-Harness 2026)
        const osc = this.checkSemanticOscillation();
        if (osc.isOscillating) {
          this.seen.clear();
          this.callHistory.length = 0;
          return {
            repetitionCount: 2,
            message: osc.message,
            shouldStop: false,
          };
        }
      }

      this.seen.clear();
      this.callHistory.length = 0;
      return { repetitionCount: 0, shouldStop: false };
    }

    if (!GUARDED_INSPECTION_TOOLS.has(toolName) && !isPureVerification && toolName !== 'run_command') {
      return { repetitionCount: 0, shouldStop: false };
    }

    const callFingerprint = stableStringify({ toolName, args });
    const resultFingerprint = stableStringify(withoutTransientMetadata(result));

    // Track alternating call patterns (e.g. A -> B -> A -> B -> A -> B)
    this.callHistory.push({ toolName, callFingerprint });
    if (this.callHistory.length > 8) this.callHistory.shift();

    const alternatingDecision = this.checkAlternatingLoop();
    if (alternatingDecision.shouldStop) {
      return alternatingDecision;
    }

    return this.recordObservation(callFingerprint, resultFingerprint, toolName);
  }

  /**
   * Phát hiện dao động con thoi (Ping-Pong Mutation) và đột biến quá mức trên 1 file (Hyper-Mutation)
   */
  checkSemanticOscillation(): TrajectoryOscillationStatus {
    const validMutations = this.fileMutationHistory.filter((m) => m.file !== '__verification__');
    const len = validMutations.length;
    if (len < 4) {
      return { isOscillating: false };
    }

    // Mẫu 1: Ping-Pong Mutation giữa 2 file (A -> B -> A -> B)
    const m0 = validMutations[len - 4].file;
    const m1 = validMutations[len - 3].file;
    const m2 = validMutations[len - 2].file;
    const m3 = validMutations[len - 1].file;

    if (m0 === m2 && m1 === m3 && m0 !== m1
      && validMutations[len - 4].fingerprint !== undefined && validMutations[len - 3].fingerprint !== undefined
      && validMutations[len - 4].fingerprint === validMutations[len - 2].fingerprint
      && validMutations[len - 3].fingerprint === validMutations[len - 1].fingerprint) {
      return {
        isOscillating: true,
        affectedFiles: [m0, m1],
        oscillationType: 'ping-pong',
        message: `[TRAJECTORY DYSREGULATION INTERVENTION]: Repeated artifact-identical edits between "${m0}" and "${m1}" show no new progress. Reassess the active task and existing evidence; continue only work and verification authorized by the user.`,
      };
    }

    // Mẫu 2: Hyper-Mutation trên 1 file đơn lẻ (4 lần sửa liên tiếp mà không có bước kiểm thử xác minh)
    const lastFour = this.fileMutationHistory.slice(-4);
    if (lastFour.length === 4 && !lastFour.some((m) => m.file === '__verification__')) {
      const targetFile = lastFour[0].file;
      const allSame = lastFour[0].fingerprint !== undefined && lastFour.every((m) => m.file === targetFile && m.fingerprint === lastFour[0].fingerprint);
      if (allSame) {
        return {
          isOscillating: true,
          affectedFiles: [targetFile],
          oscillationType: 'hyper-mutation',
          message: `[TRAJECTORY DYSREGULATION INTERVENTION]: File "${targetFile}" received four artifact-identical edits with no new progress. Review the actual content and use the smallest verification permitted by the task scope.`,
        };
      }
    }

    return { isOscillating: false };
  }

  private checkAlternatingLoop(): ToolProgressDecision {
    const len = this.callHistory.length;

    // 1. Nếu có submit_solution trong cặp xen kẽ, ngắt ngay sau 2 chu kỳ (4 bước) vì giải pháp đã được nộp
    if (len >= 4) {
      const c0 = this.callHistory[len - 4];
      const c1 = this.callHistory[len - 3];
      const c2 = this.callHistory[len - 2];
      const c3 = this.callHistory[len - 1];

      if (
        c0.callFingerprint === c2.callFingerprint
        && c1.callFingerprint === c3.callFingerprint
        && c0.callFingerprint !== c1.callFingerprint
      ) {
        const involvesTerminalSubmission = c0.toolName === 'submit_solution' || c1.toolName === 'submit_solution';
        if (involvesTerminalSubmission) {
          return {
            repetitionCount: 2,
            message: `[SYSTEM LOOP GUARD]: Detected alternating loop between '${c0.toolName}' and '${c1.toolName}'. The verification outcome is already settled; do not repeat these tools. Conclude your work and output the final response now.`,
            shouldStop: true,
          };
        }
      }
    }

    // 2. Đối với các công cụ quan sát/khảo sát thông thường, cho phép tối đa 3 chu kỳ (6 bước) trước khi ngắt hẳn
    if (len >= 6) {
      const c0 = this.callHistory[len - 6];
      const c1 = this.callHistory[len - 5];
      const c2 = this.callHistory[len - 4];
      const c3 = this.callHistory[len - 3];
      const c4 = this.callHistory[len - 2];
      const c5 = this.callHistory[len - 1];

      if (
        c0.callFingerprint === c2.callFingerprint && c2.callFingerprint === c4.callFingerprint
        && c1.callFingerprint === c3.callFingerprint && c3.callFingerprint === c5.callFingerprint
        && c0.callFingerprint !== c1.callFingerprint
      ) {
        return {
          repetitionCount: 3,
          message: `[SYSTEM LOOP GUARD]: Detected alternating loop between '${c0.toolName}' and '${c1.toolName}'. The verification outcome is already settled; do not repeat these tools. Conclude your work and output the final response now.`,
          shouldStop: true,
        };
      }
    }
    return { repetitionCount: 0, shouldStop: false };
  }

  private recordDeterministicBlock(
    toolName: string,
    args: Record<string, any>,
    errorCode: string,
  ): ToolProgressDecision {
    const fingerprint = deterministicBlockFingerprint(toolName, args, errorCode);
    const repetitionCount = (this.deterministicBlocks.get(fingerprint) || 0) + 1;
    this.deterministicBlocks.set(fingerprint, repetitionCount);
    if (repetitionCount < 2) return { repetitionCount, shouldStop: false };

    const message = repetitionCount === 2
      ? `[SYSTEM LOOP GUARD]: The identical ${toolName} call was blocked deterministically (${errorCode}) twice with no state change. ${deterministicRemediation(toolName, errorCode)}`
      : `[SYSTEM LOOP GUARD]: The identical ${toolName} call was blocked deterministically (${errorCode}) ${repetitionCount} times without progress. Change strategy now; repeated failure to change strategy will end the turn with an explicit blocker report.`;

    return { repetitionCount, message, shouldStop: repetitionCount >= 3 };
  }

  private recordObservation(
    callFingerprint: string,
    resultFingerprint: string,
    toolName: string,
  ): ToolProgressDecision {
    const previous = this.seen.get(callFingerprint);
    const repetitionCount = previous?.resultFingerprint === resultFingerprint ? previous.repetitionCount + 1 : 1;
    this.seen.set(callFingerprint, { resultFingerprint, repetitionCount });
    if (repetitionCount < 2) return { repetitionCount, shouldStop: false };

    const message = repetitionCount === 2
      ? `[SYSTEM LOOP GUARD]: The identical ${toolName} call returned the same result twice. Reuse this observation unless relevant content changes. Continue the remaining user-authorized work or provide the established findings.`
      : `[SYSTEM LOOP GUARD]: The identical ${toolName} call returned the same result ${repetitionCount} times without progress. Change strategy now; repeated failure to change strategy will end the turn with an explicit blocker report.`;

    return { repetitionCount, message, shouldStop: repetitionCount >= 3 };
  }
}

function mutationFingerprint(args: Record<string, any>, result: Record<string, any>): string | undefined {
  const content = args.content ?? args.CodeContent ?? args.ReplacementContent ?? args.newText ?? args.patch ?? args.ReplacementChunks;
  const observed = result.contentHash ?? result.afterHash ?? result.diff;
  return observed !== undefined || content !== undefined ? stableStringify(observed ?? content) : undefined;
}

function withoutTransientMetadata(result: Record<string, any>): Record<string, any> {
  const transient = new Set(['timestamp', 'duration', 'durationMs', 'executionTime', '_untrusted_context', 'trajectoryIntervention', 'processFailureIntervention', 'domainIntentIntervention']);
  return Object.fromEntries(Object.entries(result).filter(([key]) => !transient.has(key)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
