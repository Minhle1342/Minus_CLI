import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@google/genai';
import type { ToolRegistry } from './registry.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import type { Workspace } from '../workspace/workspace.js';
import { HypothesisTracker, type BlastRadiusRisk, type Hypothesis } from '../agent/hypothesis-tracker.js';

const execAsync = promisify(exec);

export interface FormulateAndVerifyHypothesisArgs {
  statement: string;
  falsificationTest: string;
  targetFiles: string[];
  evidence: string;
  reproductionCommand?: string;
  expectedOutcome?: 'pass' | 'fail';
  blastRadius?: BlastRadiusRisk;
  proposedFix?: string;
}

export interface FormulateAndVerifyHypothesisResult {
  success: boolean;
  hypothesisId?: string;
  status: 'formulated' | 'testing' | 'supported' | 'validated' | 'falsified';
  statement: string;
  falsificationTest: string;
  targetFiles: string[];
  evidence: string;
  blastRadius: BlastRadiusRisk;
  canProceedToImplement: boolean;
  reproductionResult?: {
    executed: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  learning?: string;
  guidance: string;
  error?: string;
  errorCode?: string;
  suggestion?: string;
}

/**
 * createHypothesisTool - Active Hypothesis Verification Primitive (Pareto 80/20)
 * 
 * Cho phép LLM chủ động thiết lập và kiểm chứng giả thuyết kỹ thuật ở Phase Explore:
 * 1. Thu thập bằng chứng mã nguồn (Evidence Trace) và tiêu chí phản nghiệm (Falsification Criteria).
 * 2. Tùy chọn chạy lệnh tái hiện lỗi (Reproduction Test) cô lập không sửa code.
 * 3. Chỉ khi giả thuyết được kiểm chứng (Validated), cổng chuyển pha mới cho phép can thiệp sửa mã (Phase Implement).
 */
export function createHypothesisTool(
  tracker?: HypothesisTracker,
  workspace?: Workspace,
): ToolDefinition {
  const hypothesisTracker = tracker || new HypothesisTracker();

  return {
    name: 'formulate_and_verify_hypothesis',
    description: 'Ghi nhận giả thuyết kỹ thuật có thể phản nghiệm. Evidence tĩnh chỉ tạo trạng thái supported; chỉ kết quả thực thi khớp expectedOutcome mới tạo trạng thái validated.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        statement: {
          type: Type.STRING,
          description: 'Phát biểu cụ thể về nguyên nhân gốc rễ hoặc cơ chế kỹ thuật gây lỗi.',
        },
        falsificationTest: {
          type: Type.STRING,
          description: 'Điều kiện quan sát được có thể chứng minh giả thuyết này sai.',
        },
        targetFiles: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Danh sách các file bị nghi ngờ chứa lỗi hoặc cần phẫu thuật sửa đổi (không được để trống).',
        },
        evidence: {
          type: Type.STRING,
          description: 'Dẫn chứng cụ thể: số dòng, tên biến, AST node, selector, failing test hoặc chuỗi gọi hàm.',
        },
        reproductionCommand: {
          type: Type.STRING,
          description: 'Câu lệnh kiểm thử hoặc script cô lập để tái hiện lỗi (chạy ở chế độ read-only kiểm chứng, không sửa file).',
        },
        expectedOutcome: {
          type: Type.STRING,
          enum: ['pass', 'fail'],
          description: 'Kết quả mong đợi của reproductionCommand. Mặc định là fail cho bài test tái hiện lỗi trước khi sửa.',
        },
        blastRadius: {
          type: Type.STRING,
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          description: 'Mức độ rủi ro tác động tính toán từ tool analyze_impact (mặc định: MEDIUM).',
        },
        proposedFix: {
          type: Type.STRING,
          description: 'Định hướng giải pháp phẫu thuật tối thiểu (Surgical Fix) nếu giả thuyết đúng.',
        },
      },
      required: ['statement', 'falsificationTest', 'targetFiles', 'evidence'],
    },
    execute: async (
      args: Record<string, any>,
      ws?: Workspace,
      context?: ToolExecutionContext,
    ): Promise<FormulateAndVerifyHypothesisResult> => {
      const activeWorkspace = ws || workspace;
      const statement = String(args.statement || '').trim();
      const falsificationTest = String(args.falsificationTest || '').trim();
      const targetFiles: string[] = Array.isArray(args.targetFiles)
        ? args.targetFiles.map((f: any) => String(f).trim()).filter(Boolean)
        : [];
      const evidence = String(args.evidence || '').trim();
      const reproductionCommand = typeof args.reproductionCommand === 'string' ? args.reproductionCommand.trim() : undefined;
      const expectedOutcome: 'pass' | 'fail' = args.expectedOutcome === 'pass' ? 'pass' : 'fail';
      const blastRadius: BlastRadiusRisk = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(args.blastRadius)
        ? args.blastRadius
        : 'MEDIUM';
      const proposedFix = String(args.proposedFix || '').trim();

      // Validate semantic presence. Length quotas encouraged filler without
      // improving evidence quality, so they are intentionally not used.
      if (!statement) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: 'formulate_and_verify_hypothesis bị từ chối: trường "statement" không được để trống.',
          errorCode: 'INSUFFICIENT_HYPOTHESIS_STATEMENT',
          suggestion: 'Ví dụ: "Hàm parseHeaders trong src/http.ts bỏ sót trường hợp Authorization header chứa ký tự tab."',
          guidance: 'Hãy bổ sung mô tả giả định nguyên nhân chi tiết.',
        };
      }

      // 2. Kiểm định falsificationTest
      if (!falsificationTest) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: 'formulate_and_verify_hypothesis bị từ chối: trường "falsificationTest" không được để trống.',
          errorCode: 'INSUFFICIENT_FALSIFICATION_CRITERIA',
          suggestion: 'Ví dụ: "Nếu giá trị header.trim() không làm thay đổi chuỗi ban đầu thì giả thuyết không đúng."',
          guidance: 'Hãy bổ sung tiêu chuẩn phản nghiệm rõ ràng.',
        };
      }

      // 3. Kiểm định targetFiles
      if (targetFiles.length === 0) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: 'formulate_and_verify_hypothesis bị từ chối: trường "targetFiles" không được để trống. Hãy cung cấp ít nhất một file cụ thể.',
          errorCode: 'MISSING_TARGET_FILES',
          suggestion: 'Ví dụ: ["src/http.ts"]',
          guidance: 'Xác định rõ các file dự kiến cần can thiệp.',
        };
      }

      // 4. Kiểm định evidence
      if (!evidence) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: 'formulate_and_verify_hypothesis bị từ chối: trường "evidence" không được để trống.',
          errorCode: 'INSUFFICIENT_EVIDENCE',
          suggestion: 'Ví dụ: "Dòng 45 trong src/http.ts dùng regex /^Bearer / nhưng không xử lý whitespace."',
          guidance: 'Thu thập bằng chứng thực tế từ get_symbol_context_360 hoặc view_file trước.',
        };
      }

      // 5. Đăng ký giả thuyết vào HypothesisTracker
      const hypothesis = hypothesisTracker.formulate({
        statement,
        falsificationTest,
        targetFiles,
        blastRadius,
        proposedFix,
      });

      hypothesisTracker.markTesting(hypothesis.id);

      // 6. Tùy chọn kiểm chứng qua reproductionCommand. Static evidence can
      // support a causal explanation, but only an observed command outcome can
      // empirically validate it.
      let reproductionResult: FormulateAndVerifyHypothesisResult['reproductionResult'];

      if (reproductionCommand) {
        const cwd = activeWorkspace?.rootDir || workspace?.rootDir || process.cwd();
        let exitCode = 0;
        let stdout = '';
        let stderr = '';
        let executionFailure: string | undefined;
        try {
          const completed = await execAsync(reproductionCommand, {
            cwd,
            timeout: 15000,
          });
          stdout = completed.stdout;
          stderr = completed.stderr;
        } catch (cmdErr: any) {
          exitCode = typeof cmdErr.code === 'number' ? cmdErr.code : 1;
          stdout = cmdErr.stdout || '';
          stderr = cmdErr.stderr || cmdErr.message || '';
          if (
            cmdErr.killed
            || cmdErr.signal
            || typeof cmdErr.code !== 'number'
            || /(?:not recognized as an internal|command not found|cannot find the (?:file|path)|enoent)/i.test(stderr)
          ) {
            executionFailure = stderr || 'The reproduction process could not be executed reliably.';
          }
        }

        reproductionResult = {
          executed: true,
          exitCode,
          stdout: stdout.slice(0, 1000),
          stderr: stderr.slice(0, 1000),
        };
        if (executionFailure) {
          return {
            success: false,
            hypothesisId: hypothesis.id,
            status: 'testing',
            statement,
            falsificationTest,
            targetFiles,
            evidence,
            blastRadius,
            canProceedToImplement: false,
            reproductionResult,
            error: `Không thể dùng reproductionCommand làm bằng chứng: ${executionFailure.slice(0, 500)}`,
            errorCode: 'REPRODUCTION_EXECUTION_FAILED',
            suggestion: 'Sửa môi trường hoặc câu lệnh để quá trình kiểm chứng thực sự khởi chạy, rồi thử lại.',
            guidance: `Giả thuyết [${hypothesis.id}] chưa được kiểm chứng vì lệnh không chạy đáng tin cậy.`,
          };
        }
        const outcomeMatched = expectedOutcome === 'pass' ? exitCode === 0 : exitCode !== 0;
        if (!outcomeMatched) {
          const observed = exitCode === 0 ? 'pass' : 'fail';
          return {
            success: false,
            hypothesisId: hypothesis.id,
            status: 'testing',
            statement,
            falsificationTest,
            targetFiles,
            evidence,
            blastRadius,
            canProceedToImplement: false,
            reproductionResult,
            error: `Kết quả reproductionCommand không khớp kỳ vọng: expected=${expectedOutcome}, observed=${observed} (exit ${exitCode}).`,
            errorCode: 'REPRODUCTION_OUTCOME_MISMATCH',
            suggestion: 'Kiểm tra lại test tái hiện, expectedOutcome và dữ liệu đầu vào trước khi kết luận về cơ chế nguyên nhân.',
            guidance: `Giả thuyết [${hypothesis.id}] vẫn đang được kiểm tra. Kết quả lệnh chưa cung cấp bằng chứng thực nghiệm theo tiêu chí đã khai báo.`,
          };
        }

        const learningNotes = `Observed expected ${expectedOutcome} outcome from "${reproductionCommand}" (exit ${exitCode}).`;
        hypothesisTracker.markValidated(hypothesis.id, learningNotes);
        return {
          success: true,
          hypothesisId: hypothesis.id,
          status: 'validated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: true,
          reproductionResult,
          learning: learningNotes,
          guidance: `[HYPOTHESIS VALIDATED]: Kết quả thực thi khớp tiêu chí đã khai báo cho giả thuyết [${hypothesis.id}]. Có thể chuyển sang thay đổi tối thiểu cần thiết trong: ${targetFiles.join(', ')}.`,
        };
      }

      const learningNotes = `Static evidence supports the causal hypothesis in ${targetFiles.join(', ')}; empirical reproduction has not been run.`;
      hypothesisTracker.markSupported(hypothesis.id, learningNotes);
      return {
        success: true,
        hypothesisId: hypothesis.id,
        status: 'supported',
        statement,
        falsificationTest,
        targetFiles,
        evidence,
        blastRadius,
        canProceedToImplement: blastRadius === 'LOW' || blastRadius === 'MEDIUM',
        learning: learningNotes,
        guidance: `[HYPOTHESIS SUPPORTED]: Bằng chứng tĩnh ủng hộ giả thuyết [${hypothesis.id}]. Thay đổi rủi ro thấp có thể dùng fast path nếu target đã được kiểm tra và evidence gate đạt ngưỡng; thay đổi rủi ro cao cần reproductionCommand cho bằng chứng thực nghiệm.`,
      };
    },
  };
}

export function registerHypothesisTool(
  registry: ToolRegistry,
  tracker?: HypothesisTracker,
  workspace?: Workspace,
): void {
  registry.register(createHypothesisTool(tracker, workspace));
}
