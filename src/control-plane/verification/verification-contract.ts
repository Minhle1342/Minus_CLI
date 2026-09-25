import type {
  VerificationContract,
  VerificationCheck,
  AcceptanceCriterion,
  VerificationInvariant,
  RiskLevel,
} from '../control-plane-state.js';

export interface CreateContractOptions {
  taskId: string;
  taskGoal: string;
  userRequest?: string;
  riskLevel?: RiskLevel;
  changedFiles?: string[];
  testFiles?: string[];
  registeredFiles?: string[];
}

export class VerificationContractFactory {
  /**
   * Derives a structured VerificationContract from task inputs, risk profile, and codebase context.
   */
  static createContract(options: CreateContractOptions): VerificationContract {
    const {
      taskId,
      taskGoal,
      userRequest = '',
      riskLevel = 'STANDARD',
      changedFiles = [],
      testFiles = [],
    } = options;

    const acceptanceCriteria: AcceptanceCriterion[] = [
      {
        id: 'AC1',
        description: `Task goal satisfied: ${taskGoal.slice(0, 100)}`,
        satisfied: false,
        supportingEvidenceIds: [],
      },
    ];

    const invariants: VerificationInvariant[] = [
      {
        id: 'INV_COMPILER_SYNTAX',
        name: 'Compiler and Syntax Integrity',
        description: 'Zero unresolved syntax, compiler, NameError, or missing import diagnostics.',
        enforced: true,
      },
      {
        id: 'INV_FRESH_EVIDENCE',
        name: 'Evidence Freshness',
        description: 'All verification evidence must be fresh and generated after the latest workspace mutation.',
        enforced: true,
      },
    ];

    const requiredChecks: VerificationCheck[] = [
      {
        id: 'CHK_DIAGNOSTICS',
        name: 'Workspace Diagnostics Check',
        kind: 'diagnostic',
        required: true,
        description: 'Inspect LSP and syntax diagnostics for zero introduced errors.',
      },
    ];

    // Add targeted or regression test checks
    if (riskLevel === 'MINIMAL') {
      // Minimal task: diagnostics + basic inspection
      requiredChecks.push({
        id: 'CHK_TARGETED_INSPECTION',
        name: 'Targeted Verification',
        kind: 'diff',
        required: true,
        description: 'Inspect git diff to confirm only intended changes were made.',
      });
    } else {
      // Standard / High Risk / Critical: Require test execution
      requiredChecks.push({
        id: 'CHK_TEST_EXECUTION',
        name: 'Automated Test Suite Verification',
        kind: 'test',
        required: true,
        targetFiles: testFiles.length > 0 ? testFiles : undefined,
        description: 'Execute unit/integration test suite to empirically prove behavior.',
      });

      if (riskLevel === 'HIGH_RISK' || riskLevel === 'CRITICAL') {
        requiredChecks.push({
          id: 'CHK_REGRESSION_SCOPE',
          name: 'Broad Regression Verification',
          kind: 'test',
          required: true,
          description: 'Execute full repository regression checks to prevent unintended side effects.',
        });
      }
    }

    return {
      contractId: `contract_${taskId}`,
      taskGoal,
      riskLevel,
      acceptanceCriteria,
      invariants,
      requiredChecks,
      regressionScope: {
        checkEntireProject: riskLevel === 'HIGH_RISK' || riskLevel === 'CRITICAL',
        targetedPaths: changedFiles,
      },
      prohibitedOutcomes: [
        'Unresolved compiler or syntax errors',
        'Stale verification evidence claims',
        'Unrelated file mutations outside scope',
      ],
    };
  }
}
