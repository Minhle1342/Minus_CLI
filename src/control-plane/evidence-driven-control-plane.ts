import type { Workspace } from '../workspace/workspace.js';
import type { CheckpointManager } from '../workspace/checkpoint.js';
import type { SpeculativeBranchManager } from '../agent/speculative-branch-manager.js';
import {
  type ControlPlaneState,
  type RiskLevel,
  type LifecycleStatus,
  type ControlAction,
  type CriticDecision,
  type EvidenceRecord,
  type HypothesisNode,
  createInitialControlPlaneState,
} from './control-plane-state.js';
import { reduceControlPlaneState, type ControlPlaneEvent } from './control-plane-events.js';
import { WorkspaceStateManager } from './workspace/workspace-state-manager.js';
import { EvidenceLedger } from './evidence/evidence-ledger.js';
import { EvidenceRecordBuilder, type CreateEvidenceParams } from './evidence/evidence-record.js';
import { VerificationContractFactory } from './verification/verification-contract.js';
import { HypothesisGraph, type FormulateHypothesisOptions } from './hypothesis/hypothesis-graph.js';
import { FalsificationEngine } from './hypothesis/falsification-engine.js';
import { ParallelHypothesisController } from './hypothesis/parallel-hypothesis-controller.js';
import { MutationTransactionManager } from './transaction/mutation-transaction.js';
import { GreenCheckpointManager } from './transaction/green-checkpoint-manager.js';
import { ControlPlaneRollbackEngine, type RollbackResult } from './transaction/rollback-engine.js';
import { SpeculativeBranchController } from './transaction/speculative-branch-controller.js';
import { ProgressController } from './progress/progress-controller.js';
import { AdaptiveComputeController } from './reasoning/adaptive-compute-controller.js';
import { CriticEngine } from './critic/critic-engine.js';
import { ControlPlaneStateMachine } from './control-plane-state-machine.js';
import { CompletionReportGenerator, type VerifiedCompletionReport } from './completion-report.js';

export interface EvidenceDrivenControlPlaneOptions {
  workspace: Workspace;
  checkpointManager?: CheckpointManager;
  speculativeManager?: SpeculativeBranchManager;
  taskId?: string;
  userRequest?: string;
  goal?: string;
  riskLevel?: RiskLevel;
}

/**
 * EvidenceDrivenControlPlane (EDCP)
 * 
 * Central governor for autonomous, verified software engineering:
 * "Generation may be probabilistic. Acceptance must be deterministic."
 */
export class EvidenceDrivenControlPlane {
  private state: ControlPlaneState;
  private readonly events: ControlPlaneEvent[] = [];

  readonly workspaceManager: WorkspaceStateManager;
  readonly evidenceLedger = new EvidenceLedger();
  readonly hypothesisGraph = new HypothesisGraph();
  readonly transactionManager = new MutationTransactionManager();
  readonly greenManager = new GreenCheckpointManager();
  readonly rollbackEngine: ControlPlaneRollbackEngine;
  readonly parallelHypotheses = new ParallelHypothesisController();
  readonly progressController = new ProgressController();
  readonly adaptiveCompute = new AdaptiveComputeController();
  readonly speculativeController: SpeculativeBranchController;

  constructor(options: EvidenceDrivenControlPlaneOptions) {
    this.workspaceManager = new WorkspaceStateManager(options.workspace);
    this.rollbackEngine = new ControlPlaneRollbackEngine(
      this.greenManager,
      options.checkpointManager,
    );
    this.speculativeController = new SpeculativeBranchController(options.speculativeManager);

    this.state = createInitialControlPlaneState({
      workspaceRoot: options.workspace.rootDir,
      taskId: options.taskId,
      userRequest: options.userRequest,
      goal: options.goal,
      riskLevel: options.riskLevel,
    });
  }

  getState(): ControlPlaneState {
    // Synchronize latest state slices before returning
    const ws = this.workspaceManager.getState();
    const freshEvidence = this.evidenceLedger.getFresh(ws);
    const evState = this.evidenceLedger.getState(ws);
    const hypState = this.hypothesisGraph.getState();
    const progState = this.progressController.getState();
    const reasState = this.adaptiveCompute.getState();

    return {
      ...this.state,
      workspace: {
        ...ws,
        lastGreenCheckpoint: this.state.workspace.lastGreenCheckpoint,
      },
      evidence: evState,
      hypotheses: hypState,
      progress: progState,
      reasoning: reasState,
    };
  }

  getEvents(): ControlPlaneEvent[] {
    return [...this.events];
  }

  dispatch(event: ControlPlaneEvent): void {
    this.events.push(event);
    this.state = reduceControlPlaneState(this.state, event);
  }

