import { PlanManager, PlanTask } from '../src/agent/plan-manager.js';
import { AgentOrchestrator } from '../src/agent/agent-orchestrator.js';
import { AgentRegistry } from '../src/agent/agent-registry.js';
import { AgentEventBus } from '../src/agent/agent-event-bus.js';
import { registerBenchmarkSpecialists } from '../src/agent/benchmark-agents.js';
import { createScheduleDagParallelTool } from '../src/tools/subagent-tools.js';
import { Workspace } from '../src/workspace/workspace.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ PASS: ${message}`);
}

async function main() {
  console.log('Testing DAG Parallel Scheduler in isolation...');
  const workspace = new Workspace(process.cwd());

  // 1. Fork & Join Barrier
  const dagPlanMgr = new PlanManager();
  dagPlanMgr.createPlan([
    {
      id: 1,
      title: 'Analyze Architecture & Interfaces',
      acceptanceCriteria: 'Produce architecture topology',
      dependsOn: [],
      writeSet: [],
      parallelizable: true,
      priority: 10,
    },
    {
      id: 2,
      title: 'Synthesize Database Layer',
      acceptanceCriteria: 'Implement repository and db client',
      dependsOn: [1],
      writeSet: ['src/db/repository.ts'],
      parallelizable: true,
      priority: 8,
    },
    {
      id: 3,
      title: 'Synthesize API Router Layer',
      acceptanceCriteria: 'Implement express endpoints',
      dependsOn: [1],
      writeSet: ['src/api/routes.ts'],
      parallelizable: true,
      priority: 7,
    },
    {
      id: 4,
      title: 'Integrate & Verify End-to-End System',
      acceptanceCriteria: 'Run test suite verification',
      dependsOn: [2, 3],
      writeSet: ['src/app.ts'],
      parallelizable: false,
      priority: 9,
    },
  ]);

  const initialBatch = dagPlanMgr.getRunnableParallelBatch({ maxConcurrency: 4 });
  assert(initialBatch.length === 1 && initialBatch[0].id === 1, 'Task #1 là root duy nhất runnable ban đầu');

  dagPlanMgr.startParallelBatch([1]);
  assert(dagPlanMgr.getActiveTasks().length === 1 && dagPlanMgr.getActiveTasks()[0].id === 1, 'Task #1 chuyển sang IN_PROGRESS');

  const completeT1 = dagPlanMgr.completeTaskWithEvidence(1, {
    toolName: 'read_file',
    kind: 'inspection',
    outcome: 'success',
    summary: 'Architecture analyzed',
  });
  assert(
    completeT1.newlyReadyTaskIds.includes(2) && completeT1.newlyReadyTaskIds.includes(3),
    'Hoàn tất Task #1 lập tức mở khóa Task #2 và Task #3',
  );

  const forkBatch = dagPlanMgr.getRunnableParallelBatch({ maxConcurrency: 4 });
  assert(forkBatch.length === 2, 'DAG Parallel Scheduler phát hiện đúng 2 task độc lập chạy song song');
  assert(
    forkBatch.some((t) => t.id === 2) && forkBatch.some((t) => t.id === 3),
    'Batch song song chứa cả Task #2 và Task #3',
  );
  assert(
    dagPlanMgr.canRunConcurrently(forkBatch[0], forkBatch[1]),
    'Hai task có writeSet độc lập được xác nhận canRunConcurrently = true',
  );

  dagPlanMgr.startParallelBatch([2, 3]);
  assert(dagPlanMgr.getActiveTasks().length === 2, 'Cả Task #2 và Task #3 đều đồng thời ở trạng thái IN_PROGRESS');

  const completeT2 = dagPlanMgr.completeTaskWithEvidence(2, {
    toolName: 'write_file',
    kind: 'mutation',
    outcome: 'success',
  });
  assert(
    !completeT2.newlyReadyTaskIds.includes(4),
    'Join Barrier giữ Task #4 ở trạng thái chờ khi Task #3 chưa hoàn tất',
  );
  assert(dagPlanMgr.getReadyTasks().length === 0, 'Chưa có task nào ready cho tới khi tất cả dependency hoàn tất');

  const completeT3 = dagPlanMgr.completeTaskWithEvidence(3, {
    toolName: 'write_file',
    kind: 'mutation',
    outcome: 'success',
  });
  assert(
    completeT3.newlyReadyTaskIds.includes(4),
    'Join Barrier mở khóa Task #4 ngay khi Task #3 hoàn tất',
  );

  dagPlanMgr.startParallelBatch([4]);
  dagPlanMgr.completeTaskWithEvidence(4, {
    toolName: 'run_command',
    kind: 'verification',
    outcome: 'success',
  });
  assert(dagPlanMgr.isAllTasksCompleted(), 'Toàn bộ 4 nodes trong đồ thị DAG đã hoàn tất thành công');

  // 2. Conflict isolation
  const conflictPlanMgr = new PlanManager();
  conflictPlanMgr.createPlan([
    {
      id: 10,
      title: 'Update Shared Config Schema',
      acceptanceCriteria: 'Modify config types',
      dependsOn: [],
      writeSet: ['src/config.ts'],
      parallelizable: true,
      priority: 5,
    },
    {
      id: 11,
      title: 'Inject Secret Flags into Config',
      acceptanceCriteria: 'Modify config values',
      dependsOn: [],
      writeSet: ['src/config.ts'],
      parallelizable: true,
      priority: 2,
    },
  ]);

  const tasksConflict = conflictPlanMgr.getTasks();
  assert(
    !conflictPlanMgr.canRunConcurrently(tasksConflict[0], tasksConflict[1]),
    'Hai task có chung file trong writeSet bị chặn song song hóa (canRunConcurrently = false)',
  );

  const safeConflictBatch = conflictPlanMgr.getRunnableParallelBatch({ maxConcurrency: 4 });
  assert(
    safeConflictBatch.length === 1 && safeConflictBatch[0].id === 10,
    'getRunnableParallelBatch chỉ chọn task có độ ưu tiên cao hơn, ngăn chặn xung đột ghi đè đồng thời',
  );

  // 3. Cascade failure
  const cascadePlanMgr = new PlanManager();
  cascadePlanMgr.createPlan([
    { id: 20, title: 'Compile Core Subsystem', acceptanceCriteria: 'Build core', dependsOn: [] },
    { id: 21, title: 'Build Plugins Module', acceptanceCriteria: 'Build plugins', dependsOn: [20] },
    { id: 22, title: 'Deploy Web Service', acceptanceCriteria: 'Deploy build', dependsOn: [21] },
  ]);

  cascadePlanMgr.startParallelBatch([20]);
  const cascadeRes = cascadePlanMgr.failTaskWithCascade(20, 'TypeScript Syntax Error in core module');
  assert(cascadeRes.failedTaskId === 20, 'Task #20 bị đánh dấu FAILED');
  assert(
    cascadeRes.cascadedTaskIds.includes(21) && cascadeRes.cascadedTaskIds.includes(22),
    'Cascade Failure lan truyền chính xác đến cả Task #21 và Task #22 phụ thuộc',
  );

  // 4. Orchestrator
  const orchRegistry = new AgentRegistry();
  registerBenchmarkSpecialists(orchRegistry);
  const orchEventBus = new AgentEventBus();
  const orchestrator = new AgentOrchestrator(orchRegistry);

  orchestrator.bindPlanManager(conflictPlanMgr);
  orchestrator.bindEventBus(orchEventBus);

  assert(orchestrator.getPlanManager() === conflictPlanMgr, 'AgentOrchestrator bindPlanManager thành công');
  assert(orchestrator.getEventBus() === orchEventBus, 'AgentOrchestrator bindEventBus thành công');

  // 5. scheduleNextDagBatch
  const dispatchPlanMgr = new PlanManager();
  dispatchPlanMgr.createPlan([
    {
      id: 40,
      title: 'Implement Clean Code Synthesis',
      acceptanceCriteria: 'Synthesize module',
      dependsOn: [],
      writeSet: ['src/clean.ts'],
      parallelizable: true,
    },
    {
      id: 41,
      title: 'Verify Instruction Following Schema',
      acceptanceCriteria: 'Check compliance',
      dependsOn: [],
      writeSet: ['src/compliance.ts'],
      parallelizable: true,
    },
  ]);
  orchestrator.bindPlanManager(dispatchPlanMgr);

  const receivedEvents: string[] = [];
  orchEventBus.subscribe('dag:task_dispatched', (event) => {
    receivedEvents.push(`${event.topic}:${event.payload.taskId}:${event.payload.agentId}`);
  });

  const batchResult = await orchestrator.scheduleNextDagBatch({ maxConcurrency: 2 });
  assert(batchResult.dispatchedTasks.length === 2, 'scheduleNextDagBatch dispatch thành công 2 tasks song song');
  assert(receivedEvents.length === 2, 'AgentEventBus nhận đủ 2 sự kiện dag:task_dispatched');

  // 6. executeFullDag
  const fullDagPlanMgr = new PlanManager();
  fullDagPlanMgr.createPlan([
    {
      id: 50,
      title: 'Module Alpha',
      acceptanceCriteria: 'Alpha generated',
      dependsOn: [],
      writeSet: ['src/alpha.ts'],
      parallelizable: true,
    },
    {
      id: 51,
      title: 'Module Beta',
      acceptanceCriteria: 'Beta generated',
      dependsOn: [],
      writeSet: ['src/beta.ts'],
      parallelizable: true,
    },
    {
      id: 52,
      title: 'Merge Alpha & Beta',
      acceptanceCriteria: 'Combined successfully',
      dependsOn: [50, 51],
      writeSet: ['src/gamma.ts'],
      parallelizable: false,
    },
  ]);

  orchestrator.bindPlanManager(fullDagPlanMgr);

  const completedEvents: number[] = [];
  orchEventBus.subscribe('dag:task_completed', (event) => {
    completedEvents.push(event.payload.taskId);
  });

  const dagSummary = await orchestrator.executeFullDag({
    maxConcurrency: 2,
    taskWorker: async (task) => ({
      success: true,
      output: `Task #${task.id} executed successfully.`,
      modifiedFiles: task.writeSet,
    }),
    qualityGate: {
      requireFilesModified: true,
    },
  });

  assert(dagSummary.isSuccess === true, 'executeFullDag thực thi hoàn tất toàn bộ DAG');
  assert(dagSummary.totalTasks === 3, 'Tổng số 3 tasks');
  assert(dagSummary.completedTasks === 3, 'Cả 3 tasks đều COMPLETED');
  assert(dagSummary.batchesExecuted >= 2, 'Thực thi qua ít nhất 2 đợt batches (Fork -> Join)');
  assert(completedEvents.includes(50) && completedEvents.includes(51) && completedEvents.includes(52), 'Nhận đủ sự kiện dag:task_completed cho tất cả các nodes');

  // 7. Tool
  const dagTool = createScheduleDagParallelTool(orchestrator);
  assert(dagTool.name === 'schedule_dag_parallel', 'Tên công cụ đúng schedule_dag_parallel');

  const toolStatusRes = await dagTool.execute({ action: 'status' }, workspace);
  assert(toolStatusRes.success === true, 'schedule_dag_parallel(status) thực thi thành công');

  console.log('\nAll DAG Parallel Scheduler tests passed 100%!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
