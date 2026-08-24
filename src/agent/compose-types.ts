export type ComposePhase =
  | 'GRILL'
  | 'SPEC_DRAFT'
  | 'SPEC_LOCKED'
  | 'WORKSPACE_READY'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'ABORTED';

export type ComposeMatrixStatus = 'PENDING' | 'PASSED' | 'FAILED';

export interface ComposeGrillAnswer {
  id: string;
  question: string;
  answer?: string;
}

export interface ComposeTaskMatrixItem {
  id: string;
  scenario: string;
  command: string;
  expectedExitCode: number;
  expectedOutput?: string;
  status: ComposeMatrixStatus;
  evidenceSummary?: string;
  evidenceSeq?: number;
  verifiedAt?: string;
}

export interface ComposeState {
  version: 1;
  id: string;
  featureName: string;
  objective: string;
  phase: ComposePhase;
  specPath: string;
  specHash?: string;
  worktreeSpecPath?: string;
  worktreePath?: string;
  branch?: string;
  grillQnA: ComposeGrillAnswer[];
  implementationTasks: string[];
  registeredFiles: string[];
  testMatrix: ComposeTaskMatrixItem[];
  evidenceSeq: number;
  lastMutationSeq: number;
  reviewSummary?: string;
  completionSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeGuardDecision {
  allow: boolean;
  reason?: string;
  errorCode?: string;
}

export interface ComposeAdvanceResult {
  state: ComposeState;
  message: string;
  workspaceAction?: { type: 'switch'; path: string };
  completion?: {
    composeId: string;
    featureName: string;
    objective: string;
    specHash: string;
    testEvidence: string[];
    reviewSummary: string;
  };
}