  /**
   * Initializes baseline snapshot and derives the initial VerificationContract.
   */
  async captureBaseline(description = 'Baseline initial state'): Promise<void> {
    await this.workspaceManager.refreshDiagnostics();
    const ws = this.workspaceManager.getState();

    const g0 = this.greenManager.recordGreenCheckpoint({
      workspaceDigest: ws.workspaceDigest,
      mutationSeq: 0,
      evidenceIds: [],
      description,
    });

    this.dispatch({
      type: 'BaselineCaptured',
      payload: {
        workspaceDigest: ws.workspaceDigest,
        fileHashes: ws.fileHashes,
        checkpoint: g0,
      },
    });

    // Derive verification contract
    const contract = VerificationContractFactory.createContract({
      taskId: this.state.task.taskId,
      taskGoal: this.state.task.goal,
      userRequest: this.state.task.userRequest,
      riskLevel: this.state.task.riskLevel,
    });

    this.dispatch({
      type: 'VerificationContractSet',
      payload: { contract },
    });
  }

  /**
   * Dynamically adapts the active verification contract risk tier based on task classification.
   */
  setTaskRiskLevel(riskLevel: RiskLevel): void {
    if (this.state.task.riskLevel === riskLevel && this.state.verification.contract) {
      return;
    }
    this.state.task.riskLevel = riskLevel;
    const ws = this.workspaceManager.getState();
    const contract = VerificationContractFactory.createContract({
      taskId: this.state.task.taskId,
      taskGoal: this.state.task.goal,
      userRequest: this.state.task.userRequest,
      riskLevel,
      changedFiles: ws.changedFiles.map((f) => f.path),
    });

    this.dispatch({
      type: 'VerificationContractSet',
      payload: { contract },
    });
  }

  /**
   * Records a workspace mutation and invalidates affected prior evidence.
   */
  recordMutation(params: {
    filePath: string;
    content?: string | Buffer;
    affectedSymbols?: string[];
    isRegistered?: boolean;
  }): { mutationSeq: number; invalidatedEvidenceIds: string[] } {
    const { mutationSeq, changedFile, workspaceDigest } = this.workspaceManager.recordMutation(params);

    this.dispatch({
      type: 'WorkspaceMutated',
      payload: {
        files: [changedFile],
        mutationSeq,
        dirty: true,
        workspaceDigest,
      },
    });

    // Invalidate affected evidence
    const inv = this.evidenceLedger.invalidateOnMutation({
      currentMutationSeq: mutationSeq,
      currentWorkspaceDigest: workspaceDigest,
      recentMutations: [changedFile],
    });

    if (inv.invalidatedIds.length > 0) {
      this.dispatch({
        type: 'EvidenceInvalidated',
        payload: {
          evidenceIds: inv.invalidatedIds,
          reason: `Invalidated by mutation seq #${mutationSeq} on ${changedFile.path}`,
        },
      });
    }

    if (this.transactionManager.getActiveTransaction()) {
      this.transactionManager.recordMutation(`mut_${mutationSeq}`, changedFile.path);
    }

    return {
      mutationSeq,
      invalidatedEvidenceIds: inv.invalidatedIds,
    };
  }

  /**
   * Records verification or tool observation evidence.
   */
  recordEvidence(params: CreateEvidenceParams): EvidenceRecord {
    const ws = this.workspaceManager.getState();
    const activeHyp = this.hypothesisGraph.getActiveHypothesis();

    const record = EvidenceRecordBuilder.create({
      ...params,
      workspaceDigest: ws.workspaceDigest,
      mutationSeq: ws.activeMutationSeq,
    });

    this.evidenceLedger.record(record, activeHyp?.id);

    this.dispatch({
      type: 'EvidenceRecorded',
      payload: { record },
    });

    // If there is an active hypothesis, evaluate falsification
    if (activeHyp) {
      const falsification = FalsificationEngine.evaluate({
        hypothesis: activeHyp,
        freshEvidence: [record],
      });

      if (falsification.outcome === 'VALIDATED') {
        this.hypothesisGraph.markValidated(activeHyp.id, falsification.reason);
        this.dispatch({
          type: 'HypothesisStatusUpdated',
          payload: {
            hypothesisId: activeHyp.id,
            status: 'VALIDATED',
            learning: falsification.reason,
          },
        });
      } else if (falsification.outcome === 'FALSIFIED') {
        this.hypothesisGraph.markFalsified(activeHyp.id, falsification.reason);
        this.dispatch({
          type: 'HypothesisStatusUpdated',
          payload: {
            hypothesisId: activeHyp.id,
            status: 'FALSIFIED',
            reason: falsification.reason,
          },
        });
      }
    }

    return record;
  }

  /**
   * Formulates a new hypothesis, checking to prevent repeating recently falsified ones.
   */
  formulateHypothesis(options: FormulateHypothesisOptions): {
    allowed: boolean;
    hypothesis?: HypothesisNode;
    rejectionReason?: string;
  } {
    const repetition = this.hypothesisGraph.isRepeatedFalsified(options.statement);
    if (repetition.isRepeated && repetition.matchingHypothesis) {
      return {
        allowed: false,
        rejectionReason: `Proposed hypothesis is semantically identical to falsified hypothesis [${repetition.matchingHypothesis.id}] ("${repetition.matchingHypothesis.statement}"). Must propose a distinct mechanism.`,
      };
    }

    const node = this.hypothesisGraph.formulate(options);
    this.dispatch({
      type: 'HypothesisFormulated',
      payload: { hypothesis: node },
    });

    return { allowed: true, hypothesis: node };
  }

