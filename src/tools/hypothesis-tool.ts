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
    description: 'Record a falsifiable technical hypothesis. Static evidence only yields supported status; only execution results matching expectedOutcome yield validated status.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        statement: {
          type: Type.STRING,
          description: 'Concrete statement of the root cause or technical mechanism behind the bug.',
        },
        falsificationTest: {
          type: Type.STRING,
          description: 'Observable condition that could prove this hypothesis wrong.',
        },
        targetFiles: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of files suspected to contain the bug or needing surgical edits (must not be empty).',
        },
        evidence: {
          type: Type.STRING,
          description: 'Concrete evidence: line numbers, variable names, AST nodes, selectors, failing tests or call chains.',
        },
        reproductionCommand: {
          type: Type.STRING,
          description: 'Isolated test command or script to reproduce the bug (runs in read-only verification mode, does not edit files).',
        },
        expectedOutcome: {
          type: Type.STRING,
          enum: ['pass', 'fail'],
          description: 'Expected result of reproductionCommand. Default is fail for bug-reproduction tests before fixing.',
        },
        blastRadius: {
          type: Type.STRING,
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          description: 'Impact risk level computed from the analyze_impact tool (default: MEDIUM).',
        },
        proposedFix: {
          type: Type.STRING,
          description: 'Minimal surgical-fix direction if the hypothesis is correct.',
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
          error: 'formulate_and_verify_hypothesis rejected: the "statement" field must not be empty.',
          errorCode: 'INSUFFICIENT_HYPOTHESIS_STATEMENT',
          suggestion: 'Example: "parseHeaders in src/http.ts misses the case where the Authorization header contains a tab character."',
          guidance: 'Add a detailed description of the assumed root cause.',
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
          error: 'formulate_and_verify_hypothesis rejected: the "falsificationTest" field must not be empty.',
          errorCode: 'INSUFFICIENT_FALSIFICATION_CRITERIA',
          suggestion: 'Example: "If header.trim() does not change the original string, the hypothesis is wrong."',
          guidance: 'Add a clear falsification criterion.',
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
          error: 'formulate_and_verify_hypothesis rejected: the "targetFiles" field must not be empty. Provide at least one concrete file.',
          errorCode: 'MISSING_TARGET_FILES',
          suggestion: 'Example: ["src/http.ts"]',
          guidance: 'Clearly identify the files expected to need changes.',
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
          error: 'formulate_and_verify_hypothesis rejected: the "evidence" field must not be empty.',
          errorCode: 'INSUFFICIENT_EVIDENCE',
          suggestion: 'Example: "Line 45 in src/http.ts uses regex /^Bearer / but does not handle whitespace."',
          guidance: 'Collect real evidence from get_symbol_context_360 or view_file first.',
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
            error: `Cannot use reproductionCommand as evidence: ${executionFailure.slice(0, 500)}`,
            errorCode: 'REPRODUCTION_EXECUTION_FAILED',
            suggestion: 'Fix the environment or command so the verification actually runs, then retry.',
            guidance: `Hypothesis [${hypothesis.id}] is not verified because the command did not run reliably.`,
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
            error: `reproductionCommand result does not match expectation: expected=${expectedOutcome}, observed=${observed} (exit ${exitCode}).`,
            errorCode: 'REPRODUCTION_OUTCOME_MISMATCH',
            suggestion: 'Re-check the reproduction test, expectedOutcome and input data before concluding the causal mechanism.',
            guidance: `Hypothesis [${hypothesis.id}] is still under test. The command result does not yet provide experimental evidence per the declared criteria.`,
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
          guidance: `[HYPOTHESIS VALIDATED]: Execution result matches the declared criteria for hypothesis [${hypothesis.id}]. May proceed to the minimal required changes in: ${targetFiles.join(', ')}.`,
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
        guidance: `[HYPOTHESIS SUPPORTED]: Static evidence supports hypothesis [${hypothesis.id}]. Low-risk changes may use the fast path if the target has been inspected and the evidence gate meets the threshold; high-risk changes need reproductionCommand for experimental evidence.`,
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
