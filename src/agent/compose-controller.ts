import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace } from '../workspace/workspace.js';
import { writeFileAtomically } from '../memory/atomic-write.js';
import { WorktreeManager } from '../workspace/worktree-manager.js';
import type { PlanManager } from './plan-manager.js';
import type { CriticGate } from './critic-gate.js';
import { GrillGate } from './grill-gate.js';
import { SpecManager } from './spec-manager.js';
import { classifyGitCommand } from '../tools/git-command-policy.js';
import type {
  ComposeAdvanceResult,
  ComposeGuardDecision,
  ComposeState,
  ComposeTaskMatrixItem,
} from './compose-types.js';

const execFileAsync = promisify(execFile);
const MUTATION_TOOLS = new Set(['create_file', 'write_file', 'replace_text', 'apply_patch', 'delete_file', 'move_file']);
const GIT_MUTATION_TOOLS = new Set(['git_add', 'git_commit', 'git_push', 'create_worktree', 'remove_worktree']);
const READ_ONLY_COMMAND = /^(?:rg|grep|findstr|git\s+(?:status|diff|log|show|branch|rev-parse)|Get-Content|gc|type|dir|ls|Get-ChildItem|gci|pwd)\b/i;

function cloneState(state: ComposeState): ComposeState {
  return JSON.parse(JSON.stringify(state));
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function featureName(objective: string): string {
  return objective.trim().split(/\s+/).slice(0, 7).join(' ').slice(0, 80) || 'Compose feature';
}

function resolvePrimaryWorktree(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolved, encoding: 'utf8', timeout: 5000,
    }).trim();
    return path.basename(commonDir).toLowerCase() === '.git' ? path.resolve(path.dirname(commonDir)) : resolved;
  } catch {
    return resolved;
  }
}

export class ComposeController {
  readonly workspaceRoot: string;
  readonly statePath: string;
  readonly grill: GrillGate;
  readonly specs: SpecManager;
  readonly worktrees: WorktreeManager;
  private state?: ComposeState;

