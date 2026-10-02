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
    'Run the project test suite with the Test Engineering Harness. ' +
    'Automatically analyze test results (Jest/Vitest/Mocha/Pytest/Cargo/Go), sync evidence to CriticGate ' +
    'and automatically validate the Hypothesis status (Hypothesis Validation/Falsification).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: {
        type: Type.STRING,
        description: 'Specific test command (e.g. "npm test", "npx vitest run", "pytest"). Leave empty for auto-detection.',
      },
      hypothesisId: {
        type: Type.STRING,
        description: 'Hypothesis ID under experimental verification, if any.',
      },
      useScratchWorkspace: {
        type: Type.BOOLEAN,
        description: 'If true, run tests on an Ephemeral Scratch Sandbox for full isolation without affecting the workspace.',
      },
      timeoutMs: {
        type: Type.NUMBER,
        description: 'Maximum wait time for the test suite (default: 120,000ms = 2 minutes).',
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
        `Test Engineering Harness execution failed: ${err.message}`,
        'TEST_HARNESS_FAILURE',
        { command: args.command }
      );
    }
  },
};