  /**
   * Opens a speculative candidate transaction.
   */
  openTransaction(expectedEffects: string[] = []): void {
    const ws = this.workspaceManager.getState();
    const lastGreen = this.greenManager.getLastGreen();

    const tx = this.transactionManager.openTransaction({
      baseCheckpointId: lastGreen?.checkpointId || 'G0',
      baseWorkspaceDigest: ws.workspaceDigest,
      expectedEffects,
    });

    this.dispatch({
      type: 'TransactionOpened',
      payload: { transaction: tx },
    });
  }

  /**
   * Promotes verified candidate state to a new green checkpoint baseline.
   */
  promoteCandidate(description: string): void {
    const ws = this.workspaceManager.getState();
    const fresh = this.evidenceLedger.getFresh(ws);

    const cp = this.greenManager.recordGreenCheckpoint({
      workspaceDigest: ws.workspaceDigest,
      mutationSeq: ws.activeMutationSeq,
      evidenceIds: fresh.map((e) => e.evidenceId),
      description,
    });

    const committedTx = this.transactionManager.commit();

    this.dispatch({
      type: 'TransactionCommitted',
      payload: {
        transactionId: committedTx?.transactionId || 'direct',
        checkpoint: cp,
      },
    });
  }

  /**
   * Rolls back candidate mutations to the last green checkpoint.
   */
  async rollbackCandidate(reason: string): Promise<RollbackResult> {
    const lastGreen = this.greenManager.getLastGreen();
    const outcome = await this.rollbackEngine.rollbackToGreen(lastGreen?.checkpointId, reason);

    const rolledBackTx = this.transactionManager.rollback();

    this.dispatch({
      type: 'TransactionRolledBack',
      payload: {
        transactionId: rolledBackTx?.transactionId || 'direct',
        rolledBackTo: outcome.restoredCheckpointId || 'baseline',
        reason,
      },
    });

    await this.workspaceManager.refreshDiagnostics();

    return outcome;
  }

  /**
   * Deterministic Critic evaluation over current workspace, contracts, and evidence.
   */
  evaluateCritic(params: {
    isCompletionRequest?: boolean;
    hasSubmittedSolution?: boolean;
    registeredFiles?: string[];
    finalAnswerText?: string;
  } = {}): CriticDecision {
    const ws = this.workspaceManager.getState();
    const freshEvidence = this.evidenceLedger.getFresh(ws);
    const allEvidence = this.evidenceLedger.getAll();
    const activeHypothesis = this.hypothesisGraph.getActiveHypothesis();

    const decision = CriticEngine.evaluate({
      contract: this.state.verification.contract,
      workspace: ws,
      transaction: this.transactionManager.getActiveTransaction(),
      freshEvidence,
      allEvidence,
      activeHypothesis,
      isCompletionRequest: params.isCompletionRequest,
      hasSubmittedSolution: params.hasSubmittedSolution,
      registeredFiles: params.registeredFiles,
      finalAnswerText: params.finalAnswerText,
    });

    this.dispatch({
      type: 'CriticEvaluated',
      payload: {
        decision,
        turn: this.state.lifecycle.turn,
        step: this.state.lifecycle.step,
      },
    });

    return decision;
  }

  /**
   * Authorizes completion if Critic approves and returns VerifiedCompletionReport.
   */
  authorizeCompletion(params: {
    hasSubmittedSolution?: boolean;
    finalAnswerText?: string;
    registeredFiles?: string[];
  } | boolean = false): {
    authorized: boolean;
    decision: CriticDecision;
    report?: VerifiedCompletionReport;
  } {
    const options = typeof params === 'boolean'
      ? { hasSubmittedSolution: params }
      : (params || {});

    const decision = this.evaluateCritic({
      isCompletionRequest: true,
      hasSubmittedSolution: options.hasSubmittedSolution,
      finalAnswerText: options.finalAnswerText,
      registeredFiles: options.registeredFiles,
    });

    if (!decision.approved) {
      return { authorized: false, decision };
    }

    this.dispatch({
      type: 'TaskCompleted',
      payload: { terminationReason: 'Contract fulfilled and verified by Critic.' },
    });

    const ws = this.workspaceManager.getState();
    const fresh = this.evidenceLedger.getFresh(ws);
    const report = CompletionReportGenerator.generate(this.getState(), fresh);

    return {
      authorized: true,
      decision,
      report,
    };
  }

  isTerminal(): boolean {
    const st = this.state.lifecycle.status;
    return st === 'COMPLETED' || st === 'BLOCKED' || st === 'FAILED';
  }
}
