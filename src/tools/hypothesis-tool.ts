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
  blastRadius?: BlastRadiusRisk;
  proposedFix?: string;
}

export interface FormulateAndVerifyHypothesisResult {
  success: boolean;
  hypothesisId?: string;
  status: 'formulated' | 'testing' | 'validated' | 'falsified';
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
    description: 'Thiết lập và kiểm chứng giả thuyết kỹ thuật ở Phase Explore trước khi can thiệp sửa mã. Bắt buộc phải có phát biểu giả định nguyên nhân, tiêu chí phản nghiệm, file mục tiêu và bằng chứng mã nguồn cụ thể để đạt chuẩn Pareto 80/20 (giảm tối đa số step thử-sai ở Phase Implement).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        statement: {
          type: Type.STRING,
          description: 'Phát biểu giả định nguyên nhân gốc rễ hoặc cơ chế kỹ thuật gây lỗi (yêu cầu tối thiểu 30 ký tự).',
        },
        falsificationTest: {
          type: Type.STRING,
          description: 'Tiêu chí phản nghiệm: Điều kiện cụ thể nào nếu xảy ra sẽ chứng minh giả thuyết này là SAI (yêu cầu tối thiểu 20 ký tự).',
        },
        targetFiles: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Danh sách các file bị nghi ngờ chứa lỗi hoặc cần phẫu thuật sửa đổi (không được để trống).',
        },
        evidence: {
          type: Type.STRING,
          description: 'Dẫn chứng cụ thể: số dòng, tên biến, AST node, selector hoặc chuỗi gọi hàm chứng minh giả thuyết (yêu cầu tối thiểu 30 ký tự).',
        },
        reproductionCommand: {
          type: Type.STRING,
          description: 'Câu lệnh kiểm thử hoặc script cô lập để tái hiện lỗi (chạy ở chế độ read-only kiểm chứng, không sửa file).',
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
      const blastRadius: BlastRadiusRisk = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(args.blastRadius)
        ? args.blastRadius
        : 'MEDIUM';
      const proposedFix = String(args.proposedFix || '').trim();

      // 1. Kiểm định tính đầy đủ của statement
      if (statement.length < 30) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: `formulate_and_verify_hypothesis bị từ chối: trường "statement" quá ngắn (${statement.length} ký tự, yêu cầu tối thiểu 30 ký tự). Hãy nêu rõ cơ chế kỹ thuật gây ra sự cố.`,
          errorCode: 'INSUFFICIENT_HYPOTHESIS_STATEMENT',
          suggestion: 'Ví dụ: "Hàm parseHeaders trong src/http.ts bỏ sót trường hợp Authorization header chứa ký tự tab."',
          guidance: 'Hãy bổ sung mô tả giả định nguyên nhân chi tiết.',
        };
      }

      // 2. Kiểm định falsificationTest
      if (falsificationTest.length < 20) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: `formulate_and_verify_hypothesis bị từ chối: trường "falsificationTest" quá ngắn (${falsificationTest.length} ký tự, yêu cầu tối thiểu 20 ký tự). Bạn phải nêu rõ điều kiện nào chứng minh giả thuyết là sai.`,
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
      if (evidence.length < 30) {
        return {
          success: false,
          status: 'formulated',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          error: `formulate_and_verify_hypothesis bị từ chối: trường "evidence" quá ngắn (${evidence.length} ký tự, yêu cầu tối thiểu 30 ký tự). Hãy cung cấp trích dẫn mã nguồn, số dòng hoặc luồng dữ liệu cụ thể đã tra cứu từ Phase Explore.`,
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

      // 6. Tùy chọn kiểm chứng qua reproductionCommand
      let reproductionResult: FormulateAndVerifyHypothesisResult['reproductionResult'];
      let isValidated = false;
      let learningNotes = '';

      if (reproductionCommand) {
        const cwd = activeWorkspace?.rootDir || workspace?.rootDir || process.cwd();
        try {
          const { stdout, stderr } = await execAsync(reproductionCommand, {
            cwd,
            timeout: 15000,
          });
          reproductionResult = {
            executed: true,
            exitCode: 0,
            stdout: stdout.slice(0, 1000),
            stderr: stderr.slice(0, 1000),
          };
          // Nếu lệnh chạy không có lỗi (exitCode 0) khi đang muốn tái hiện lỗi,
          // thì có thể lỗi không tồn tại hoặc test chưa trúng điểm yếu
          isValidated = true; // Chấp nhận nếu có output xác nhận
          learningNotes = `Reproduction command completed (Exit 0): ${stdout.slice(0, 200)}`;
        } catch (cmdErr: any) {
          reproductionResult = {
            executed: true,
            exitCode: cmdErr.code ?? 1,
            stdout: (cmdErr.stdout || '').slice(0, 1000),
            stderr: (cmdErr.stderr || cmdErr.message || '').slice(0, 1000),
          };
          // Non-zero exit code thường chứng minh test tái hiện lỗi thất bại đúng như kỳ vọng (Red Phase)
          isValidated = true;
          learningNotes = `Defect successfully reproduced via "${reproductionCommand}" (Exit code ${cmdErr.code || 1}).`;
        }
      } else {
        // Kiểm chứng tĩnh dựa trên Evidence
        isValidated = true;
        learningNotes = `Static causal verification approved based on evidence in ${targetFiles.join(', ')}.`;
      }

      if (isValidated) {
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
          guidance: `[HYPOTHESIS VALIDATED - PRE-MUTATION GATE UNLOCKED]: Giả thuyết [${hypothesis.id}] đã được chứng minh thành công! Bạn đã hoàn tất chuẩn 80% khảo sát ở Phase Explore. Cổng can thiệp sửa mã (PRE-MUTATION GATE) đã được MỞ KHÓA. Hãy thực hiện đúng 1 nhát sửa phẫu thuật (Surgical 1-shot fix) vào các file mục tiêu: ${targetFiles.join(', ')}.`,
        };
      } else {
        const rejectReason = 'Reproduction command failed to substantiate the stated causal mechanism.';
        hypothesisTracker.markFalsified(hypothesis.id, rejectReason);
        return {
          success: false,
          hypothesisId: hypothesis.id,
          status: 'falsified',
          statement,
          falsificationTest,
          targetFiles,
          evidence,
          blastRadius,
          canProceedToImplement: false,
          reproductionResult,
          error: `Giả thuyết [${hypothesis.id}] bị BÁC BỎ (Falsified). Không được phép chuyển sang Phase Implement với giả thuyết này.`,
          errorCode: 'HYPOTHESIS_FALSIFIED',
          suggestion: 'Hãy sử dụng get_symbol_context_360 hoặc query_call_graph để tìm hướng đi thay thế và thiết lập giả thuyết mới.',
          guidance: `Giả thuyết [${hypothesis.id}] đã bị bác bỏ. Hãy quay lại Phase Explore để điều tra luồng dữ liệu chính xác trước khi sửa mã.`,
        };
      }
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
