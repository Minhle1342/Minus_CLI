import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRegistry } from './agent-registry.js';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { PlanManager } from './plan-manager.js';
import { Session } from '../session/session.js';
import { AgentLoop } from './agent-loop.js';
import { VerificationPolicy } from '../skills/verification-policy.js';
import { SubagentManager } from './subagent-manager.js';
import { CriticGate } from './critic-gate.js';
import { Workspace } from '../workspace/workspace.js';
import { collectCompletionObservations, getTurnCompletionState } from './completion-observations.js';

function dag() {
  const plan = new PlanManager();
  plan.beginTurn(1, 'Implement src/a.ts');
  plan.createPlan([{ title: 'Implement src/a.ts', writeSet: ['src/a.ts'] }]);
  const orchestrator = new AgentOrchestrator(new AgentRegistry());
  orchestrator.bindPlanManager(plan);
  orchestrator.scheduleNextDagBatch = async () => ({ batchNumber: 1,
    dispatchedTasks: [{ task: plan.getTasks()[0], agentId: 'worker', lockedFiles: [], capabilities: [] }],
    skippedOrDeferred: [], remainingPendingCount: 0, hasMoreRunnable: false });
  return { plan, orchestrator };
}

test('DAG rejects a success claim without observed tools', async () => {
  const { orchestrator } = dag();
  const result = await orchestrator.executeFullDag({ maxBatches: 1, taskWorker: async () => ({ success: true, modifiedFiles: ['src/a.ts'], output: 'Done', evidenceStartSeq: 0 }) });
  assert.equal(result.isSuccess, false);
  assert.match(result.taskResults.get(1)?.error || '', /no observed tool evidence/);
});

test('DAG imports paired child mutation observations covering the task scope', async () => {
  const { orchestrator, plan } = dag();
  const child = new Session();
  child.append('tool/call', { toolName: 'write_file', toolCallId: 'edit', args: { path: 'src/a.ts' } });
  child.append('tool/result', { toolName: 'write_file', toolCallId: 'edit', result: { success: true, filesModified: ['src/a.ts'] } });
  const result = await orchestrator.executeFullDag({ maxBatches: 1, taskWorker: async () => ({ success: true, evidenceSession: child, evidenceStartSeq: 0 }) });
  assert.equal(result.isSuccess, true);
  assert.equal(plan.getTasks()[0].evidence[0].toolName, 'write_file');
});

test('rollback records restoration and invalidates previous verification', async () => {
  const session = new Session();
  session.append('turn/start', { turn: 1 });
  const policy = new VerificationPolicy();
  policy.recordModification('src/a.ts');
  policy.recordVerification('npm run build', true, '', 0, { tier: 'build' });
  const invalidated: string[] = [];
  let rolledBackEffects = 0;
  const fake: any = { checkpointManager: { rollbackLast: async () => ({ success: true, message: 'Restored', checkpoint: { id: 'cp' }, restoredFiles: ['src/a.ts'] }) },
    verificationPolicy: policy, targetFilesModifiedInTurn: new Set(), repositoryMap: { invalidate: (file: string) => invalidated.push(file) },
    effectLedger: { bindSession() {}, rollbackByCheckpoint() { rolledBackEffects++; } }, dynamicContextCache: { invalidate() {} },
    planManager: { recordToolEvidence() {} }, rollbackOrchestrator: { resetGreenCheckpoint() {} }, persistSession: async () => {} };
  fake.recordWorkspaceRestoration = (AgentLoop.prototype as any).recordWorkspaceRestoration.bind(fake);
  await AgentLoop.prototype.rollback.call(fake, session);
  const observed = collectCompletionObservations(session, 1);
  assert.equal(observed.at(-1)?.toolName, 'workspace_restore');
  assert.equal(getTurnCompletionState(session, 1).hasMutations, true);
  assert.deepEqual(invalidated, ['src/a.ts']);
  assert.equal(policy.canComplete().allowed, false);
  fake.checkpointManager.rollbackLast = async () => ({ success: false, message: 'Partially restored', checkpoint: { id: 'cp' }, restoredFiles: ['src/b.ts'] });
  await AgentLoop.prototype.rollback.call(fake, session);
  assert.deepEqual(invalidated, ['src/a.ts', 'src/b.ts']);
  assert.equal(rolledBackEffects, 1, 'partial restoration must not mark whole checkpoint effects rolled back');
});

