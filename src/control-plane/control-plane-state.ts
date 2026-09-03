/**
 * Canonical Data Model for the Evidence-Driven Control Plane (EDCP)
 * 
 * "Generation may be probabilistic. Acceptance must be deterministic."
 */

export type RiskLevel = 'MINIMAL' | 'STANDARD' | 'HIGH_RISK' | 'CRITICAL';

export type LifecycleStatus =
  | 'INTAKE'
  | 'BASELINE'
  | 'INVESTIGATE'
  | 'HYPOTHESIZE'
  | 'PLAN_EXPERIMENT'
  | 'MUTATE'
  | 'VERIFY'
  | 'CRITIQUE'
  | 'ACCEPT'
  | 'FALSIFY'
  | 'INCONCLUSIVE'
  | 'PROMOTE_GREEN'
  | 'ROLLBACK'
  | 'PROGRESS_CHECK'
  | 'COMPLETION_CHECK'
  | 'FINALIZE'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'FAILED';

export interface TaskState {
  taskId: string;
  userRequest: string;
  goal: string;
  riskLevel: RiskLevel;
  constraints: string[];
  acceptanceCriteria: string[];
  createdAt: number;
}

export interface ChangedFileState {
  path: string;
  language: string;
  contentHash: string;
  mutationSeq: number;
  isRegistered?: boolean;
  affectedSymbols?: string[];
}

export interface DiagnosticItemSnapshot {
  file: string;
  line: number;
  character?: number;
  code?: string | number;
  message: string;
  category: 'error' | 'warning' | 'info';
  source?: string;
}

export interface DiagnosticSnapshot {
  errors: DiagnosticItemSnapshot[];
  warnings: DiagnosticItemSnapshot[];
  syntaxErrors: DiagnosticItemSnapshot[];
  unresolvedImports: DiagnosticItemSnapshot[];
  timestamp: number;
}

export interface CheckpointRef {
  checkpointId: string;
  workspaceDigest: string;
  mutationSeq: number;
  timestamp: number;
  description: string;
  gitCommitHash?: string;
}

export interface WorkspaceState {
  workspaceRoot: string;
  workspaceDigest: string;
  gitHead?: string;
  dirty: boolean;
  activeMutationSeq: number;
  lastVerifiedMutationSeq: number;
  changedFiles: ChangedFileState[];
  diagnostics: DiagnosticSnapshot;
  fileHashes: Record<string, string>;
  lastGreenCheckpoint?: CheckpointRef;
}

export type CheckKind = 'diagnostic' | 'test' | 'build' | 'typecheck' | 'lint' | 'diff' | 'scenario' | 'invariant';

export interface VerificationCheck {
  id: string;
  name: string;
  kind: CheckKind;
  command?: string;
  targetFiles?: string[];
  required: boolean;
  description: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  satisfied: boolean;
  supportingEvidenceIds: string[];
}

export interface VerificationInvariant {
  id: string;
  name: string;
  description: string;
  enforced: boolean;
}

export interface VerificationContract {
  contractId: string;
  taskGoal: string;
  riskLevel: RiskLevel;
  acceptanceCriteria: AcceptanceCriterion[];
  invariants: VerificationInvariant[];
  requiredChecks: VerificationCheck[];
  regressionScope: {
    checkEntireProject: boolean;
    targetedPaths: string[];
  };
  prohibitedOutcomes: string[];
}

export interface VerificationState {
  contract?: VerificationContract;
  satisfiedCheckIds: string[];
  pendingCheckIds: string[];
  failedCheckIds: string[];
  coverageScore: number; // 0 - 100
  lastVerifiedAt?: number;
}

export type HypothesisStatus =
  | 'FORMULATED'
  | 'TESTING'
  | 'SUPPORTED'
  | 'VALIDATED'
  | 'WEAKENED'
  | 'FALSIFIED'
  | 'ABANDONED';

export interface PredictedObservation {
  description: string;
  expectedOutcome: 'PASS' | 'FAIL' | 'MATCH' | 'SPECIFIC_OUTPUT';
  targetCommandOrTool?: string;
  expectedPattern?: string;
}

export interface FalsificationTest {
  id: string;
  commandOrCheck: string;
  falsifyCondition: string;
}

export interface BlastRadiusEstimate {
  risk: RiskLevel;
  estimatedFiles: string[];
  estimatedSymbols: string[];
  score: number;
}

export interface MutationProposal {
  targetFiles: string[];
  description: string;
  diffSummary?: string;
}

