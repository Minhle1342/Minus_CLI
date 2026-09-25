import { Type } from '@google/genai';
import { ToolDefinition, type ToolExecutionContext } from './types.js';
import { Workspace } from '../workspace/workspace.js';
import { toolError, toolSuccess } from './tool-result.js';
import { TestEngineeringHarness } from '../testing/test-engineering-harness.js';
import { IsolatedExecutionSubstrate } from '../execution/isolated-substrate.js';

/**
 * Tool: run_test_suite
 * 
 * Thực thi bộ kiểm thử tự động của dự án thông qua TestEngineeringHarness và Execution Substrate.
 * Báo cáo chi tiết kết quả từng test case, tự động thẩm định Giả thuyết (Hypothesis) và
 * ghi nhận bằng chứng nghiệm thu thực tế cho CriticGate & CompletionEvidenceGate.
 */
export const runTestSuiteTool: ToolDefinition = {
  name: 'run_test_suite',
  description:
    'Thực thi bộ kiểm thử (Test Suite) của dự án với Test Engineering Harness. ' +
    'Tự động phân tích kết quả test (Jest/Vitest/Mocha/Pytest/Cargo/Go), đồng bộ bằng chứng cho CriticGate ' +
    'và tự động thẩm định trạng thái Giả thuyết (Hypothesis Validation/Falsification).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: {
        type: Type.STRING,
        description: 'Lệnh chạy test cụ thể (vd: "npm test", "npx vitest run", "pytest"). Bỏ trống để tự động nhận diện.',
      },
      hypothesisId: {
        type: Type.STRING,
        description: 'Mã giả thuyết (Hypothesis ID) đang được kiểm chứng thực nghiệm nếu có.',
      },
      useScratchWorkspace: {
        type: Type.BOOLEAN,
        description: 'Nếu true, chạy test trên Ephemeral Scratch Sandbox để cách ly hoàn toàn mà không ảnh hưởng tới workspace.',
      },
      timeoutMs: {
        type: Type.NUMBER,
        description: 'Thời gian chờ tối đa cho bộ test (mặc định: 120,000ms = 2 phút).',
      },
    },
  },
  async execute(args: Record<string, any>, workspace: Workspace, context?: ToolExecutionContext) {
    try {
      const substrate = new IsolatedExecutionSubstrate({
        workspaceRoot: workspace.rootDir,
        policyMode: 'workspace-write',
      });

      const harness = new TestEngineeringHarness({
        workspaceRoot: workspace.rootDir,
        substrate,
      });

      const report = await harness.runTests({
        testCommand: args.command,
        hypothesisId: args.hypothesisId,
        useScratchWorkspace: Boolean(args.useScratchWorkspace),
        timeoutMs: args.timeoutMs,
        signal: context?.signal,
      });

      return toolSuccess({
        framework: report.framework,
        isPassed: report.isPassed,
        totalTests: report.totalTests,
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
        durationMs: report.durationMs,
        exitCode: report.exitCode,
        summary: report.summaryText,
        commandExecuted: report.commandExecuted,
        rawOutputSnippet: report.rawOutput.slice(0, 2000),
      });
    } catch (err: any) {
      return toolError(
        `Lỗi thực thi Test Engineering Harness: ${err.message}`,
        'TEST_HARNESS_FAILURE',
        { command: args.command }
      );
    }
  },
};