test('async critic emits exactly one final audit', async () => {
  const critic = new CriticGate();
  const session = new Session();
  await critic.evaluateAsync({ session, workspace: new Workspace(process.cwd()), finalAnswer: 'The read-only investigation is complete.',
    userRequest: 'Explain the architecture', completionState: { hasMutations: false, filesModified: [], latestMutationSeq: -1 } });
  assert.equal(critic.auditLedger.getRecords().length, 1);
});

test('default DAG waits for the delegated child and consumes its retained session', async () => {
  const registry = new AgentRegistry();
  const manager = new SubagentManager(registry, ((_id: string, child: Session) => ({ submit: async () => {
    child.append('tool/call', { toolName: 'write_file', toolCallId: 'edit', args: { path: 'src/a.ts' } });
    child.append('tool/result', { toolName: 'write_file', toolCallId: 'edit', result: { success: true, filesModified: ['src/a.ts'] } });
    return 'Done';
  } })) as any);
  manager.bindSession(new Session());
  const handle = manager.start('Implement src/a.ts');
  const plan = new PlanManager();
  plan.beginTurn(1, 'Implement src/a.ts');
  plan.createPlan([{ title: 'Implement src/a.ts', writeSet: ['src/a.ts'] }]);
  const orchestrator = new AgentOrchestrator(registry, manager);
  orchestrator.bindPlanManager(plan);
  orchestrator.scheduleNextDagBatch = async () => ({ batchNumber: 1,
    dispatchedTasks: [{ task: plan.getTasks()[0], agentId: handle.id, lockedFiles: [], capabilities: [] }],
    skippedOrDeferred: [], remainingPendingCount: 0, hasMoreRunnable: false });
  const result = await orchestrator.executeFullDag({ maxBatches: 1 });
  assert.equal(result.isSuccess, true);
  assert.equal(manager.get(handle.id)?.status, 'completed');
});

test('scoped evidence arrays preserve mutation before verification ordering', () => {
  const plan = new PlanManager();
  plan.beginTurn(1, 'Verify src/a.ts');
  plan.createPlan([{ title: 'Verify src/a.ts' }]);
  assert.throws(() => plan.completeTaskWithEvidence(1, [
    { toolName: 'run_command', kind: 'verification', outcome: 'success' },
    { toolName: 'write_file', kind: 'mutation', outcome: 'success', files: ['src/a.ts'] },
  ]), /matching successful/);
  plan.completeTaskWithEvidence(1, [{ toolName: 'run_command', kind: 'verification', outcome: 'success' }]);
  assert.equal(plan.isAllTasksCompleted(), true);
});

test('custom DAG worker must declare its pre-execution evidence fence', async () => {
  const { orchestrator } = dag();
  const result = await orchestrator.executeFullDag({ maxBatches: 1, taskWorker: async () => ({ success: true }) });
  assert.equal(result.isSuccess, false);
  assert.match(result.taskResults.get(1)?.error || '', /pre-execution evidenceStartSeq/);
});

test('DAG cannot reuse already consumed child observations for a later node', async () => {
  const { orchestrator, plan } = dag();
  plan.addTask({ title: 'Implement src/a.ts again', writeSet: ['src/a.ts'], dependsOn: [1] });
  orchestrator.scheduleNextDagBatch = async () => ({ batchNumber: 1,
    dispatchedTasks: [{ task: plan.getNextIncompleteTask()!, agentId: 'worker', lockedFiles: [], capabilities: [] }],
    skippedOrDeferred: [], remainingPendingCount: 0, hasMoreRunnable: false });
  const child = new Session();
  child.append('tool/call', { toolName: 'write_file', toolCallId: 'edit', args: { path: 'src/a.ts' } });
  child.append('tool/result', { toolName: 'write_file', toolCallId: 'edit', result: { success: true, filesModified: ['src/a.ts'] } });
  const result = await orchestrator.executeFullDag({ maxBatches: 2,
    taskWorker: async () => ({ success: true, evidenceSession: child, evidenceStartSeq: 0 }) });
  assert.equal(result.completedTasks, 1);
  assert.equal(result.failedTasks, 1);
});