  constructor(workspaceRoot: string, private readonly plan?: PlanManager, private readonly critic?: CriticGate) {
    this.workspaceRoot = resolvePrimaryWorktree(workspaceRoot);
    this.statePath = path.join(this.workspaceRoot, '.codingagent', 'compose', 'state.json');
    this.grill = new GrillGate();
    this.specs = new SpecManager(this.workspaceRoot);
    this.worktrees = new WorktreeManager(this.workspaceRoot);
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as ComposeState;
      if (parsed?.version === 1 && parsed.id && parsed.phase) this.state = parsed;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Cannot load Compose state: ${error.message}`);
    }
  }

  getState(): ComposeState | undefined {
    return this.state ? cloneState(this.state) : undefined;
  }

  isActive(): boolean {
    return Boolean(this.state && !['COMPLETED', 'ABORTED'].includes(this.state.phase));
  }

  async start(objective: string): Promise<ComposeAdvanceResult> {
    if (this.isActive()) throw new Error(`Compose ${this.state!.id} is already active in phase ${this.state!.phase}.`);
    const now = new Date().toISOString();
    const id = randomUUID();
    const name = featureName(objective);
    const mentionedPaths = [...objective.matchAll(/(?:src|test|tests|docs)[/\\][\w./\\-]+/g)].map((match) => match[0].replaceAll('\\', '/'));
    this.state = {
      version: 1,
      id,
      featureName: name,
      objective: objective.trim(),
      phase: 'GRILL',
      specPath: this.specs.getDraftPath(name, id),
      grillQnA: this.grill.createQuestions(objective),
      implementationTasks: [
        'Inspect the registered blast radius and preserve existing contracts.',
        'Implement the locked specification in the isolated worktree.',
        'Run every command in the acceptance matrix after the final mutation.',
        'Audit the final diff and submit evidence for review.',
      ],
      registeredFiles: [...new Set(mentionedPaths.length > 0 ? mentionedPaths : ['src'])],
      testMatrix: [
        { id: 'build', scenario: 'Project compiles without regressions', command: 'npm run build', expectedExitCode: 0, status: 'PENDING' },
        { id: 'tests', scenario: 'Project test suite passes', command: 'npm test', expectedExitCode: 0, status: 'PENDING' },
      ],
      evidenceSeq: 0,
      lastMutationSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.persist();
    return { state: this.getState()!, message: this.nextInstruction() };
  }

  async answerGrill(answer: string): Promise<ComposeState> {
    const state = this.requirePhase('GRILL');
    state.grillQnA = this.grill.answerNext(state.grillQnA, answer);
    await this.persist();
    return this.getState()!;
  }

  async configureDraft(input: { registeredFiles?: string[]; implementationTasks?: string[]; testMatrix?: Array<Partial<ComposeTaskMatrixItem> & Pick<ComposeTaskMatrixItem, 'scenario' | 'command'>> }): Promise<ComposeState> {
    const state = this.requireOneOf(['GRILL', 'SPEC_DRAFT']);
    if (input.registeredFiles) {
      state.registeredFiles = [...new Set(input.registeredFiles.map((item) => item.replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean))];
    }
    if (input.implementationTasks?.length) state.implementationTasks = input.implementationTasks.map((item) => item.trim()).filter(Boolean).slice(0, 7);
    if (input.testMatrix) {
      state.testMatrix = input.testMatrix.map((item, index) => ({
        id: item.id || `acceptance-${index + 1}`,
        scenario: item.scenario.trim(),
        command: item.command.trim(),
        expectedExitCode: item.expectedExitCode ?? 0,
        ...(item.expectedOutput ? { expectedOutput: item.expectedOutput } : {}),
        status: 'PENDING',
      }));
    }
    await this.persist();
    return this.getState()!;
  }

  async generateSpec(workspace: Workspace): Promise<ComposeState> {
    const state = this.requireOneOf(['GRILL', 'SPEC_DRAFT']);
    if (!this.grill.isComplete(state.grillQnA)) throw new Error(this.nextInstruction());
    if (state.testMatrix.length === 0) throw new Error('Acceptance matrix is empty. Register at least one executable test before generating the spec.');
    if (state.registeredFiles.length === 0) throw new Error('Blast radius is empty. Register at least one affected file or directory.');
    const architectureContext = await this.grill.inspectCodebase(state.objective, workspace);
    state.specPath = await this.specs.generate({ ...state, architectureContext });
    state.phase = 'SPEC_DRAFT';
    this.syncPlan(state);
    await this.persist();
    return this.getState()!;
  }

  async lockSpec(): Promise<ComposeState> {
    const state = this.requirePhase('SPEC_DRAFT');
    state.specHash = await this.specs.lock(state.specPath);
    state.phase = 'SPEC_LOCKED';
    await this.persist();
    return this.getState()!;
  }

  async advance(workspace: Workspace, answer?: string): Promise<ComposeAdvanceResult> {
    const state = this.requireActive();
    if (state.phase === 'GRILL') {
      if (answer?.trim()) await this.answerGrill(answer);
      if (!this.grill.isComplete(state.grillQnA)) return { state: this.getState()!, message: this.nextInstruction() };
      await this.generateSpec(workspace);
      return { state: this.getState()!, message: 'Spec draft generated. Review it, then advance to lock it.' };
    }
    if (state.phase === 'SPEC_DRAFT') {
      await this.lockSpec();
      return { state: this.getState()!, message: 'Spec locked by SHA-256. Advance to create the isolated worktree.' };
    }
    if (state.phase === 'SPEC_LOCKED') {
      if (!state.specHash || !(await this.specs.verifyLock(state.specPath, state.specHash))) throw new Error('Locked spec integrity check failed.');
      const safe = state.featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44) || 'feature';
      const created = await this.worktrees.createFeatureWorktree(`${safe}-${state.id.slice(0, 6)}`, `compose/${safe}-${state.id.slice(0, 8)}`);
      const content = await this.specs.read(state.specPath);
      const relativeSpec = this.specs.getWorktreeRelativePath(state.featureName, state.id);
      let specAlreadyMaterialized = false;
      try { specAlreadyMaterialized = (await fs.readFile(path.join(created.worktreePath, relativeSpec), 'utf8')) === content; } catch {}
      const committed = specAlreadyMaterialized
        ? { success: true }
        : await this.worktrees.applyTransaction(created.worktreePath, [{ type: 'create', path: relativeSpec, content }]);
      if (!committed.success) {
        if (!created.reused) await this.worktrees.remove(created.worktreePath, true).catch(() => {});
        throw new Error(('error' in committed && committed.error) || 'Could not materialize the locked spec in the isolated worktree.');
      }
      state.worktreePath = created.worktreePath;
      state.branch = created.branch;
      state.worktreeSpecPath = relativeSpec;
      state.registeredFiles = [...new Set([...state.registeredFiles, relativeSpec])];
      state.phase = 'WORKSPACE_READY';
      await this.persist();
      return { state: this.getState()!, message: 'Isolated worktree ready. Switch workspace, then advance to implementation.', workspaceAction: { type: 'switch', path: created.worktreePath } };
    }
    if (state.phase === 'WORKSPACE_READY') {
      this.assertActiveWorkspace(workspace);
      state.phase = 'IMPLEMENTING';
      await this.persist();
      return { state: this.getState()!, message: 'Implementation phase active. Mutations are now permitted inside the Compose worktree.' };
    }
    if (state.phase === 'IMPLEMENTING') {
      this.assertActiveWorkspace(workspace);
      state.phase = 'VERIFYING';
      await this.persist();
      return { state: this.getState()!, message: 'Verification phase active. Run every exact command in the acceptance matrix.' };
    }
    if (state.phase === 'VERIFYING') {
      const decision = this.acceptanceDecision();
      if (!decision.allow) return { state: this.getState()!, message: decision.reason! };
      state.phase = 'REVIEWING';
      await this.persist();
      return { state: this.getState()!, message: 'Acceptance matrix passed after the last mutation. Advance to audit the diff.' };
    }
    if (state.phase === 'REVIEWING') {
      const audit = await this.auditDiff();
      if (!audit.allow) return { state: this.getState()!, message: audit.reason! };
      state.reviewSummary = audit.reason || 'Diff audit passed.';
      state.phase = 'FINALIZING';
      await this.persist();
      return { state: this.getState()!, message: 'Diff audit passed. Advance once more to fast-forward merge and clean up.' };
    }
    if (state.phase === 'FINALIZING') {
      this.assertActiveWorkspace(workspace);
      if (!state.worktreePath || !state.branch || !state.specHash) throw new Error('Compose finalization metadata is incomplete.');
      const testEvidence = state.testMatrix.map((item) => `${item.id}: ${item.evidenceSummary || item.status}`);
      const planGraph = this.plan?.getTaskGraph();
      const taskGraph = planGraph ? {
        nodes: planGraph.nodes.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          dependsOn: task.dependsOn,
          readSet: task.readSet,
          writeSet: task.writeSet,
          symbols: task.symbols,
          risk: task.risk,
        })),
        criticalPath: planGraph.criticalPath,
        parallelBatches: planGraph.parallelBatches,
      } : undefined;
      await this.worktrees.mergeAndCleanup({ worktreePath: state.worktreePath, branch: state.branch, commitMessage: `compose: ${state.featureName}` });
      state.phase = 'COMPLETED';
      state.completionSummary = `Merged ${state.branch}; ${state.testMatrix.length} acceptance scenario(s) passed.`;
      await this.persist();
      return {
        state: this.getState()!,
        message: state.completionSummary,
        workspaceAction: { type: 'switch', path: this.workspaceRoot },
        completion: {
          composeId: state.id,
          featureName: state.featureName,
          objective: state.objective,
          specHash: state.specHash,
          testEvidence,
          reviewSummary: state.reviewSummary || 'Diff audit passed.',
          ...(taskGraph ? { taskGraph } : {}),
        },
      };
    }
    throw new Error(`Compose cannot advance from ${state.phase}.`);
  }

  async abort(): Promise<ComposeAdvanceResult> {
    const state = this.requireActive();
    if (state.worktreePath) await this.worktrees.discardFeatureWorktree(state.worktreePath, state.branch);
    state.phase = 'ABORTED';
    await this.persist();
    return { state: this.getState()!, message: 'Compose run aborted and its isolated worktree was removed.', workspaceAction: { type: 'switch', path: this.workspaceRoot } };
  }

  async check(toolName: string, args: Record<string, any>, workspace: Workspace): Promise<ComposeGuardDecision> {
    if (!this.isActive()) return { allow: true };
    const state = this.state!;
    if (MUTATION_TOOLS.has(toolName)) {
      if (!state.specHash || ['GRILL', 'SPEC_DRAFT'].includes(state.phase) || !(await this.specs.verifyLock(state.specPath, state.specHash))) return { allow: false, errorCode: 'SPEC_NOT_LOCKED', reason: 'Mutation blocked because the Compose spec is not locked or its integrity seal is invalid.' };
      if (state.phase !== 'IMPLEMENTING') return { allow: false, errorCode: 'COMPOSE_WRONG_PHASE', reason: `Mutation blocked during Compose phase ${state.phase}.` };
      if (!this.isWorktreeWorkspace(workspace)) return { allow: false, errorCode: 'COMPOSE_WORKTREE_REQUIRED', reason: 'Mutation blocked outside the isolated Compose worktree.' };
    }
    if (GIT_MUTATION_TOOLS.has(toolName)) {
      return { allow: false, errorCode: 'COMPOSE_GIT_MANAGED', reason: 'Compose owns staging, commit, merge, and cleanup; direct Git mutation is blocked during an active run.' };
    }
    if (toolName === 'git_command') {
      const subcommand = String(args.subcommand || '').trim().toLowerCase();
      const classification = classifyGitCommand(subcommand, Array.isArray(args.args) ? args.args.map(String) : []);
      if (classification.risk !== 'read') return { allow: false, errorCode: 'COMPOSE_GIT_MANAGED', reason: `Direct git ${subcommand || '(missing)'} (${classification.risk}) is blocked while Compose owns the branch lifecycle.` };
      if (state.worktreePath && !this.isWorktreeWorkspace(workspace)) return { allow: false, errorCode: 'COMPOSE_WORKTREE_REQUIRED', reason: 'Git inspection for an active Compose run must target its isolated worktree.' };
    }
    if (toolName === 'run_command') {
      const command = String(args.command || '');
      if (state.worktreePath && !this.isWorktreeWorkspace(workspace)) return { allow: false, errorCode: 'COMPOSE_WORKTREE_REQUIRED', reason: 'Commands for an active Compose run must execute inside its isolated worktree.' };
      if (!state.worktreePath && !READ_ONLY_COMMAND.test(command.trim())) return { allow: false, errorCode: 'COMPOSE_READ_ONLY_PHASE', reason: 'Only read-only inspection commands are allowed before the Compose worktree exists.' };
    }
    if (toolName === 'submit_solution') {
      const acceptance = this.acceptanceDecision();
      if (!acceptance.allow) return acceptance;
      return this.auditDiff();
    }
    return { allow: true };
  }

  async observeToolResult(toolName: string, args: Record<string, any>, result: Record<string, any>): Promise<void> {
    if (!this.isActive()) return;
    if (toolName !== 'run_command' && (result.error || result.errorCode || result.success === false)) return;
    const state = this.state!;
    state.evidenceSeq++;
    if (MUTATION_TOOLS.has(toolName)) {
      state.lastMutationSeq = state.evidenceSeq;
      for (const item of state.testMatrix) {
        item.status = 'PENDING';
        delete item.evidenceSeq;
        delete item.evidenceSummary;
        delete item.verifiedAt;
      }
    }
    if (toolName === 'run_command') {
      const command = normalizeCommand(String(args.command || ''));
      const item = state.testMatrix.find((candidate) => normalizeCommand(candidate.command) === command);
      if (item) {
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        const exitCode = Number(result.exitCode ?? (result.success === false ? 1 : 0));
        const passed = exitCode === item.expectedExitCode && (!item.expectedOutput || output.includes(item.expectedOutput));
        item.status = passed ? 'PASSED' : 'FAILED';
        item.evidenceSeq = state.evidenceSeq;
        item.evidenceSummary = `exitCode=${exitCode}${item.expectedOutput ? `, expectedOutput=${passed ? 'matched' : 'missing'}` : ''}`;
        item.verifiedAt = new Date().toISOString();
      }
    }
    await this.persist();
  }

  acceptanceDecision(): ComposeGuardDecision {
    const state = this.state;
    if (!state) return { allow: true };
    const decision = this.critic?.evaluateComposeAcceptance({ matrix: state.testMatrix, lastMutationSeq: state.lastMutationSeq, changedFiles: [], registeredFiles: state.registeredFiles });
    const stale = state.testMatrix.filter((item) => item.status !== 'PASSED' || (item.evidenceSeq || 0) <= state.lastMutationSeq);
    if (state.testMatrix.length === 0 || stale.length > 0 || decision?.reasons.some((reason) => reason.includes('acceptance'))) {
      return { allow: false, errorCode: 'COMPOSE_ACCEPTANCE_PENDING', reason: decision?.reasons.join(' ') || `Compose acceptance pending: ${stale.length || 'all'} matrix item(s) have not passed after the last mutation.` };
    }
    return { allow: true };
  }

  async auditDiff(): Promise<ComposeGuardDecision> {
    const state = this.state;
    if (!state?.worktreePath) return { allow: false, errorCode: 'COMPOSE_WORKTREE_REQUIRED', reason: 'No isolated worktree exists for diff audit.' };
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: state.worktreePath, timeout: 30000 });
      const changed = stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim().split(' -> ').at(-1)!.replaceAll('\\', '/'));
      const criticDecision = this.critic?.evaluateComposeAcceptance({ matrix: state.testMatrix, lastMutationSeq: state.lastMutationSeq, changedFiles: changed, registeredFiles: state.registeredFiles });
      if (criticDecision && !criticDecision.approved) return { allow: false, errorCode: 'COMPOSE_CRITIC_REJECTED', reason: criticDecision.reasons.join(' ') };
      const unregistered = changed.filter((file) => !state.registeredFiles.some((registered) => file === registered || file.startsWith(`${registered.replace(/\/$/, '')}/`)));
      if (unregistered.length > 0) return { allow: false, errorCode: 'COMPOSE_UNREGISTERED_DIFF', reason: `Diff audit rejected unregistered paths: ${unregistered.join(', ')}` };
      return { allow: true, reason: `Diff audit passed for ${changed.length} changed path(s).` };
    } catch (error: any) {
      return { allow: false, errorCode: 'COMPOSE_DIFF_AUDIT_FAILED', reason: `Diff audit failed: ${error.message}` };
    }
  }

  renderExecutionContext(): string {
    if (!this.isActive()) return '';
    const state = this.state!;
    const matrix = state.testMatrix.map((item) => `${item.id} [${item.status}] ${item.command}`).join('\n') || '(empty)';
    return `[COMPOSE CONTRACT - AUTHORITATIVE]\nID: ${state.id}\nPhase: ${state.phase}\nObjective: ${state.objective}\nLocked spec: ${state.specHash ? `${state.specPath} (${state.specHash.slice(0, 12)})` : 'not locked'}\nWorktree: ${state.worktreePath || 'not created'}\nRegistered blast radius: ${state.registeredFiles.join(', ') || '(empty)'}\nAcceptance matrix:\n${matrix}\nNEXT: ${this.nextInstruction()}`;
  }

  private nextInstruction(): string {
    const state = this.state;
    if (!state) return 'Start with /compose <objective>.';
    if (state.phase === 'GRILL') return this.grill.nextQuestion(state.grillQnA)?.question || 'Configure blast radius and acceptance matrix, then generate the spec.';
    const actions: Record<string, string> = {
      SPEC_DRAFT: 'Review and lock the generated spec.', SPEC_LOCKED: 'Create the isolated worktree.', WORKSPACE_READY: 'Switch to the worktree and enter implementation.',
      IMPLEMENTING: 'Implement only the locked spec, then advance to verification.', VERIFYING: 'Run every exact acceptance command.', REVIEWING: 'Audit all changed paths against the spec.',
      FINALIZING: 'Fast-forward merge and clean up.', COMPLETED: 'Compose completed.', ABORTED: 'Compose aborted.',
    };
    return actions[state.phase] || state.phase;
  }

  private syncPlan(state: ComposeState): void {
    if (!this.plan) return;
    try {
      this.plan.createPlan(state.implementationTasks.slice(0, 20).map((title, index) => ({
        id: index + 1,
        title,
        acceptanceCriteria: `Satisfy locked Compose spec ${state.id}.`,
        dependsOn: index === 0 ? [] : [index],
        readSet: state.registeredFiles,
        writeSet: /implement|mutation|modify|write|fix|refactor/i.test(title) ? state.registeredFiles : [],
        risk: /implement|mutation|modify|write|fix|refactor/i.test(title) ? 'HIGH' : 'MEDIUM',
        estimatedCost: /implement|mutation|modify|write|fix|refactor/i.test(title) ? 3 : 1,
        parallelizable: false,
      })));
    } catch {}
  }

  private assertActiveWorkspace(workspace: Workspace): void {
    if (!this.isWorktreeWorkspace(workspace)) throw new Error('Active workspace is not the isolated Compose worktree.');
  }

  private isWorktreeWorkspace(workspace: Workspace): boolean {
    return Boolean(this.state?.worktreePath && path.resolve(workspace.rootDir) === path.resolve(this.state.worktreePath));
  }

  private requireActive(): ComposeState {
    if (!this.state || ['COMPLETED', 'ABORTED'].includes(this.state.phase)) throw new Error('No active Compose run.');
    return this.state;
  }

  private requirePhase(phase: ComposeState['phase']): ComposeState {
    const state = this.requireActive();
    if (state.phase !== phase) throw new Error(`Compose phase must be ${phase}; current phase is ${state.phase}.`);
    return state;
  }

  private requireOneOf(phases: ComposeState['phase'][]): ComposeState {
    const state = this.requireActive();
    if (!phases.includes(state.phase)) throw new Error(`Compose phase must be one of ${phases.join(', ')}; current phase is ${state.phase}.`);
    return state;
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    this.state.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFileAtomically(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