export interface HypothesisNode {
  id: string;
  statement: string;
  parentIds: string[];
  status: HypothesisStatus;
  confidence: number;
  predictedObservations: PredictedObservation[];
  falsificationTests: FalsificationTest[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  targetFiles: string[];
  targetSymbols: string[];
  blastRadius: BlastRadiusEstimate;
  proposedMutation?: MutationProposal;
  estimatedExperimentCost: number;
  rejectionReason?: string;
  learning?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HypothesisState {
  nodes: Record<string, HypothesisNode>;
  activeHypothesisId?: string;
  falsifiedHypothesisIds: string[];
  validatedHypothesisIds: string[];
  hypothesisCounter: number;
}

export type EvidenceType =
  | 'diagnostic'
  | 'test'
  | 'build'
  | 'runtime'
  | 'diff'
  | 'static-analysis'
  | 'symbol-impact'
  | 'user-assertion'
  | 'environment';

export type EvidenceStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'STALE';
export type EvidenceFreshness = 'FRESH' | 'STALE';

export interface EvidenceRecord {
  evidenceId: string;
  type: EvidenceType;
  generatedAt: number;
  workspaceDigest: string;
  mutationSeq: number;
  sourceTool: string;
  command?: string;
  target?: string;
  affectedFiles?: string[];
  status: EvidenceStatus;
  freshness: EvidenceFreshness;
  supports: string[];
  contradicts: string[];
  artifactRefs?: string[];
  summary: string;
  rawDetails?: Record<string, any>;
}

export interface EvidenceState {
  records: Record<string, EvidenceRecord>;
  activeFreshEvidenceIds: string[];
  staleEvidenceIds: string[];
}

export interface ProgressVector {
  informationGain: number; // 0 - 1
  uncertaintyReduction: number; // 0 - 1
  hypothesisReduction: number; // 0 - 1
  goalCompletionDelta: number; // 0 - 1
  verificationCoverageDelta: number; // 0 - 1
  workspaceHealthDelta: number; // 0 - 1
}

export interface ProgressState {
  vector: ProgressVector;
  overallScore: number;
  consecutiveLowProgressSteps: number;
  lastActionFingerprints: string[];
  stagnationDetected: boolean;
  recommendedStrategySwitch?: string;
}

export type ReasoningTier = 0 | 1 | 2 | 3 | 4;
export type ReasoningStrategy =
  | 'DIRECT'
  | 'STRUCTURED'
  | 'HYPOTHESIS_TEST'
  | 'DEEP_CAUSAL'
  | 'SPECULATIVE_SEARCH';

export interface ReasoningPressure {
  taskRisk: number; // 0 - 1
  uncertainty: number; // 0 - 1
  blastRadius: number; // 0 - 1
  failureCount: number;
  stagnationScore: number; // 0 - 1
  hypothesisEntropy: number; // 0 - 1
  verificationFailures: number;
}

export interface ReasoningTransition {
  fromTier: ReasoningTier;
  toTier: ReasoningTier;
  fromStrategy: ReasoningStrategy;
  toStrategy: ReasoningStrategy;
  reason: string;
  timestamp: number;
}

export interface ReasoningState {
  pressure: ReasoningPressure;
  currentTier: ReasoningTier;
  currentStrategy: ReasoningStrategy;
  tokenBudget: number;
  transitions: ReasoningTransition[];
}

export type TransactionStatus = 'OPEN' | 'VERIFYING' | 'COMMITTED' | 'ROLLED_BACK';

export interface MutationTransaction {
  transactionId: string;
  baseCheckpointId: string;
  baseWorkspaceDigest: string;
  status: TransactionStatus;
  affectedFiles: string[];
  affectedSymbols: string[];
  mutationIds: string[];
  expectedEffects: string[];
  openedAt: number;
  closedAt?: number;
}

export interface GreenCheckpoint {
  checkpointId: string;
  workspaceDigest: string;
  mutationSeq: number;
  evidenceIds: string[];
  gitState?: string;
  createdAt: number;
  verifiedInvariants: string[];
  description: string;
}

export interface TransactionState {
  activeTransaction?: MutationTransaction;
  greenCheckpoints: GreenCheckpoint[];
  rejectedCandidates: Array<{
    transactionId: string;
    reason: string;
    rolledBackTo: string;
    timestamp: number;
  }>;
}

export type CriticVerdict =
  | 'ACCEPT_CANDIDATE'
  | 'REJECT_CANDIDATE'
  | 'NEED_MORE_EVIDENCE'
  | 'ROLLBACK'
  | 'REPLAN'
  | 'BLOCK_COMPLETION';

export interface ControlAction {
  type:
    | 'INSPECT'
    | 'DIAGNOSE'
    | 'FORM_HYPOTHESIS'
    | 'RUN_EXPERIMENT'
    | 'OPEN_TRANSACTION'
    | 'MUTATE'
    | 'VERIFY'
    | 'ROLLBACK'
    | 'PROMOTE_GREEN'
    | 'REPLAN'
    | 'ESCALATE_REASONING'
    | 'SPAWN_HYPOTHESIS_BRANCH'
    | 'REQUEST_MORE_EVIDENCE'
    | 'FINALIZE';
  payload?: Record<string, any>;
  reason: string;
}

export interface CriticDecision {
  verdict: CriticVerdict;
  score: number; // 0 - 100
  approved: boolean;
  hardBlockers: string[];
  missingEvidence: string[];
  staleEvidence: string[];
  reasons: string[];
  authorizedNextActions: ControlAction[];
  critiquePrompt?: string;
}

export interface CriticState {
  lastDecision?: CriticDecision;
  evaluationsCount: number;
  approvalHistory: Array<{
    turn: number;
    step: number;
    approved: boolean;
    score: number;
    reasons: string[];
    timestamp: number;
  }>;
}

export interface LifecycleState {
  status: LifecycleStatus;
  previousStatus?: LifecycleStatus;
  turn: number;
  step: number;
  startedAt: number;
  completedAt?: number;
  terminationReason?: string;
}

export interface ControlPlaneState {
  task: TaskState;
  workspace: WorkspaceState;
  verification: VerificationState;
  hypotheses: HypothesisState;
  evidence: EvidenceState;
  progress: ProgressState;
  reasoning: ReasoningState;
  transaction: TransactionState;
  critic: CriticState;
  lifecycle: LifecycleState;
}

export function createInitialControlPlaneState(params: {
  workspaceRoot: string;
  taskId?: string;
  userRequest?: string;
  goal?: string;
  riskLevel?: RiskLevel;
}): ControlPlaneState {
  const now = Date.now();
  const taskId = params.taskId || `task_${now}`;
  const userRequest = params.userRequest || '';
  const goal = params.goal || userRequest;
  const riskLevel = params.riskLevel || 'STANDARD';

  return {
    task: {
      taskId,
      userRequest,
      goal,
      riskLevel,
      constraints: [],
      acceptanceCriteria: [],
      createdAt: now,
    },
    workspace: {
      workspaceRoot: params.workspaceRoot,
      workspaceDigest: 'empty_digest',
      dirty: false,
      activeMutationSeq: 0,
      lastVerifiedMutationSeq: 0,
      changedFiles: [],
      diagnostics: {
        errors: [],
        warnings: [],
        syntaxErrors: [],
        unresolvedImports: [],
        timestamp: now,
      },
      fileHashes: {},
    },
    verification: {
      satisfiedCheckIds: [],
      pendingCheckIds: [],
      failedCheckIds: [],
      coverageScore: 0,
    },
    hypotheses: {
      nodes: {},
      falsifiedHypothesisIds: [],
      validatedHypothesisIds: [],
      hypothesisCounter: 0,
    },
    evidence: {
      records: {},
      activeFreshEvidenceIds: [],
      staleEvidenceIds: [],
    },
    progress: {
      vector: {
        informationGain: 0,
        uncertaintyReduction: 0,
        hypothesisReduction: 0,
        goalCompletionDelta: 0,
        verificationCoverageDelta: 0,
        workspaceHealthDelta: 1,
      },
      overallScore: 0,
      consecutiveLowProgressSteps: 0,
      lastActionFingerprints: [],
      stagnationDetected: false,
    },
    reasoning: {
      pressure: {
        taskRisk: riskLevel === 'CRITICAL' ? 1 : riskLevel === 'HIGH_RISK' ? 0.75 : riskLevel === 'STANDARD' ? 0.4 : 0.1,
        uncertainty: 0.5,
        blastRadius: 0.2,
        failureCount: 0,
        stagnationScore: 0,
        hypothesisEntropy: 0,
        verificationFailures: 0,
      },
      currentTier: riskLevel === 'CRITICAL' || riskLevel === 'HIGH_RISK' ? 2 : 1,
      currentStrategy: riskLevel === 'CRITICAL' || riskLevel === 'HIGH_RISK' ? 'HYPOTHESIS_TEST' : 'STRUCTURED',
      tokenBudget: 8192,
      transitions: [],
    },
    transaction: {
      greenCheckpoints: [],
      rejectedCandidates: [],
    },
    critic: {
      evaluationsCount: 0,
      approvalHistory: [],
    },
    lifecycle: {
      status: 'INTAKE',
      turn: 1,
      step: 1,
      startedAt: now,
    },
  };
}
